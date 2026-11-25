// Core's Progress port on protected branches (ADR 0019,
// docs/run-progress/storage-test.md): each item is a branch,
// `chernabog/threads/<item>`, and each phase it reaches is one commit on it,
// with the record in the message's trailers. A thread starts from a root
// commit with the empty tree, so no workflow runs on it and it never falls
// behind the default branch; that root commit is the first phase, and creating
// the ref is the atomic step two first phases race on. The only files a
// thread's commits hold are the blobs a record wrote, each at
// `blobs/<hash>` in the commit that is that record, so the two land together
// or not at all.
// Every later phase is `createCommitOnBranch` with `expectedHeadOid`, GitHub's
// compare-and-set on the branch. Rulesets on `chernabog/threads/*` keep anyone
// but the personas from writing the record; without them, writes still work and
// `chernabog doctor` warns that the record is unprotected.

import { createHash } from "node:crypto";

import {
  blobBytes,
  BlobHash,
  type Json,
  parseJson,
  Phase,
  PhaseData,
  PhaseMoved,
  type PhaseRecord,
  type PhaseTransition,
  PhaseWriter,
  printJson,
  Progress,
  ProgressError,
  ProgressUnwritable,
  type RepoSettings,
  unreadableRecord,
} from "@chernabog/core";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
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

// An item names one branch below the threads: a ref component with no slash,
// no `..`, and not ending in `.lock`, which git would refuse.
const ITEM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export const isThreadItem = (item: string) =>
  ITEM.test(item) && !item.includes("..") && !item.endsWith(".lock");

// The record a commit's message carries, in trailers: `Phase`, `From` (absent
// for an item's first phase), `By`, its writer, and `Data` (absent when the
// transition carried none), the record's data as one line of JSON, with
// U+2028 and U+2029 escaped so no reader takes either for a line break. The
// headline is for a person reading the branch. Nothing in it names the
// machine: a thread is as public as the repo. When it was written is the
// commit's date, which GitHub sets, so no trailer says it.
// JSON.stringify leaves U+2028 and U+2029 raw; escaped, they are still JSON
// and decode to the same string.
const printDataLine = (data: PhaseData) =>
  printJson(data).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");

// The blobs a transition writes, each named by its SHA-256 and written once,
// in the order it gave them.
export const blobsOf = (transition: PhaseTransition): ReadonlyMap<BlobHash, Uint8Array> =>
  new Map(
    (transition.blobs ?? []).map((blob) => {
      const bytes = blobBytes(blob);

      return [createHash("sha256").update(bytes).digest("hex"), bytes];
    }),
  );

// Where a blob lives in its record's commit.
export const blobPath = (hash: BlobHash) => `blobs/${hash}`;

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

export const recordMessage = (item: string, transition: PhaseTransition) => {
  const from = Option.match(transition.from, {
    onNone: () => "",
    onSome: (read) => `${read.phase} -> `,
  });

  const trailers = [
    `Phase: ${transition.to}`,
    ...Option.toArray(Option.map(transition.from, (read) => `From: ${read.phase}`)),
    `By: ${transition.by}`,
    ...Option.toArray(
      Option.map(Option.fromUndefinedOr(transition.data), (data) => `Data: ${printDataLine(data)}`),
    ),
    ...Arr.match(Arr.fromIterable(blobsOf(transition).keys()), {
      onEmpty: () => [],
      onNonEmpty: (hashes) => [`Blobs: ${hashes.join(" ")}`],
    }),
  ];

  return {
    headline: `chernabog: ${item} ${from}${transition.to}`,
    body: trailers.join("\n"),
  };
};

// A trailer's value, from the first line that starts with its key. Lines are
// split on `\n` alone, as git writes them: a regex's `^` and `$` would also
// break at U+2028 and U+2029, which a value may hold.
const trailer = (message: string, key: string) =>
  Option.fromNullishOr(
    message.split("\n").find((line) => line.startsWith(`${key}: `) && line.length > key.length + 2),
  ).pipe(Option.map((line) => line.slice(key.length + 2).trim()));

const decodePhase = Schema.decodeUnknownOption(Phase);
const decodeWriter = Schema.decodeUnknownOption(PhaseWriter);
const decodeData = Schema.decodeUnknownOption(PhaseData);

// The trailer `key`, decoded; none when it is absent; why, when it is there
// but doesn't decode as `noun`.
const optionalTrailer = <A>(
  message: string,
  key: string,
  decode: (value: string) => Option.Option<A>,
  noun: string,
): Result.Result<Option.Option<A>, string> =>
  Option.match(trailer(message, key), {
    onNone: () => Result.succeed(Option.none<A>()),
    onSome: (value) =>
      Result.map(
        Result.fromOption(decode(value), () => `its ${key} trailer isn't ${noun}`),
        Option.some,
      ),
  });

// The trailer `key`, decoded, or why not: absent, or not `noun`.
const requiredTrailer = <A>(
  message: string,
  key: string,
  decode: (value: string) => Option.Option<A>,
  noun: string,
): Result.Result<A, string> =>
  Result.flatMap(optionalTrailer(message, key, decode, noun), (found) =>
    Result.fromOption(found, () => `it has no ${key} trailer`),
  );

const decodeDataLine = (value: string) => Option.flatMap(parseJson(value), decodeData);

const decodeHash = Schema.decodeUnknownOption(BlobHash);

// A Blobs trailer's hashes, space-separated: none if any isn't a hash.
const decodeBlobsLine = (value: string) =>
  Option.all(
    value
      .split(" ")
      .filter((hash) => hash.length > 0)
      .map((hash) => decodeHash(hash)),
  );

// The record a commit holds, read from its message and written `at` its
// commit's date, or why it holds none. A `From` or `Data` trailer that is
// there but doesn't decode makes it no record, as a bad `Phase` does.
export const readRecord = (
  version: string,
  message: string,
  at: DateTime.Utc,
): Result.Result<PhaseRecord, string> =>
  Result.gen(function* () {
    const phase = yield* requiredTrailer(message, "Phase", decodePhase, "a phase");
    const by = yield* requiredTrailer(message, "By", decodeWriter, "a writer");
    const from = yield* optionalTrailer(message, "From", decodePhase, "a phase");

    const data = yield* optionalTrailer(
      message,
      "Data",
      decodeDataLine,
      "a JSON object a record can hold",
    );

    const blobs = yield* optionalTrailer(message, "Blobs", decodeBlobsLine, "blob hashes");

    return { phase, from, by, version, at, data, blobs: Option.getOrElse(blobs, () => []) };
  });

// The record a commit holds; none for one that isn't a record.
export const parseRecord = (
  version: string,
  message: string,
  at: DateTime.Utc,
): Option.Option<PhaseRecord> => Result.getSuccess(readRecord(version, message, at));

// The phase the writer read, which the record it writes names as `from`.
export const fromPhase = (transition: PhaseTransition) =>
  Option.map(transition.from, (read) => read.phase);

// The record is this transition, by this writer: a retry of a write that
// landed. A writer that read this very record isn't retrying it, though it
// makes the same move again, as a wait recorded over its own: it advances.
const isOwn = (record: PhaseRecord, transition: PhaseTransition) =>
  record.by === transition.by &&
  record.phase === transition.to &&
  Equal.equals(record.from, fromPhase(transition)) &&
  !Option.exists(transition.from, (read) => read.version === record.version);

const versionOf = (read: Option.Option<{ readonly version: string }>) =>
  Option.map(read, (found) => found.version);

// The lost race of `transition` on `item`, which holds `current` now.
const moved = (item: string, current: Option.Option<PhaseRecord>, transition: PhaseTransition) =>
  new PhaseMoved({
    item,
    expected: fromPhase(transition),
    found: Option.map(current, (record) => record.phase),
  });

// What an advance does, given the record the item holds: succeed with that
// record (its own write, retried), fail as a lost race when it isn't the
// record the writer read, by version, or write.
export const decide = (
  item: string,
  current: Option.Option<PhaseRecord>,
  transition: PhaseTransition,
): Result.Result<Option.Option<PhaseRecord>, PhaseMoved> => {
  const own = Option.filter(current, (record) => isOwn(record, transition));

  if (Option.isSome(own)) {
    return Result.succeed(own);
  }

  if (!Equal.equals(versionOf(current), versionOf(transition.from))) {
    return Result.fail(moved(item, current, transition));
  }

  return Result.succeed(Option.none());
};

const Tip = Schema.Struct({
  oid: Schema.String,
  message: Schema.optionalKey(Schema.String),
  committedDate: Schema.optionalKey(Schema.String),
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
          Schema.Struct({
            commit: Schema.Struct({ oid: Schema.String, committedDate: Schema.String }),
          }),
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

const Created = Schema.Struct({
  sha: Schema.String,
  committer: Schema.Struct({ date: Schema.String }),
});

const Made = Schema.Struct({ sha: Schema.String });

const BlobObject = Schema.Struct({
  repository: Schema.Struct({
    object: Schema.OptionFromNullOr(Schema.Struct({ oid: Schema.String })),
  }),
});

const BlobContent = Schema.Struct({ content: Schema.String, encoding: Schema.String });

const RefError = Schema.Struct({ message: Schema.String });

const READ = `
  query ($owner: String!, $name: String!, $ref: String!) {
    repository(owner: $owner, name: $name) {
      ref(qualifiedName: $ref) { target { oid ... on Commit { message committedDate } } }
    }
  }`;

const READ_ALL = `
  query ($owner: String!, $name: String!, $prefix: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      refs(refPrefix: $prefix, first: 100, after: $after) {
        nodes { name target { oid ... on Commit { message committedDate } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

// A file at a commit, by `<oid>:<path>`: the blob there, if any.
const OBJECT = `
  query ($owner: String!, $name: String!, $expression: String!) {
    repository(owner: $owner, name: $name) {
      object(expression: $expression) { ... on Blob { oid } }
    }
  }`;

const ADVANCE = `
  mutation ($input: CreateCommitOnBranchInput!) {
    createCommitOnBranch(input: $input) { commit { oid committedDate } }
  }`;

const failed = (error: GitHubError) => new ProgressError({ message: error.message });

// The time GitHub gave a commit, which a record is `at`.
const commitTime = (
  version: string,
  date: Option.Option<string>,
): Effect.Effect<DateTime.Utc, ProgressError> =>
  Option.match(
    Option.flatMap(date, (found) => DateTime.make(found)),
    {
      onNone: () =>
        Effect.fail(new ProgressError({ message: `commit ${version} has no date GitHub gave it` })),
      onSome: (at) => Effect.succeed(DateTime.toUtc(at)),
    },
  );

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
    // Stryker disable next-line StringLiteral: a slug is owner/name; one without a slash names no repo with either default, so every read fails alike
    const [owner = "", name = ""] = options.slug.split("/");
    const repoPath = `/repos/${options.slug}`;

    const provide = <A, E>(effect: Effect.Effect<A, E, GitHubApi>) =>
      Effect.provideService(effect, GitHubApi, api);

    // Each record read, by its commit: a tip that hasn't moved is read once.
    const seen = new Map<string, PhaseRecord>();

    const recordAt = (tip: typeof Tip.Type) => {
      const cached = Option.fromUndefinedOr(seen.get(tip.oid));

      // Stryker disable next-line ConditionalExpression,BlockStatement: the cache only saves re-parsing; a tip parsed again reads as the record cached
      if (Option.isSome(cached)) {
        return Effect.succeed(cached.value);
      }

      return commitTime(tip.oid, Option.fromUndefinedOr(tip.committedDate)).pipe(
        Effect.map((at) => {
          // A tip that isn't a record, such as a commit a person pushed,
          // reads as one that says why: the ledger's check holds this item
          // alone, where failing would fail every read of every item.
          // Stryker disable next-line StringLiteral: a tip with no message and one whose message has no trailers read as the same unreadable record, with no Phase trailer
          const record = Result.getOrElse(readRecord(tip.oid, tip.message ?? "", at), (why) =>
            unreadableRecord(tip.oid, at, why),
          );

          // Stryker disable next-line BlockStatement,CallExpression: the cache only saves re-parsing; a tip parsed again reads as the record cached
          seen.set(tip.oid, record);

          return record;
        }),
      );
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
            // Stryker disable next-line ArrowFunction: { ...undefined } and { ...{} } spread to the same object
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
          Option.map(data.repository.ref, (ref) => recordAt(ref.target)),
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
          all.set(node.name, yield* recordAt(node.target));
        }

        const page = data.repository.refs.pageInfo;

        if (!page.hasNextPage || Option.isNone(page.endCursor)) {
          return all;
        }

        after = page.endCursor;
      }
    });

    const written = (version: string, date: string, transition: PhaseTransition) =>
      Effect.map(commitTime(version, Option.some(date)), (at): PhaseRecord => {
        const record = {
          phase: transition.to,
          from: fromPhase(transition),
          by: transition.by,
          version,
          at,
          data: Option.fromUndefinedOr(transition.data),
          blobs: Arr.fromIterable(blobsOf(transition).keys()),
        };

        // Stryker disable next-line BlockStatement,CallExpression: a record not cached is parsed from its commit, as the record written
        seen.set(version, record);

        return record;
      });

    // A blob or tree made through the API, `what` for a message: its sha.
    const make = (path: string, body: Json, what: string) =>
      Effect.gen(function* () {
        const made = yield* provide(githubRequest("POST", path, Option.some(body))).pipe(
          Effect.mapError(failed),
        );

        if (made.status === 403 || made.status === 404) {
          // Stryker disable next-line StringLiteral: text for a person, which no test pins word for word
          return yield* refusal(`HTTP ${made.status} creating ${what}`);
        }

        const decoded = yield* Schema.decodeUnknownEffect(Made)(Option.getOrNull(made.body)).pipe(
          Effect.mapError(
            () => new ProgressError({ message: `creating ${what} returned HTTP ${made.status}` }),
          ),
        );

        return decoded.sha;
      });

    // The tree of a first phase's commit: the empty tree, or each blob it
    // writes at blobs/<hash>. Until a ref names its commit, nothing reads it.
    const treeOf = (transition: PhaseTransition) =>
      Effect.gen(function* () {
        const blobs = Arr.fromIterable(blobsOf(transition));

        if (!Arr.isArrayNonEmpty(blobs)) {
          return EMPTY_TREE;
        }

        const tree = yield* Effect.forEach(blobs, ([hash, bytes]) =>
          Effect.map(
            make(
              `${repoPath}/git/blobs`,
              { content: base64(bytes), encoding: "base64" },
              // Stryker disable next-line StringLiteral: text for a person, which no test pins word for word
              `blob ${hash}`,
            ),
            (sha): Json => ({ path: blobPath(hash), mode: "100644", type: "blob", sha }),
          ),
        );

        return yield* make(
          `${repoPath}/git/trees`,
          { tree },
          // Stryker disable next-line StringLiteral: text for a person, which no test pins word for word
          "a thread's tree",
        );
      });

    // The item's first phase: a root commit with the empty tree, or the tree
    // of its blobs, then the ref to it, which only one writer can create.
    const first = (item: string, branch: string, transition: PhaseTransition) =>
      Effect.gen(function* () {
        const message = recordMessage(item, transition);
        const tree = yield* treeOf(transition);

        const commit = yield* provide(
          githubRequest(
            "POST",
            `${repoPath}/git/commits`,
            Option.some({
              message: `${message.headline}\n\n${message.body}\n`,
              tree,
              parents: [],
            }),
          ),
        ).pipe(Effect.mapError(failed));

        if (commit.status === 403 || commit.status === 404) {
          // Stryker disable next-line StringLiteral: text for a person, which no test pins word for word
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
          return Option.some(yield* written(sha.sha, sha.committer.date, transition));
        }

        const said = Option.getOrElse(
          Option.map(
            Option.flatMap(ref.body, Schema.decodeUnknownOption(RefError)),
            (error) => error.message,
          ),
          // Stryker disable next-line StringLiteral: text for a person, which no test pins word for word; neither text names an existing ref or a rule
          () => "no message",
        );

        if (ref.status === 422 && said.includes("Reference already exists")) {
          return Option.none<PhaseRecord>();
        }

        if (ref.status === 403 || (ref.status === 422 && /rule/i.test(said))) {
          // Stryker disable next-line StringLiteral: text for a person, which no test pins word for word
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
          // Each blob in the record's own commit, so the two land together.
          fileChanges: {
            additions: Arr.fromIterable(blobsOf(transition)).map(([hash, bytes]) => ({
              path: blobPath(hash),
              contents: base64(bytes),
            })),
          },
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
          const made = commit.value.commit;

          return {
            written: Option.some(yield* written(made.oid, made.committedDate, transition)),
            // Stryker disable next-line ArrayDeclaration: nextOrMiss reads errors only when nothing was written, and here a commit was
            errors: [],
          };
        }

        // Stryker disable next-line ArrayDeclaration: with neither a commit nor errors, the decision reads the list only for a FORBIDDEN error, which a string isn't either; what else differs is the text for a person
        return { written: Option.none<PhaseRecord>(), errors: response.errors ?? [] };
      });

    // What a write that didn't land means, from the record the item holds
    // now: with the branch where the writer read it, a refusal; moved, this
    // writer's own advance from another attempt, or a lost race.
    const afterMiss = (
      item: string,
      transition: PhaseTransition,
      refused: Effect.Effect<never, ProgressError>,
    ): Effect.Effect<PhaseRecord, PhaseMoved | ProgressError> =>
      Effect.gen(function* () {
        const now = yield* read(item);

        if (Equal.equals(versionOf(now), versionOf(transition.from))) {
          return yield* refused;
        }

        const own = Option.filter(now, (record) => isOwn(record, transition));

        if (Option.isSome(own)) {
          return own.value;
        }

        return yield* moved(item, now, transition);
      });

    // The first phase, or what its lost race means.
    const firstOrMiss = (item: string, branch: string, transition: PhaseTransition) =>
      Effect.gen(function* () {
        const made = yield* first(item, branch, transition);

        if (Option.isNone(made)) {
          const unread = new ProgressError({ message: `${branch} exists, yet holds no record` });

          return yield* afterMiss(item, transition, Effect.fail(unread));
        }

        return made.value;
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
          return result.written.value;
        }

        // Stryker disable ArrowFunction,StringLiteral,LogicalOperator: text for a person, which no test pins word for word; the decision reads errors, not this
        const said = result.errors
          .map((error) => `${error.type ?? "ERROR"}: ${error.message}`)
          .join("; ");
        // Stryker restore ArrowFunction,StringLiteral,LogicalOperator

        let refused: Effect.Effect<never, ProgressError> = Effect.fail(
          new ProgressError({ message: `advancing ${branch} failed: ${said}` }),
        );

        // A ruleset's refusal is FORBIDDEN, as a true race is; only a branch
        // that hasn't moved tells the two apart.
        if (result.errors.some((error) => error.type === "FORBIDDEN")) {
          refused = refusal(said);
        }

        return yield* afterMiss(item, transition, refused);
      });

    // The writer's read is the compare-and-set's: a later phase is a commit
    // on the branch only while its head is still the version the writer read.
    const attempt = (
      item: string,
      transition: PhaseTransition,
    ): Effect.Effect<PhaseRecord, PhaseMoved | ProgressError> =>
      Effect.gen(function* () {
        const branch = yield* branchOf(item);
        const decided = yield* Effect.fromResult(decide(item, yield* read(item), transition));

        if (Option.isSome(decided)) {
          return decided.value;
        }

        return yield* Option.match(transition.from, {
          onNone: () => firstOrMiss(item, branch, transition),
          onSome: (expected) => nextOrMiss(item, branch, transition, expected.version),
        });
      });

    // The blob at `version`'s blobs/<hash>: GraphQL finds the file, and the
    // blobs API gives its bytes, which GraphQL's text can't for binary.
    const blobAt = (version: string, hash: BlobHash) =>
      Effect.gen(function* () {
        const expression = `${version}:${blobPath(hash)}`;

        const found = yield* provide(
          githubGraphql(OBJECT, { owner, name, expression }, BlobObject),
        ).pipe(Effect.mapError(failed));

        const oid = yield* Effect.fromOption(found.repository.object).pipe(
          Effect.mapError(
            () =>
              new ProgressError({
                message: `${version} names blob ${hash}, yet holds no ${blobPath(hash)}`,
              }),
          ),
        );

        const content = yield* provide(
          githubJson("GET", `${repoPath}/git/blobs/${oid.oid}`, BlobContent),
        ).pipe(Effect.mapError(failed));

        return Uint8Array.from(Buffer.from(content.content, "base64"));
      });

    // Only a blob the item's record names, read at that record's commit.
    const blob = (item: string, hash: BlobHash) =>
      Effect.gen(function* () {
        const named = Option.filter(yield* read(item), (record) => record.blobs.includes(hash));

        return yield* Effect.transposeOption(
          Option.map(named, (record) => blobAt(record.version, hash)),
        );
      });

    return Progress.of({
      read,
      readAll,
      advance: attempt,
      blob,
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
  announce: boolean,
): Layer.Layer<Progress, never, GitHubApi> =>
  Layer.effect(Progress, makeRepoProgress({ slug: settings.slug, persona, announce }));
