// The runs module's routes on the daemon's socket that the dashboard's page of
// a run reads: the run by a prefix of its id, and its log as it grows.

import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { applicationModules } from "../src/interface/application-modules.ts";
import { Refusal, RunReply } from "../src/interface/daemon/daemon.protocol.ts";
import { RunId } from "../src/kernel/run-id.id.ts";
import { RunLogsClientFake } from "../src/modules/runs/infrastructure/clients/run-logs.client-fake.ts";
import { runsRoutes } from "../src/modules/runs/interface/daemon/runs.endpoint-groups.ts";
import { RunsCommands } from "../src/modules/runs/runs.command-handlers.ts";
import { EngineAt } from "../src/modules/runs/runs.platform.ts";
import {
  type RunLogsQueries,
  RunLogsQueriesLive,
  type RunsQueries,
} from "../src/modules/runs/runs.query-handlers.ts";
import { Home, homePaths } from "../src/platform/home.ts";
import { effect } from "./effect-test.ts";
import { TestEventBus } from "./events.ts";

const RUN = "5714245a-211c-4f0d-8ce1-74b725bac0d6";
const OTHER = "5714ffff-0000-4000-8000-000000000000";

// The run logs the routes read, in memory: the engine writing to one is a
// test adding to it.
const logs: Record<string, string> = {};

// The modules a daemon adds, over a runtime with no flows and a state.db in a
// scratch home, and the run logs above.
const daemonInScratch = Layer.unwrap(
  FileSystem.FileSystem.use((fs) =>
    fs.makeTempDirectoryScoped({ prefix: "chernabog-runs-routes-" }),
  ).pipe(
    Effect.map((home) =>
      Layer.mergeAll(
        applicationModules.engine.pipe(
          Layer.provide(applicationModules.runtime({ handles: [], services: () => Option.none() })),
          Layer.provideMerge(TestEventBus),
          Layer.provide(EngineAt(homePaths(home).state)),
          Layer.provide(Home.at(home, home)),
        ),
        RunLogsQueriesLive.pipe(Layer.provide(RunLogsClientFake(logs))),
      ),
    ),
  ),
);

const start = (id: string) =>
  RunsCommands.use((runs) =>
    runs.StartRunCommand({
      id: RunId.make(id),
      coreVersion: "0.7.0",
      repo: "demo",
      persona: Option.some("bob"),
      flow: "implement",
      itemKey: `issue-${id.slice(0, 4)}`,
      itemTitle: Option.none(),
      itemUrl: Option.none(),
      item: Option.none(),
    }),
  );

const finish = (id: string) =>
  RunsCommands.use((runs) =>
    runs.FinishRunCommand({ runId: RunId.make(id), status: "done", summary: "opened #12" }),
  );

// The runs module's routes as a web handler, failures answered as the server
// answers them.
const serving = Effect.gen(function* () {
  const context = yield* Effect.context<RunsQueries | RunLogsQueries>();

  const answer = <E, R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    handler.pipe(
      Effect.catch((error) =>
        HttpServerResponse.schemaJson(Refusal)({ error: String(error) }, { status: 500 }).pipe(
          Effect.orDie,
        ),
      ),
    );

  const web = HttpRouter.toWebHandler(runsRoutes(answer), { disableLogger: true });
  yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()));

  return (path: string) =>
    Effect.promise(() => web.handler(new Request(`http://daemon${path}`), context));
});

const decodeRun = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.toCodecJson(RunReply)));
const decodeRefusal = Schema.decodeUnknownSync(Schema.fromJsonString(Refusal));

const readText = (response: Response) => Effect.promise(() => response.text());

// An event stream's frames, each as it was sent, into a queue, then `closed`
// once the stream ends.
const framesOf = (response: Response) =>
  Effect.gen(function* () {
    const frames = yield* Queue.unbounded<string>();
    const body = yield* Effect.fromOption(Option.fromNullOr(response.body)).pipe(Effect.orDie);
    let lines: Array<string> = [];

    yield* Effect.forkScoped(
      Stream.fromReadableStream({ evaluate: () => body, onError: (error) => error }).pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.runForEach((line) => {
          if (line !== "") {
            lines.push(line);

            return Effect.void;
          }

          const frame = lines;
          lines = [];

          return Queue.offer(frames, `${frame.join("\n")}\n\n`);
        }),
        Effect.andThen(Queue.offer(frames, "closed")),
        Effect.orDie,
      ),
    );

    return frames;
  });

describe("GET /runs/:id/log", () => {
  effect("streams what the log holds, then what it gains, and ends once the run has", () =>
    Effect.gen(function* () {
      logs[RUN] = "started\n";
      yield* start(RUN);
      const get = yield* serving;

      const response = yield* get(`/runs/${RUN}/log`);
      expect(response.headers.get("content-type")).toContain("text/event-stream");

      const frames = yield* framesOf(response);
      expect(yield* Queue.take(frames)).toBe("data: started\n\n");

      logs[RUN] = `${logs[RUN]}step: implement\nwrote\r\nthe fix\n`;
      expect(yield* Queue.take(frames)).toBe(
        "data: step: implement\ndata: wrote\ndata: the fix\n\n",
      );

      yield* finish(RUN);
      expect(yield* Queue.take(frames)).toBe("event: end\ndata: \n\n");
      expect(yield* Queue.take(frames)).toBe("closed");
    }).pipe(Effect.provide(daemonInScratch)),
  );

  effect("ends at once for a run the daemon has none of", () =>
    Effect.gen(function* () {
      const get = yield* serving;

      expect(yield* get("/runs/nobody/log").pipe(Effect.flatMap(readText))).toBe(
        "event: end\ndata: \n\n",
      );
    }).pipe(Effect.provide(daemonInScratch)),
  );
});

describe("GET /runs/:id", () => {
  effect("answers a run named by a unique prefix of its id", () =>
    Effect.gen(function* () {
      logs[RUN] = "started\n";
      logs[OTHER] = "started\n";
      yield* start(RUN);
      const get = yield* serving;

      const found = decodeRun(
        yield* get(`/runs/${RUN.slice(0, 6)}`).pipe(Effect.flatMap(readText)),
      );

      expect(Option.map(found, (run) => run.id)).toEqual(Option.some(RunId.make(RUN)));

      const ambiguous = yield* get(`/runs/${RUN.slice(0, 4)}`);
      expect(ambiguous.status).toBe(409);
      expect(decodeRefusal(yield* readText(ambiguous)).error).toContain("give more of the id");

      expect(decodeRun(yield* get("/runs/nobody").pipe(Effect.flatMap(readText)))).toEqual(
        Option.none(),
      );
    }).pipe(Effect.provide(daemonInScratch)),
  );
});
