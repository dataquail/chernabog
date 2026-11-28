import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { effect } from "../../../../../test/effect-test.ts";
import { type ExecResult, execTestLayer } from "../../../../platform/exec.ts";
import { buildInputsHash, imageTag, type SandboxBuild, sandboxImage } from "./sandbox-image.ts";

const PERSON = { uid: Option.some(501), gid: Option.some(20) };

// A runtime that holds the images it built, and fails every build while `broken`.
const runtime = { broken: false };
const images = new Set<string>();
const runtimeCalls: Array<ReadonlyArray<string>> = [];

const answer = (args: ReadonlyArray<string>): ExecResult => {
  if (args[0] === "image") {
    return { exitCode: Number(!images.has(args[2] ?? "")), stdout: "", stderr: "" };
  }

  if (runtime.broken) {
    return {
      exitCode: 1,
      stdout: "#5 [2/2] RUN false\n",
      stderr: 'ERROR: process "/bin/sh -c false" did not complete successfully: exit code: 1\n',
    };
  }

  images.add(args[args.indexOf("--tag") + 1] ?? "");

  return { exitCode: 0, stdout: "built\n", stderr: "" };
};

const FakeRuntime = execTestLayer((command, args) => {
  runtimeCalls.push([command, ...args]);

  return Option.some(answer(args));
});

// Each test's runtime starts with no images.
const withRuntime = <A, E, R>(test: Effect.Effect<A, E, R>) =>
  Effect.sync(() => {
    images.clear();
    runtimeCalls.length = 0;
    runtime.broken = false;
  }).pipe(Effect.andThen(test), Effect.provide(FakeRuntime));

const setUp = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-sandbox-image-" });
  const logged: Array<string> = [];

  const writeDockerfile = (text: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(`${configDir}/sandbox`, { recursive: true });
      yield* fs.writeFileString(`${configDir}/sandbox/Dockerfile`, text);
    });

  const image = (sandbox: "docker" | "podman") =>
    sandboxImage({
      sandbox: { name: sandbox, from: "repo config" },
      configDir,
      slug: "Acme/Widgets",
      user: PERSON,
      log: (line) => Effect.sync(() => logged.push(line)),
    } satisfies SandboxBuild);

  return { configDir, image, logged, writeDockerfile };
});

const builds = (calls: ReadonlyArray<ReadonlyArray<string>>) =>
  calls.filter((call) => call[1] === "build");

describe.each(["docker", "podman"] as const)("the repo's image on %s", (sandbox) => {
  effect("a first session builds it, as the person, and a second reuses it", () =>
    withRuntime(
      Effect.gen(function* () {
        const { configDir, image, writeDockerfile } = yield* setUp;
        yield* writeDockerfile("FROM debian:bookworm-slim\n");

        const first = yield* image(sandbox);
        const second = yield* image(sandbox);

        expect(second).toBe(first);
        expect(first).toStartWith("chernabog-sandbox/acme-widgets:");

        const [build = [], ...more] = builds(runtimeCalls);

        expect(more).toEqual([]);
        expect(build[0]).toBe(sandbox);
        expect(build).toContain("AGENT_UID=501");
        expect(build).toContain("AGENT_GID=20");
        expect(build.slice(-3)).toEqual([
          "--file",
          `${configDir}/sandbox/Dockerfile`,
          `${configDir}/sandbox`,
        ]);
      }),
    ),
  );

  effect("an edited Dockerfile builds a new image", () =>
    withRuntime(
      Effect.gen(function* () {
        const { image, writeDockerfile } = yield* setUp;
        yield* writeDockerfile("FROM debian:bookworm-slim\n");
        const before = yield* image(sandbox);

        yield* writeDockerfile("FROM debian:bookworm-slim\nRUN apt-get update\n");
        const after = yield* image(sandbox);

        expect(after).not.toBe(before);
        expect(builds(runtimeCalls)).toHaveLength(2);
        expect(images).toEqual(new Set([before, after]));
      }),
    ),
  );

  effect("a build that fails refuses the session with its error, and logs it", () =>
    withRuntime(
      Effect.gen(function* () {
        const { image, logged, writeDockerfile } = yield* setUp;
        yield* writeDockerfile("FROM debian:bookworm-slim\nRUN false\n");
        runtime.broken = true;

        const error = yield* Effect.flip(image(sandbox));

        expect(error.message).toContain(`sandbox ${sandbox} (from repo config)`);
        expect(error.message).toContain(`\`${sandbox} build\``);
        expect(error.message).toContain('process "/bin/sh -c false" did not complete');
        expect(logged.join("\n")).toContain('process "/bin/sh -c false" did not complete');
      }),
    ),
  );

  effect("a repo with no Dockerfile refuses, pointing at sandbox init", () =>
    withRuntime(
      Effect.gen(function* () {
        const { image } = yield* setUp;

        const error = yield* Effect.flip(image(sandbox));

        expect(error.message).toContain("chernabog sandbox init");
        expect(runtimeCalls).toEqual([]);
      }),
    ),
  );
});

describe("what decides the image", () => {
  effect("any file of the build context, and the person's ids", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-sandbox-inputs-" });
      yield* fs.writeFileString(`${dir}/Dockerfile`, "FROM debian\n");
      const first = yield* buildInputsHash(dir, PERSON);

      expect(yield* buildInputsHash(dir, PERSON)).toBe(first);
      expect(
        yield* buildInputsHash(dir, { uid: Option.some(1000), gid: Option.some(1000) }),
      ).not.toBe(first);

      yield* fs.makeDirectory(`${dir}/files`);
      yield* fs.writeFileString(`${dir}/files/setup.sh`, "echo hi\n");

      expect(yield* buildInputsHash(dir, PERSON)).not.toBe(first);
    }),
  );

  effect("names one image per repo, whatever case its slug is in", () =>
    Effect.sync(() => {
      expect(imageTag("Acme/Widgets", "0123456789abcdef0123")).toBe(
        "chernabog-sandbox/acme-widgets:0123456789abcdef",
      );
    }),
  );
});
