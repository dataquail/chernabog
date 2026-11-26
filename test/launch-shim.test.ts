// `chernabog __launch` honours the sandbox its spec names, or refuses: it
// never runs a sandboxed repo's agent on the host (ADR 24, decision 2).

import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  LaunchSpecJson,
  runLaunch,
} from "../src/modules/runs/infrastructure/runtime/launchers/shim.ts";
import { effect } from "./effect-test.ts";

const launched = (sandbox: Option.Option<"none" | "docker" | "podman">) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-launch-" });
    const marker = `${dir}/ran`;
    const spec = `${dir}/spec.json`;

    yield* fs.writeFileString(
      spec,
      yield* Schema.encodeEffect(LaunchSpecJson)({
        command: "/usr/bin/touch",
        args: [marker],
        cwd: dir,
        env: {},
        ...Option.match(sandbox, { onNone: () => ({}), onSome: (name) => ({ sandbox: name }) }),
      }),
    );

    const code = yield* runLaunch(spec);

    return { code, ran: yield* fs.exists(marker) };
  });

describe("__launch", () => {
  effect("runs the agent on the host when the sandbox is none, or unset", () =>
    Effect.gen(function* () {
      expect(yield* launched(Option.some("none"))).toEqual({ code: 0, ran: true });
      expect(yield* launched(Option.none())).toEqual({ code: 0, ran: true });
    }),
  );

  effect("refuses a docker or podman sandbox it can't start yet, running nothing", () =>
    Effect.gen(function* () {
      expect(yield* launched(Option.some("docker"))).toEqual({ code: 1, ran: false });
      expect(yield* launched(Option.some("podman"))).toEqual({ code: 1, ran: false });
    }),
  );
});
