// The SDK's shared settings: each block reads its own keys from the flow's
// settings, and falls back, key by key, to config.yaml's old keys, which the
// binary still gives every flow as Repo's.

import { Repo, type RepoSettings, Settings } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import YAML from "yaml";

import { effect } from "./effect-test.ts";
import { settings } from "./sdk-fakes.ts";

const reading = <A, E>(
  read: Effect.Effect<A, E, Repo>,
  input: Settings.FlowSettings["Service"]["input"],
  repo: RepoSettings = settings,
) =>
  read.pipe(
    Effect.provideService(Repo, repo),
    Effect.provideService(Settings.FlowSettings, { input }),
  );

describe("the SDK's shared settings", () => {
  effect("a flow's settings win over config.yaml's old keys, which fill what they leave out", () =>
    Effect.gen(function* () {
      const old = {
        ...settings,
        localGate: ["bun test"],
        limits: { ...settings.limits, ciRounds: 4, localGateRounds: 3 },
      };

      expect(yield* reading(Settings.ci, { ciTimeout: "30 minutes" }, old)).toEqual({
        rounds: 4,
        timeout: Duration.minutes(30),
      });
      expect(yield* reading(Settings.localGate, { localGate: ["bun run check"] }, old)).toEqual({
        commands: ["bun run check"],
        rounds: 3,
        install: Option.none(),
      });
      expect(yield* reading(Settings.reviewers, { reviewers: ["alice"], reviewRounds: 2 })).toEqual(
        { pool: ["alice"], rounds: 2 },
      );
      expect(yield* reading(Settings.reviewers, {})).toEqual({
        pool: [],
        rounds: settings.limits.reviewRounds,
      });
    }),
  );

  effect("a flow renames one label and keeps the rest, and declares the set by its names", () =>
    Effect.gen(function* () {
      const names = yield* reading(Settings.labels, { labels: { eligible: "agent:queued" } });
      expect(names.eligible).toBe("agent:queued");
      expect(names.ship).toBe("auto:ship");

      const declared = yield* reading(Settings.declaredLabels, {
        labels: { eligible: "agent:queued" },
      });

      expect(declared.map((label) => label.name)).toContain("agent:queued");
      expect(declared.map((label) => label.name)).not.toContain("auto:eligible");
    }),
  );

  effect("null turns install and the board off, over the repo's", () =>
    Effect.gen(function* () {
      const old = {
        ...settings,
        install: Option.some("bun install"),
        board: Option.some({ projectNumber: 1, readyStatus: "Ready", inProgressStatus: "Doing" }),
      };

      // As config.yaml writes it: `install: null`.
      const off = yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))(
        YAML.parse("install: null\nboard: null"),
      );

      expect((yield* reading(Settings.localGate, off, old)).install).toEqual(Option.none());
      expect(yield* reading(Settings.board, off, old)).toEqual(Option.none());
      expect(yield* reading(Settings.board, {}, old)).toEqual(old.board);
    }),
  );

  effect("humanOnly adds to the repo's and the machine's, never replacing them", () =>
    Effect.gen(function* () {
      const old = { ...settings, humanOnly: ["the machine's rule"] };

      expect(
        (yield* reading(Settings.rules, { humanOnly: ["a release"], notes: ["bun"] }, old))
          .humanOnly,
      ).toEqual(["the machine's rule", "a release"]);
    }),
  );

  effect("a recipe's own setting sits beside the SDK's, read typed", () =>
    Effect.gen(function* () {
      const Own = Schema.Struct({
        ...Settings.Ci.fields,
        releaseBranches: Schema.Array(Schema.String),
      });

      const own = yield* reading(Settings.read(Own), {
        releaseBranches: ["release/1"],
        ciRounds: 2,
      });

      expect(own).toEqual({ releaseBranches: ["release/1"], ciRounds: 2 });
    }),
  );

  effect("outside a run, a block reads config.yaml's old keys alone", () =>
    Effect.gen(function* () {
      expect(yield* Settings.stackDepth.pipe(Effect.provideService(Repo, settings))).toBe(
        settings.limits.stackDepth,
      );
    }),
  );
});
