// Core's Progress port on protected branches (ADR 0019,
// docs/run-progress/storage-test.md): each item is a branch,
// `chernabog/threads/<item>`, and each phase it reaches is one commit on it,
// with no file changes and the record in the message's trailers. A thread
// starts from a root commit with the empty tree, so no workflow runs on it and
// it never falls behind the default branch; that root commit is the first
// phase, and creating the ref is the atomic step two first phases race on.
// Every later phase is `createCommitOnBranch` with `expectedHeadOid`, GitHub's
// compare-and-set on the branch. Rulesets on `chernabog/threads/*` keep anyone
// but the personas from writing the record; without them, writes still work and
// `chernabog doctor` warns that the record is unprotected.

import {
  type Json,
  Phase,
  PhaseMoved,
  type PhaseRecord,
  type PhaseTransition,
  PhaseWriter,
  Progress,
  ProgressError,
  ProgressUnwritable,
  type RepoSettings,
} from "@chernabog/core";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { Persona } from "../../../../kernel/persona.value-object.ts";
import {
  GitHubApi,
  type GitHubError,
  githubGraphql,
  githubJson,
  githubRequest,
} from "../../../../platform/github-api.ts";
import { announcing } from "./phase-announcer.ts";

// Where every item's thread lives, under refs/heads/.
export const THREADS = "chernabog/threads/";

// The branches the rulesets protect. A ruleset's pattern matches with fnmatch,
// where `*` doesn't cross a `/`, so an item's name holds no slash.
export const THREADS_PATTERN = `refs/heads/${THREADS}*`;

// Where the setup is documented: the rulesets, the personas team, and the fixes doctor names.
export const PROGRESS_DOCS = "https://dataquail.github.io/chernabog/operate/progress/";

// Git's empty tree, which every thread's commits carry.
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// How many times an advance starts over when its branch moved under it and came
// back to the phase it moves from, before it says the item is too busy.
const ATTEMPTS = 3;

// An item names one branch below the threads: a ref component with no slash,
// no `..`, and not ending in `.lock`, which git would refuse.
const ITEM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export const isThreadItem = (item: string) =>
  ITEM.test(item) && !item.includes("..") && !item.endsWith(".lock");

// The record a commit's message carries, in trailers: `Phase`, `From` (absent
// for an item's first phase) and `By`, its writer. The headline is for a
// person reading the branch. Nothing in it names the machine: a thread is as
// public as the repo.
export const recordMessage = (item: string, transition: PhaseTransition) => {
  const from = Option.match(transition.from, {
    onNone: () => "",
    onSome: (phase) => `${phase} -> `,
  });

  const trailers = [
    `Phase: ${transition.to}`,
    ...Option.toArray(Option.map(transition.from, (phase) => `From: ${phase}`)),
    `By: ${transition.by}`,
  ];

  return {
    headline: `chernabog: ${item} ${from}${transition.to}`,
    body: trailers.join("\n"),
  };
};

const trailer = (message: string, key: string) =>
  Option.fromNullishOr(new RegExp(`^${key}: (.+)$`, "m").exec(message)?.[1]).pipe(
    Option.map((value) => value.trim()),
  );

const decodePhase = Schema.decodeUnknownOption(Phase);
const decodeWriter = Schema.decodeUnknownOption(PhaseWriter);

// The record a commit holds, read from its message; none for one that isn't a record.
export const parseRecord = (version: string, message: string): Option.Option<PhaseRecord> => {
  const from = trailer(message, "From");
  const fromPhase = Option.flatMap(from, decodePhase);

  if (Option.isSome(from) && Option.isNone(fromPhase)) {
    return Option.none();
  }

  return Option.all({
    phase: Option.flatMap(trailer(message, "Phase"), decodePhase),
    by: Option.flatMap(trailer(message, "By"), decodeWriter),
  }).pipe(Option.map(({ by, phase }) => ({ phase, from: fromPhase, by, version })));
};

// The record is this transition, by this writer: a retry of a write that landed.
const isOwn = (record: PhaseRecord, transition: PhaseTransition) =>
  record.by === transition.by &&
  record.phase === transition.to &&
  Equal.equals(record.from, transition.from);

// What an advance does, given the record the item holds: succeed with that
// record (its own write, retried), fail as a lost race, or write.
export const decide = (
  item: string,
  current: Option.Option<PhaseRecord>,
  transition: PhaseTransition,
): Result.Result<Option.Option<PhaseRecord>, PhaseMoved> => {
  const own = Option.filter(current, (record) => isOwn(record, transition));

  if (Option.isSome(own)) {
    return Result.succeed(own);
  }

  const phase = Option.map(current, (record) => record.phase);

  if (!Equal.equals(phase, transition.from)) {
    return Result.fail(new PhaseMoved({ item, expected: transition.from, found: phase }));
  }

  return Result.succeed(Option.none());
};

const Tip = Schema.Struct({
  oid: Schema.String,
  message: Schema.optionalKey(Schema.String),
});

const ReadData = Schema.Struct({
  repository: Schema.Struct({
    ref: Schema.OptionFromNullOr(Schema.Struct({ target: Tip })),
  }),
});

const ReadAllData = Schema.Struct({
  repository: Schema.Struct({
    refs: Schema.Struct({
      nodes: Schema.Array(Schema.Struct({ name: Schema.String, target: Tip })),
      pageInfo: Schema.Struct({
        hasNextPage: Schema.Boolean,
        endCursor: Schema.OptionFromNullOr(Schema.String),
      }),
    }),
  }),
});

const AdvanceResponse = Schema.Struct({
  data: Schema.optionalKey(
    Schema.OptionFromNullOr(
      Schema.Struct({
        createCommitOnBranch: Schema.OptionFromNullOr(
          Schema.Struct({ commit: Schema.Struct({ oid: Schema.String }) }),
        ),
      }),
    ),
  ),
  errors: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ type: Schema.optionalKey(Schema.String), message: Schema.String }),
    ),
  ),
});

const Created = Schema.Struct({ sha: Schema.String });

const RefError = Schema.Struct({ message: Schema.String });

const READ = `
  query ($owner: String!, $name: String!, $ref: String!) {
    repository(owner: $owner, name: $name) {
      ref(qualifiedName: $ref) { target { oid ... on Commit { message } } }
    }
  }`;

const READ_ALL = `
  query ($owner: String!, $name: String!, $prefix: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      refs(refPrefix: $prefix, first: 100, after: $after) {
        nodes { name target { oid ... on Commit { message } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

const ADVANCE = `
  mutation ($input: CreateCommitOnBranchInput!) {
    createCommitOnBranch(input: $input) { commit { oid } }
  }`;

const failed = (error: GitHubError) => new ProgressError({ message: error.message });

// Where an adapter keeps its threads: a repo, the persona it writes as, and
// the branches' prefix, which a live test moves aside so it holds no records.
export type ThreadsOptions = {
  readonly slug: string;
  readonly persona: Persona;
  readonly prefix?: string;
};

// The adapter, over the GitHub API as the persona.
export const makeThreadsProgress = (options: ThreadsOptions) =>
  Effect.gen(function* () {
    const api = yield* GitHubApi;
    const prefix = options.prefix ?? THREADS;
    const [owner = "", name = ""] = options.slug.split("/");
    const repoPath = `/repos/${options.slug}`;

    const provide = <A, E>(effect: Effect.Effect<A, E, GitHubApi>) =>
      Effect.provideService(effect, GitHubApi, api);

    // Each record read, by its commit: a tip that hasn't moved is read once.
    const seen = new Map<string, PhaseRecord>();

    const recordAt = (item: string, tip: typeof Tip.Type) => {
      const cached = Option.fromUndefinedOr(seen.get(tip.oid));

      if (Option.isSome(cached)) {
        return Effect.succeed(cached.value);
      }

      return Option.match(parseRecord(tip.oid, tip.message ?? ""), {
        onNone: () =>
          Effect.fail(
            new ProgressError({
              message: `${prefix}${item} is at ${tip.oid}, which holds no phase record`,
            }),
          ),
        onSome: (record) =>
          Effect.sync(() => {
            seen.set(tip.oid, record);

            return record;
          }),
      });
    };

    const branchOf = (item: string) => {
      if (!isThreadItem(item)) {
        return Effect.fail(
          new ProgressError({
            message: `"${item}" can't name a thread: an item is letters, digits, '.', '_' and '-', with no slash`,
          }),
        );
      }

      return Effect.succeed(`${prefix}${item}`);
    };

    const refusal = (reason: string) =>
      Effect.die(
        new ProgressUnwritable({
          ...Option.match(options.persona, {
            onNone: () => ({}),
            onSome: (login) => ({ login }),
          }),
          reason: `GitHub refused a write to ${prefix}* in ${options.slug} (${reason})`,
          fix: `give it write access to ${options.slug} and add it to the team the threads' write ruleset lets bypass (${PROGRESS_DOCS}); chernabog doctor checks it`,
        }),
      );

    const read = (item: string) =>
      Effect.gen(function* () {
        const branch = yield* branchOf(item);

        const data = yield* provide(
          githubGraphql(READ, { owner, name, ref: `refs/heads/${branch}` }, ReadData),
        ).pipe(Effect.mapError(failed));

        return yield* Effect.transposeOption(
          Option.map(data.repository.ref, (ref) => recordAt(item, ref.target)),
        );
      });

    const readAll = Effect.gen(function* () {
      const all = new Map<string, PhaseRecord>();
      let after = Option.none<string>();

      for (;;) {
        const variables = {
          owner,
          name,
          prefix: `refs/heads/${prefix}`,
          after: Option.getOrNull(after),
        };

        const data = yield* provide(githubGraphql(READ_ALL, variables, ReadAllData)).pipe(
          Effect.mapError(failed),
        );

        // A branch below an item's, which no item names, isn't a record.
        for (const node of data.repository.refs.nodes.filter((one) => isThreadItem(one.name))) {
          all.set(node.name, yield* recordAt(node.name, node.target));
        }

        const page = data.repository.refs.pageInfo;

        if (!page.hasNextPage || Option.isNone(page.endCursor)) {
          return all;
        }

        after = page.endCursor;
      }
    });

    const written = (version: string, transition: PhaseTransition): PhaseRecord => {
      const record = { phase: transition.to, from: transition.from, by: transition.by, version };
      seen.set(version, record);

      return record;
    };

    // The item's first phase: a root commit with the empty tree, then the ref
    // to it, which only one writer can create.
    const first = (item: string, branch: string, transition: PhaseTransition) =>
      Effect.gen(function* () {
        const message = recordMessage(item, transition);

        const commit = yield* provide(
          githubRequest(
            "POST",
            `${repoPath}/git/commits`,
            Option.some({
              message: `${message.headline}\n\n${message.body}\n`,
              tree: EMPTY_TREE,
              parents: [],
            }),
          ),
        ).pipe(Effect.mapError(failed));

        if (commit.status === 403 || commit.status === 404) {
          return yield* refusal(`HTTP ${commit.status} creating a commit`);
        }

        const sha = yield* Schema.decodeUnknownEffect(Created)(Option.getOrNull(commit.body)).pipe(
          Effect.mapError(
            () =>
              new ProgressError({
                message: `creating ${branch}'s first commit returned HTTP ${commit.status}`,
              }),
          ),
        );

        const ref = yield* provide(
          githubRequest(
            "POST",
            `${repoPath}/git/refs`,
            Option.some({ ref: `refs/heads/${branch}`, sha: sha.sha }),
          ),
        ).pipe(Effect.mapError(failed));

        if (ref.status === 201) {
          return Option.some(written(sha.sha, transition));
        }

        const said = Option.getOrElse(
          Option.map(
            Option.flatMap(ref.body, Schema.decodeUnknownOption(RefError)),
            (error) => error.message,
          ),
          () => "no message",
        );

        if (ref.status === 422 && said.includes("Reference already exists")) {
          return Option.none<PhaseRecord>();
        }

        if (ref.status === 403 || (ref.status === 422 && /rule/i.test(said))) {
          return yield* refusal(`HTTP ${ref.status} creating ${branch}: ${said}`);
        }

        return yield* new ProgressError({
          message: `creating ${branch} returned HTTP ${ref.status}: ${said}`,
        });
      });

    // A later phase: a commit on the branch, only if it is still at `expected`.
    const next = (item: string, branch: string, transition: PhaseTransition, expected: string) =>
      Effect.gen(function* () {
        const message = recordMessage(item, transition);

        const input: Json = {
          branch: { repositoryNameWithOwner: options.slug, branchName: branch },
          expectedHeadOid: expected,
          message,
          fileChanges: {},
        };

        // A lost race arrives as HTTP 200 with errors, so the body is read
        // whatever the status says.
        const response = yield* provide(
          githubJson(
            "POST",
            "/graphql",
            AdvanceResponse,
            Option.some({ query: ADVANCE, variables: { input } }),
          ),
        ).pipe(Effect.mapError(failed));

        const commit = Option.flatMap(
          Option.flatten(Option.fromUndefinedOr(response.data)),
          (data) => data.createCommitOnBranch,
        );

        if (Option.isSome(commit)) {
          return { written: Option.some(written(commit.value.commit.oid, transition)), errors: [] };
        }

        return { written: Option.none<PhaseRecord>(), errors: response.errors ?? [] };
      });

    // What a write that didn't land means, from the record the item holds
    // now: someone else's advance (a lost race, or this writer's own from
    // another attempt), or, with the branch where it was, a refusal.
    const afterMiss = (
      item: string,
      transition: PhaseTransition,
      before: Option.Option<string>,
      refused: Effect.Effect<never, ProgressError>,
    ) =>
      Effect.gen(function* () {
        const now = yield* read(item);
        const version = Option.map(now, (record) => record.version);

        if (Equal.equals(version, before)) {
          return yield* refused;
        }

        return yield* Effect.fromResult(decide(item, now, transition));
      });

    // The first phase, or what its lost race means.
    const firstOrMiss = (item: string, branch: string, transition: PhaseTransition) =>
      Effect.gen(function* () {
        const made = yield* first(item, branch, transition);

        if (Option.isNone(made)) {
          const unread = new ProgressError({ message: `${branch} exists, yet holds no record` });

          return yield* afterMiss(item, transition, Option.none(), Effect.fail(unread));
        }

        return made;
      });

    // A later phase, or what its miss means: a lost race, or a refusal.
    const nextOrMiss = (
      item: string,
      branch: string,
      transition: PhaseTransition,
      expected: string,
    ) =>
      Effect.gen(function* () {
        const result = yield* next(item, branch, transition, expected);

        if (Option.isSome(result.written)) {
          return result.written;
        }

        const said = result.errors
          .map((error) => `${error.type ?? "ERROR"}: ${error.message}`)
          .join("; ");

        let refused: Effect.Effect<never, ProgressError> = Effect.fail(
          new ProgressError({ message: `advancing ${branch} failed: ${said}` }),
        );

        // A ruleset's refusal is FORBIDDEN, as a true race is; only a branch
        // that hasn't moved tells the two apart.
        if (result.errors.some((error) => error.type === "FORBIDDEN")) {
          refused = refusal(said);
        }

        return yield* afterMiss(item, transition, Option.some(expected), refused);
      });

    const attempt = (
      item: string,
      transition: PhaseTransition,
      left: number,
    ): Effect.Effect<PhaseRecord, PhaseMoved | ProgressError> =>
      Effect.gen(function* () {
        const branch = yield* branchOf(item);
        const current = yield* read(item);
        const decided = yield* Effect.fromResult(decide(item, current, transition));

        if (Option.isSome(decided)) {
          return decided.value;
        }

        const before = Option.map(current, (record) => record.version);

        const landed = yield* Option.match(before, {
          onNone: () => firstOrMiss(item, branch, transition),
          onSome: (expected) => nextOrMiss(item, branch, transition, expected),
        });

        if (Option.isSome(landed)) {
          return landed.value;
        }

        // The branch moved and came back to `from`: start over, a few times.
        if (left <= 1) {
          return yield* new ProgressError({
            message: `${branch} kept moving; ${transition.by} couldn't advance it`,
          });
        }

        return yield* attempt(item, transition, left - 1);
      });

    return Progress.of({
      read,
      readAll,
      advance: (item, transition) => attempt(item, transition, ATTEMPTS),
    });
  });

// The repo's adapter, announcing each advance with a repository_dispatch
// unless the repo turned that off (phase-announcer.ts).
export const makeRepoProgress = (options: ThreadsOptions & { readonly announce: boolean }) =>
  Effect.gen(function* () {
    const progress = yield* makeThreadsProgress(options);

    if (!options.announce) {
      return progress;
    }

    return yield* announcing(progress, options.slug);
  });

// The repo's Progress, as the persona its runs act as, announcing each
// advance unless the repo's announcePhases is false.
export const ProgressLive = (
  settings: RepoSettings,
  persona: Persona,
  announce = true,
): Layer.Layer<Progress, never, GitHubApi> =>
  Layer.effect(Progress, makeRepoProgress({ slug: settings.slug, persona, announce }));
