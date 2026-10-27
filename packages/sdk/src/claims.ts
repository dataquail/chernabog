// Claims on work items, each a ref of its own, apart from the work branch:
// `refs/chernabog/claims/<item>` (`issue-12`, `pr-73`), pointing at a commit
// with an empty tree whose message says whose run holds it. Creating a ref is
// the one write GitHub refuses to a second writer, so whoever creates it
// holds the item. Releasing it deletes only the ref; the work branch and any
// pull request stay. Labels, assignees and the claim comment are how a person
// sees a claim, written after it is won.

import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import { activity } from "./flow.ts";
import { GitHub, Run } from "./services.ts";

// Git's empty tree, which GitHub has in every repo.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const TITLE = "chernabog claim";

// The claim on an issue, and on a pull request.
export const issue = (number: number) => `issue-${number}`;
export const pullRequest = (number: number) => `pr-${number}`;

export const refFor = (item: string) => `refs/chernabog/claims/${item}`;

// Whose run holds a claim. The commit says nothing about the machine: it is
// as public as the repo.
export type Holder = {
  readonly runId: string;
  readonly persona: string;
  readonly flow: string;
  readonly claimedAt: string;
  readonly withPerson: boolean;
};

export const messageOf = (holder: Holder) =>
  [
    TITLE,
    "",
    `Run: ${holder.runId}`,
    `Persona: ${holder.persona}`,
    `Flow: ${holder.flow}`,
    `Claimed-At: ${holder.claimedAt}`,
    ...Option.toArray(Option.liftPredicate("With-Person: true", () => holder.withPerson)),
  ].join("\n");

const TRAILER = /^([A-Za-z-]+): (.*)$/;

// The holder a claim commit's message names; none for a message that isn't a claim's.
export const holderOf = (message: string): Option.Option<Holder> => {
  const lines = message.split("\n");

  if (lines[0]?.trim() !== TITLE) {
    return Option.none();
  }

  const trailers = new Map(
    lines.flatMap((line) =>
      Option.toArray(
        Option.map(
          Option.fromNullishOr(TRAILER.exec(line.trim())),
          (match) => [match[1], match[2]] as const,
        ),
      ),
    ),
  );

  return Option.map(Option.fromUndefinedOr(trailers.get("Run")), (runId) => ({
    runId,
    persona: trailers.get("Persona") ?? "",
    flow: trailers.get("Flow") ?? "",
    claimedAt: trailers.get("Claimed-At") ?? "",
    withPerson: trailers.get("With-Person") === "true",
  }));
};

// Who holds the claim on `item`: none when nobody does.
export const holder = (item: string) =>
  GitHub.use((github) => github.ref(refFor(item))).pipe(
    Effect.map(Option.flatMap((commit) => holderOf(commit.message))),
  );

export type AcquireOptions = {
  // A person works on the item in the run, on the hybrid path.
  readonly withPerson?: boolean;
};

export type Acquired =
  | { readonly acquired: true }
  | { readonly acquired: false; readonly holder: Option.Option<Holder> };

// Claims `item` for this run, or says who holds it. Safe to repeat: a run that
// already holds the claim keeps it.
export const acquire = (item: string, options: AcquireOptions = {}) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const run = yield* Run;

    const sha = yield* github.createCommit({
      message: messageOf({
        runId: run.runId,
        persona: yield* github.login,
        flow: run.flow,
        claimedAt: DateTime.formatIso(yield* DateTime.now),
        withPerson: options.withPerson === true,
      }),
      tree: EMPTY_TREE,
      parents: [],
    });

    if ((yield* github.createRef(refFor(item), sha)) === "created") {
      return { acquired: true } satisfies Acquired;
    }

    const held = yield* holder(item);

    if (Option.exists(held, (found) => found.runId === run.runId)) {
      return { acquired: true } satisfies Acquired;
    }

    return { acquired: false, holder: held } satisfies Acquired;
  });

// Lets go of the claim on `item` if `runId` holds it, and says whether it did.
// A claim another run holds is left to it.
export const releaseFor = (item: string, runId: string) =>
  Effect.gen(function* () {
    const held = yield* holder(item);

    if (!Option.exists(held, (found) => found.runId === runId)) {
      return false;
    }

    yield* (yield* GitHub).deleteRef(refFor(item));

    return true;
  });

// Lets go of this run's claim on `item`.
export const release = (item: string) => Run.use((run) => releaseFor(item, run.runId));

// Holds the claim on `item` for as long as `effect` runs, and releases it
// however that ends, as the step `release-claim-<item>`. A run waiting on a
// signal keeps it.
export const releasing =
  (item: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      // A wait suspends the run by interrupting it; that is not an ending.
      Effect.onExit((exit) => {
        if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)) {
          return Effect.void;
        }

        return activity(`release-claim-${item}`, release(item).pipe(Effect.asVoid)).pipe(
          Effect.ignore,
        );
      }),
    );

// A note for a skip: who holds the claim, as far as its ref says.
export const describeHolder = (item: string, held: Option.Option<Holder>) =>
  Option.match(held, {
    onNone: () => `${refFor(item)} exists`,
    onSome: (found) => `run ${found.runId} of ${found.flow} holds ${refFor(item)}`,
  });
