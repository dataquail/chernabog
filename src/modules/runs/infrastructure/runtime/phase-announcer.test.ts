import { type Json, Phase, PhaseWriter, RunLog } from "@chernabog/core";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { effect } from "../../../../../test/effect-test.ts";
import { makeThreadsFake } from "../../../../../test/github-threads-fake.ts";
import { progressContract } from "../../../../../test/progress-contract.ts";
import { githubTestLayer } from "../../../../platform/github-api.ts";
import { announcing, PHASE_EVENT } from "./phase-announcer.ts";
import { makeRepoProgress, makeThreadsProgress } from "./progress.ts";

const SLUG = "acme/app";
const DISPATCHES = `/repos/${SLUG}/dispatches`;

const phase = Schema.decodeSync(Phase);
const writer = Schema.decodeSync(PhaseWriter);

const ASKED = phase("review-asked");
const CHANGES = phase("changes-asked");
const RUN_A = writer("0eee9982-bb65-4a62-b603-25023ad948cb");
const RUN_B = writer("data-quail");

// GitHub's JSON null: the first phase's `from`, and a dispatch's empty answer.
const NULL = Schema.encodeSync(Schema.OptionFromNullOr(Schema.Json))(Option.none());

// The threads fake, answering dispatches too: each one sent, and how GitHub
// answers the next ones (204, or a status that refuses them, or none at all).
const makeFake = () => {
  const threads = makeThreadsFake(SLUG);
  const sent: Array<Json> = [];
  const dispatch = { status: Option.some(204) };

  const handler = (method: string, path: string, body: Option.Option<Json>) => {
    if (method === "POST" && path === DISPATCHES) {
      sent.push(Option.getOrElse(body, () => NULL));

      return Option.map(dispatch.status, (status) => ({ status, body: NULL }));
    }

    return threads.handler(method, path, body);
  };

  return { threads, sent, dispatch, handler };
};

const announcingOver = (fake: ReturnType<typeof makeFake>) =>
  Effect.gen(function* () {
    const adapter = yield* makeThreadsProgress({ slug: SLUG, persona: Option.some("data-quail") });

    return yield* announcing(adapter, SLUG);
  }).pipe(Effect.provide(githubTestLayer(fake.handler)));

// The adapter a repo gets, announcing or not.
const repoProgressOver = (fake: ReturnType<typeof makeFake>, announce: boolean) =>
  makeRepoProgress({ slug: SLUG, persona: Option.some("data-quail"), announce }).pipe(
    Effect.provide(githubTestLayer(fake.handler)),
  );

// A run's log, keeping its lines.
const makeLog = () => {
  const lines: Array<string> = [];

  const log = RunLog.of({
    log: (line) => Effect.sync(() => void lines.push(line)),
    step: () => Effect.void,
    stepDone: () => Effect.void,
    stepFinished: () => Effect.void,
  });

  return { lines, log };
};

progressContract(
  "protected branches, announced",
  Effect.suspend(() => announcingOver(makeFake())),
);

describe("an announced advance", () => {
  effect("sends one chernabog-phase dispatch, with the item and its move", () =>
    Effect.gen(function* () {
      const fake = makeFake();
      const progress = yield* announcingOver(fake);

      yield* progress.advance("pr-73", { from: Option.none(), to: ASKED, by: RUN_A });

      expect(fake.sent).toEqual([
        {
          event_type: PHASE_EVENT,
          client_payload: { item: "pr-73", from: NULL, to: "review-asked" },
        },
      ]);

      yield* progress.advance("pr-73", { from: Option.some(ASKED), to: CHANGES, by: RUN_B });

      expect(fake.sent).toHaveLength(2);
      expect(fake.sent[1]).toEqual({
        event_type: PHASE_EVENT,
        client_payload: { item: "pr-73", from: "review-asked", to: "changes-asked" },
      });
    }),
  );

  effect("a lost race sends nothing", () =>
    Effect.gen(function* () {
      const fake = makeFake();
      const progress = yield* announcingOver(fake);

      yield* progress.advance("pr-73", { from: Option.none(), to: ASKED, by: RUN_A });
      fake.sent.length = 0;

      const exit = yield* Effect.exit(
        progress.advance("pr-73", { from: Option.none(), to: CHANGES, by: RUN_B }),
      );

      expect(Option.map(Exit.findErrorOption(exit), (error) => error._tag)).toEqual(
        Option.some("PhaseMoved"),
      );
      expect(fake.sent).toEqual([]);
    }),
  );

  effect("a retry that finds its own write announces it again", () =>
    Effect.gen(function* () {
      const fake = makeFake();
      const progress = yield* announcingOver(fake);
      const move = { from: Option.none<Phase>(), to: ASKED, by: RUN_A };

      const first = yield* progress.advance("pr-73", move);
      const again = yield* progress.advance("pr-73", move);

      expect(again).toEqual(first);
      expect(fake.sent).toHaveLength(2);
    }),
  );

  effect("a failed announcement leaves the advance recorded, and says so in the run log", () =>
    Effect.gen(function* () {
      const fake = makeFake();
      const progress = yield* announcingOver(fake);
      const { lines, log } = makeLog();

      fake.dispatch.status = Option.some(403);

      const refused = yield* progress
        .advance("pr-73", { from: Option.none(), to: ASKED, by: RUN_A })
        .pipe(Effect.provideService(RunLog, log));

      // GitHub can't be reached at all.
      fake.dispatch.status = Option.none();

      const unreached = yield* progress
        .advance("pr-73", { from: Option.some(ASKED), to: CHANGES, by: RUN_B })
        .pipe(Effect.provideService(RunLog, log));

      expect([refused.phase, unreached.phase]).toEqual([ASKED, CHANGES]);
      expect(Option.map(yield* progress.read("pr-73"), (record) => record.phase)).toEqual(
        Option.some(CHANGES),
      );
      expect(fake.sent).toHaveLength(2);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("pr-73");
      expect(lines[0]).toContain("review-asked");
      expect(lines[0]).toContain("403");
      expect(lines[1]).toContain("changes-asked");
    }),
  );

  effect("a failed announcement outside a run fails nothing", () =>
    Effect.gen(function* () {
      const fake = makeFake();
      const progress = yield* announcingOver(fake);

      fake.dispatch.status = Option.some(500);

      const record = yield* progress.advance("pr-73", {
        from: Option.none(),
        to: ASKED,
        by: RUN_A,
      });

      expect(record.phase).toEqual(ASKED);
    }),
  );

  effect("a repo that turns announcements off sends none", () =>
    Effect.gen(function* () {
      const fake = makeFake();

      const progress = yield* repoProgressOver(fake, false);

      yield* progress.advance("pr-73", { from: Option.none(), to: ASKED, by: RUN_A });

      expect(fake.sent).toEqual([]);
    }),
  );

  effect("a repo announces by default", () =>
    Effect.gen(function* () {
      const fake = makeFake();

      const progress = yield* repoProgressOver(fake, true);

      yield* progress.advance("pr-73", { from: Option.none(), to: ASKED, by: RUN_A });

      expect(fake.sent).toHaveLength(1);
    }),
  );
});
