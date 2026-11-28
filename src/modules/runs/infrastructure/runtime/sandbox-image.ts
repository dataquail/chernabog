// The image a sandboxed repo's sessions run in (ADR 24, "The container"):
// built from `.chernabog/sandbox/` in the tree the hub trusted, never from a
// worktree, with the person's uid and gid as its build arguments. It is
// tagged for the repo and for a hash of what goes into the build, so an
// unchanged directory reuses the image and a changed one builds a new one.
// A build that fails refuses the session, with the build's own words, and a
// repo with a sandbox but no Dockerfile refuses too (decision 2).

import { createHash } from "node:crypto";

import { AgentError, type ResolvedSandbox } from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Order from "effect/Order";

import { Exec } from "../../../../platform/exec.ts";

// Where a repo keeps its image's build context, under its .chernabog/.
export const SANDBOX_DIR = "sandbox";

// The user the image's sessions run as, given to the build by the template's names.
export type BuildUser = {
  readonly uid: Option.Option<number>;
  readonly gid: Option.Option<number>;
};

export type SandboxBuild = {
  readonly sandbox: ResolvedSandbox;
  // The trusted snapshot's .chernabog/.
  readonly configDir: string;
  // owner/name.
  readonly slug: string;
  readonly user: BuildUser;
  readonly log: (line: string) => Effect.Effect<void>;
};

// A build can take a while: a toolchain download, a cold base image.
const BUILD_TIMEOUT = "30 minutes";
const INSPECT_TIMEOUT = "30 seconds";

// How much of a failed build's output the refusal quotes, and the run log keeps.
const QUOTED_LINES = 20;
const LOGGED_LINES = 200;

// The person's ids, as the template's AGENT_UID and AGENT_GID. As root, none:
// the template's own defaults stand, as the container maps no user then.
export const buildArgs = (user: BuildUser): ReadonlyArray<string> =>
  Option.match(Option.all([user.uid, user.gid]).pipe(Option.filter(([uid]) => uid !== 0)), {
    onNone: () => [],
    onSome: ([uid, gid]) => ["--build-arg", `AGENT_UID=${uid}`, "--build-arg", `AGENT_GID=${gid}`],
  });

// The image's name for a repo: one a runtime accepts (lowercase, no slash
// inside a component), the same for every machine's clone of it.
export const imageName = (slug: string) =>
  `chernabog-sandbox/${slug
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")}`;

export const imageTag = (slug: string, hash: string) => `${imageName(slug)}:${hash.slice(0, 16)}`;

// A hash of every file in the build context, by its path and contents, and of
// the build arguments: what decides the image a build makes.
export const buildInputsHash = (dir: string, user: BuildUser) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const hash = createHash("sha256");
    const entries = Arr.sort(yield* fs.readDirectory(dir, { recursive: true }), Order.String);

    for (const entry of entries) {
      const path = `${dir}/${entry}`;

      if ((yield* fs.stat(path)).type !== "File") {
        continue;
      }

      hash.update(`${entry}\0`);
      hash.update(yield* fs.readFile(path));
      hash.update("\0");
    }

    hash.update(buildArgs(user).join(" "));

    return hash.digest("hex");
  });

const lastLines = (text: string, count: number) => text.trimEnd().split("\n").slice(-count);

const refused = (sandbox: ResolvedSandbox, message: string) =>
  new AgentError({ message: `sandbox ${sandbox.name} (from ${sandbox.from}): ${message}` });

// The tag of the repo's image, built first when the runtime hasn't got it.
export const sandboxImage = (build: SandboxBuild) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exec = yield* Exec;
    const runtime = build.sandbox.name;
    const dir = `${build.configDir}/${SANDBOX_DIR}`;
    const dockerfile = `${dir}/Dockerfile`;

    if (!(yield* fs.exists(dockerfile))) {
      return yield* refused(
        build.sandbox,
        `the repo has no .chernabog/${SANDBOX_DIR}/Dockerfile on its default branch to build the session's image from: run \`chernabog sandbox init\`, then commit and merge what it writes`,
      );
    }

    const tag = imageTag(build.slug, yield* buildInputsHash(dir, build.user));

    const inspected = yield* exec.run(runtime, ["image", "inspect", tag], {
      timeout: INSPECT_TIMEOUT,
    });

    if (inspected.exitCode === 0) {
      yield* build.log(`sandbox ${runtime}: image ${tag} is built already`);

      return tag;
    }

    yield* build.log(`sandbox ${runtime}: building image ${tag} from .chernabog/${SANDBOX_DIR}/`);

    const built = yield* exec.run(
      runtime,
      ["build", "--tag", tag, ...buildArgs(build.user), "--file", dockerfile, dir],
      { timeout: BUILD_TIMEOUT },
    );

    const output = [built.stdout.trimEnd(), built.stderr.trimEnd()]
      .filter((text) => text.length > 0)
      .join("\n");

    if (built.exitCode !== 0) {
      for (const line of lastLines(output, LOGGED_LINES)) {
        yield* build.log(`sandbox ${runtime} build: ${line}`);
      }

      return yield* refused(
        build.sandbox,
        `\`${runtime} build\` of .chernabog/${SANDBOX_DIR}/Dockerfile failed (exit ${built.exitCode}), so the session can't start:\n${lastLines(output, QUOTED_LINES).join("\n")}`,
      );
    }

    yield* build.log(`sandbox ${runtime}: built image ${tag}`);

    return tag;
  }).pipe(
    Effect.catchTags({
      PlatformError: (error) => Effect.fail(refused(build.sandbox, error.message)),
      ExecError: (error) =>
        Effect.fail(
          refused(
            build.sandbox,
            `${error.command} failed, so the session can't start: ${error.message}`,
          ),
        ),
    }),
  );
