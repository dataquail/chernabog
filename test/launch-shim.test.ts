// `chernabog __launch` honours the sandbox its spec names, or refuses: it
// never runs a sandboxed repo's agent on the host (ADR 24, decision 2). In a
// Docker or Podman sandbox it runs the agent in a container, in the
// foreground (a hangup removing it is test/acceptance/launch-hangup.test.ts).

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  containerRunArgs,
  type ContainerSpec,
} from "../src/modules/runs/infrastructure/runtime/launchers/container.ts";
import {
  LaunchSpecJson,
  runLaunch,
} from "../src/modules/runs/infrastructure/runtime/launchers/shim.ts";
import { HostEnvironment } from "../src/platform/environment.ts";
import { Exec } from "../src/platform/exec.ts";
import { effect } from "./effect-test.ts";

const launched = (
  sandbox: Option.Option<"none" | "docker" | "podman">,
  container: Option.Option<ContainerSpec> = Option.none(),
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-launch-" });
    // The fake runtime, which runs the command on the host, and bun for its shebang.
    const fakebin = yield* path.fromFileUrl(new URL("fakebin", import.meta.url));
    const marker = `${dir}/ran`;
    const spec = `${dir}/spec.json`;

    yield* fs.writeFileString(
      spec,
      yield* Schema.encodeEffect(LaunchSpecJson)({
        command: "/usr/bin/touch",
        args: [marker],
        cwd: dir,
        // The fake runtime, found on this PATH, runs the command on the host.
        env: {
          PATH: `${fakebin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
          FAKE_RUNTIME_LOG: `${dir}/runtime.log`,
          FAKE_RUNTIME_STATE: `${dir}/runtime`,
        },
        ...Option.match(sandbox, { onNone: () => ({}), onSome: (name) => ({ sandbox: name }) }),
        ...Option.match(container, {
          onNone: () => ({}),
          onSome: (given) => ({ container: given }),
        }),
      }),
    );

    const code = yield* runLaunch(spec);

    const runtime = yield* fs
      .readFileString(`${dir}/runtime.log`)
      .pipe(Effect.orElseSucceed(() => ""));

    return { code, ran: yield* fs.exists(marker), runtime };
  }).pipe(Effect.provide(Layer.merge(Exec.layer, HostEnvironment.layer)));

const CONTAINER: ContainerSpec = {
  image: "sandbox:test",
  mounts: [{ path: "/work/tree" }, { path: "/work/repo/.git" }],
  labels: { "chernabog.run": "run-1", "chernabog.session": "session-1" },
};

describe("__launch", () => {
  effect("runs the agent on the host when the sandbox is none, or unset", () =>
    Effect.gen(function* () {
      expect(yield* launched(Option.some("none"))).toMatchObject({
        code: 0,
        ran: true,
        runtime: "",
      });
      expect(yield* launched(Option.none())).toMatchObject({ code: 0, ran: true, runtime: "" });
    }),
  );

  effect("refuses a docker or podman sandbox whose spec names no container, running nothing", () =>
    Effect.gen(function* () {
      expect(yield* launched(Option.some("docker"))).toEqual({ code: 1, ran: false, runtime: "" });
      expect(yield* launched(Option.some("podman"))).toEqual({ code: 1, ran: false, runtime: "" });
    }),
  );

  effect("runs the agent through the sandbox's runtime, in the foreground", () =>
    Effect.gen(function* () {
      for (const runtime of ["docker", "podman"] as const) {
        const result = yield* launched(Option.some(runtime), Option.some(CONTAINER));

        expect(result.code).toBe(0);
        expect(result.ran).toBe(true);
        expect(result.runtime).toStartWith(`${runtime} run `);
        expect(result.runtime).toContain('"--rm","--init"');
        expect(result.runtime).toContain('"sandbox:test","/usr/bin/touch"');
      }
    }),
  );
});

describe("a container's run arguments", () => {
  const agent = {
    command: "claude",
    args: ["--session-id", "session-1", "the prompt"],
    cwd: "/work/tree",
    env: { CHERNABOG_SESSION_TOKEN: "secret-token", GH_TOKEN: "gh-secret" },
  };

  const mac = { platform: "darwin", uid: Option.some(501), gid: Option.some(20), tty: true };
  const linux = { ...mac, platform: "linux", uid: Option.some(1000), gid: Option.some(1000) };

  test("run in the foreground on the terminal, labelled, with every mount at its host path", () => {
    expect(
      containerRunArgs(
        "podman",
        agent,
        {
          ...CONTAINER,
          mounts: [...CONTAINER.mounts, { path: "/work/repo/.git/config", readOnly: true }],
        },
        mac,
      ),
    ).toEqual([
      "run",
      "-it",
      "--rm",
      "--init",
      "--label",
      "chernabog.run=run-1",
      "--label",
      "chernabog.session=session-1",
      "--volume",
      "/work/tree:/work/tree",
      "--volume",
      "/work/repo/.git:/work/repo/.git",
      "--volume",
      "/work/repo/.git/config:/work/repo/.git/config:ro",
      "--workdir",
      "/work/tree",
      "--env",
      "CHERNABOG_SESSION_TOKEN",
      "--env",
      "GH_TOKEN",
      "--userns=keep-id",
      "sandbox:test",
      "claude",
      "--session-id",
      "session-1",
      "the prompt",
    ]);
  });

  test("pass each variable by name, so no value is on the command line", () => {
    const args = containerRunArgs("docker", agent, CONTAINER, linux);

    expect(args.join(" ")).not.toContain("secret-token");
    expect(args.join(" ")).not.toContain("gh-secret");
  });

  test("map the person's user: keep-id for rootless Podman, their uid and gid for Docker", () => {
    expect(containerRunArgs("podman", agent, CONTAINER, linux)).toContain("--userns=keep-id");
    expect(containerRunArgs("docker", agent, CONTAINER, linux).join(" ")).toContain(
      "--user 1000:1000",
    );

    // As root there is no one to map.
    const root = { ...linux, uid: Option.some(0), gid: Option.some(0) };
    expect(containerRunArgs("podman", agent, CONTAINER, root)).not.toContain("--userns=keep-id");
    expect(containerRunArgs("docker", agent, CONTAINER, root)).not.toContain("--user");
  });

  test("make the hub reachable from Docker on Linux, whose host gateway is named only when asked", () => {
    expect(containerRunArgs("docker", agent, CONTAINER, linux)).toContain(
      "--add-host=host.docker.internal:host-gateway",
    );
    expect(containerRunArgs("docker", agent, CONTAINER, mac).join(" ")).not.toContain("--add-host");
    expect(containerRunArgs("podman", agent, CONTAINER, linux).join(" ")).not.toContain(
      "--add-host",
    );
  });

  test("ask for a TTY only when the terminal is one", () => {
    expect(
      containerRunArgs("docker", agent, CONTAINER, { ...mac, tty: false }).slice(0, 2),
    ).toEqual(["run", "-i"]);
  });
});
