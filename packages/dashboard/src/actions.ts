// What a person does to runs from the page: start a flow's run now, cancel a
// run in flight, open a run's session in its launcher. Each is a POST to the
// daemon that served the page, with the body the CLI sends; the daemon's
// Refusal, when it refuses, is what the page shows beside the button. Nothing
// is retried: a person reads why, and asks again if they want to.

import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { AttachOpened, CancelRequest, Refusal, RunRequest, TickResult } from "#daemon/protocol";

export type Action =
  | {
      readonly kind: "run";
      readonly repo: string;
      readonly flow: string;
      readonly item: Option.Option<string>;
      readonly persona: Option.Option<string>;
    }
  | { readonly kind: "cancel"; readonly runId: string; readonly closeSessions: boolean }
  | { readonly kind: "attach"; readonly runId: string };

// How an action came out: what the daemon did, or why it wouldn't.
export type Outcome =
  | { readonly kind: "done"; readonly message: string }
  | { readonly kind: "refused"; readonly message: string };

// The path an action posts to, under the page's origin, and its JSON body.
export type ActionRequest = { readonly path: string; readonly body: unknown };

const encodeRun = Schema.encodeSync(Schema.toCodecJson(RunRequest));
const encodeCancel = Schema.encodeSync(Schema.toCodecJson(CancelRequest));

// Who the daemon logs a cancel from the page as.
const BY = "dashboard";

export const requestFor = (action: Action): ActionRequest => {
  switch (action.kind) {
    case "run":
      return {
        path: "/api/run",
        body: encodeRun({
          repo: action.repo,
          flow: action.flow,
          item: action.item,
          ...Option.match(action.persona, {
            onNone: () => ({}),
            onSome: (persona) => ({ persona }),
          }),
        }),
      };
    case "cancel":
      return {
        path: "/api/cancel",
        body: encodeCancel({
          target: CancelRequest.fields.target.cases.ById.make({ asked: action.runId }),
          by: BY,
          closeSessions: action.closeSessions,
        }),
      };
    case "attach":
      return { path: `/api/runs/${encodeURIComponent(action.runId)}/attach`, body: {} };
  }
};

const done = (message: string): Outcome => ({ kind: "done", message });

const refused = (message: string): Outcome => ({ kind: "refused", message });

const short = (runId: string) => runId.slice(0, 8);

const tickOf = HttpClientResponse.schemaBodyJson(TickResult);
const openedOf = HttpClientResponse.schemaBodyJson(AttachOpened);
const refusalOf = HttpClientResponse.schemaBodyJson(Refusal);

// What the daemon did, from its answer to the action.
const doneFrom = (action: Action, response: HttpClientResponse.HttpClientResponse) => {
  switch (action.kind) {
    case "run":
      return Effect.map(tickOf(response), (tick) =>
        Option.match(
          Option.liftPredicate(tick.started, (started) => started.length > 0),
          {
            onSome: (started) => done(`started ${started.map(short).join(", ")}`),
            onNone: () =>
              done(
                Option.match(tick.skipped, {
                  onNone: () => "started nothing",
                  onSome: (why) => `started nothing: ${why}`,
                }),
              ),
          },
        ),
      );
    case "cancel":
      return Effect.succeed(done("cancelled"));
    case "attach":
      return Effect.map(openedOf(response), (opened) => done(`opened in ${opened.launcher}`));
  }
};

const outcomeOf = (action: Action, response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    if (response.status >= 200 && response.status < 300) {
      return yield* doneFrom(action, response);
    }

    return refused((yield* refusalOf(response)).error);
  }).pipe(Effect.orElseSucceed(() => refused(`the daemon answered ${response.status}`)));

// Posts an action to the daemon at `origin`, once; never fails: a refusal is an outcome.
export const perform = (
  origin: string,
  action: Action,
): Effect.Effect<Outcome, never, HttpClient.HttpClient> => {
  const { body, path } = requestFor(action);

  return HttpClientRequest.post(new URL(path, origin)).pipe(
    HttpClientRequest.bodyJson(body),
    Effect.flatMap(HttpClient.execute),
    Effect.flatMap((response) => outcomeOf(action, response)),
    Effect.catch((error) => Effect.succeed(refused(`couldn't reach the daemon: ${error.message}`))),
  );
};

// What a person pastes into a terminal to attach to a run's session: the
// CLI's attach, which finds the session's environment on their machine (the
// account it ran as, its token) rather than sending it to a browser.
export const attachLine = (runId: string) => `chernabog attach ${runId}`;
