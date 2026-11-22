// A stand-in for the parts of GitHub the protected-branch Progress adapter
// talks to: commits made through the API, refs, the GraphQL reads of a ref and
// of every ref under a prefix, and createCommitOnBranch's compare-and-set,
// answering a lost race with HTTP 200 and errors, as GitHub does
// (docs/run-progress/storage-test.md). Commits hold files, which the
// adapter writes as blobs and trees through the API, or as createCommitOnBranch's
// additions, and reads by GraphQL's object(expression) and the blobs API. It
// checks what it is sent as GitHub would: the repo a query names, a commit's
// tree and parents, a blob's encoding and a tree entry's mode and type. It
// gives refs a page at a time, and a test can let another writer in before an
// advance or a ref, or answer any request itself. It answers githubTestLayer's
// handler.

import { createHash } from "node:crypto";

import { type Json } from "@chernabog/core";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

// A commit's files, by path, as the bytes each holds.
type Files = ReadonlyMap<string, Uint8Array>;

type Commit = {
  readonly oid: string;
  readonly message: string;
  readonly date: string;
  readonly files: Files;
};

// Git's empty tree, which GitHub has in every repo.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// How a lost createCommitOnBranch is answered: a stale head found up front, or
// a true race, which GitHub reports as FORBIDDEN.
export type LostRaceAnswer = "STALE_DATA" | "FORBIDDEN";

// What a test sets on the fake, and what it records.
export type ThreadsFakeState = {
  // How a lost advance is answered.
  lostRaceAs: LostRaceAnswer;
  // Whether rulesets refuse the persona's writes.
  refuse: boolean;
  // Runs once, just before the next advance is compared and set: another writer's move.
  beforeNextAdvance: Option.Option<() => void>;
  // Runs once, just before the next ref is created: another writer's first phase.
  beforeNextRef: Option.Option<() => void>;
  // Answers a request in the fake's place when it gives an answer: a failure,
  // or a response GitHub wouldn't send. It sees the request's body.
  respond: (method: string, path: string, body: RequestBody) => Option.Option<Answer>;
  // Every request, as "<method> <path>", and a GraphQL one by what it asks.
  readonly requests: Array<string>;
};

// An answer to a request: its status and its body.
export type Answer = { readonly status: number; readonly body: Json };

const Body = Schema.Struct({
  query: Schema.optionalKey(Schema.String),
  variables: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  message: Schema.optionalKey(Schema.String),
  ref: Schema.optionalKey(Schema.String),
  sha: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.String),
  encoding: Schema.optionalKey(Schema.String),
  tree: Schema.optionalKey(Schema.Json),
  parents: Schema.optionalKey(Schema.Array(Schema.Json)),
});

export type RequestBody = typeof Body.Type;

// A tree the API makes: each entry a path and the blob it holds.
const TreeEntries = Schema.Array(
  Schema.Struct({
    path: Schema.String,
    mode: Schema.String,
    type: Schema.String,
    sha: Schema.String,
  }),
);

// The modes a tree entry may have, and the encodings a blob may be sent in.
const MODES = new Set(["100644", "100755", "040000", "160000", "120000"]);
const ENCODINGS = new Set(["utf-8", "base64"]);

// How many refs GitHub gives a page, as the adapter asks, and the cursor
// after one: how many refs it has given.
const PAGE = 100;
const decodeCursor = Schema.decodeUnknownOption(Schema.FiniteFromString);

const AdvanceInput = Schema.Struct({
  branch: Schema.Struct({ repositoryNameWithOwner: Schema.String, branchName: Schema.String }),
  expectedHeadOid: Schema.String,
  message: Schema.Struct({ headline: Schema.String, body: Schema.optionalKey(Schema.String) }),
  fileChanges: Schema.optionalKey(
    Schema.Struct({
      additions: Schema.optionalKey(
        Schema.Array(Schema.Struct({ path: Schema.String, contents: Schema.String })),
      ),
    }),
  ),
});

// GitHub's JSON null, for a field it leaves empty.
export const NULL = Schema.encodeSync(Schema.OptionFromNullOr(Schema.Json))(Option.none());

const answer = (body: Json, status = 200): Option.Option<Answer> => Option.some({ status, body });

// A GraphQL query of a repo GitHub has no such repo as.
const noSuchRepo = (owner: Json, name: Json) =>
  answer({
    data: { repository: NULL },
    errors: [
      {
        type: "NOT_FOUND",
        message: `Could not resolve to a Repository with the name '${String(owner)}/${String(name)}'.`,
      },
    ],
  });

export const makeThreadsFake = (slug: string) => {
  const commits = new Map<string, Commit>();
  // Each ref's tip, by its full name.
  const refs = new Map<string, string>();
  // Every blob made, by its sha, and every tree, by its sha.
  const blobs = new Map<string, Uint8Array>();
  const trees = new Map<string, Files>([[EMPTY_TREE, new Map()]]);
  let made = 0;

  const state: ThreadsFakeState = {
    lostRaceAs: "STALE_DATA",
    refuse: false,
    beforeNextAdvance: Option.none(),
    beforeNextRef: Option.none(),
    respond: () => Option.none(),
    requests: [],
  };

  // GitHub dates each commit it makes; here the nth is n seconds past noon.
  const dateOf = (n: number) =>
    DateTime.formatIso(DateTime.add(DateTime.makeUnsafe("2026-11-17T12:00:00Z"), { seconds: n }));

  const commit = (message: string, files: Files = new Map()) => {
    made += 1;
    const oid = made.toString(16).padStart(40, "0");
    commits.set(oid, { oid, message, date: dateOf(made), files });

    return oid;
  };

  const committed = (oid: string) => Option.fromUndefinedOr(commits.get(oid));

  // A blob's sha: its bytes' SHA-1, as git's is, near enough.
  const blobOf = (bytes: Uint8Array) => {
    const sha = createHash("sha1").update(bytes).digest("hex");
    blobs.set(sha, bytes);

    return sha;
  };

  const filesOf = (oid: string): Files =>
    Option.getOrElse(
      Option.map(committed(oid), (found) => found.files),
      () => new Map(),
    );

  // Every file any commit holds, by path.
  const everyFile = (): Files =>
    new Map(
      commits
        .values()
        .flatMap((found) => found.files)
        .toArray(),
    );

  const target = (oid: string) => ({
    oid,
    message: Option.getOrElse(
      Option.map(committed(oid), (found) => found.message),
      () => "",
    ),
    committedDate: Option.getOrElse(
      Option.map(committed(oid), (found) => found.date),
      () => dateOf(0),
    ),
  });

  // Moves a branch on as another writer would, with this message.
  const advanceAs = (branch: string, message: string) => {
    const oid = commit(message);
    refs.set(`refs/heads/${branch}`, oid);

    return oid;
  };

  const [owner = "", name = ""] = slug.split("/");

  const graphql = (query: string, variables: Readonly<Record<string, Json>>) => {
    if (query.includes("createCommitOnBranch")) {
      state.requests.push("graphql createCommitOnBranch");
      const input = Schema.decodeUnknownSync(AdvanceInput)(variables.input);
      const ref = `refs/heads/${input.branch.branchName}`;

      if (input.branch.repositoryNameWithOwner !== slug) {
        return answer({
          data: { createCommitOnBranch: NULL },
          errors: [
            {
              type: "NOT_FOUND",
              message: `Could not resolve to a Repository with the name '${input.branch.repositoryNameWithOwner}'.`,
            },
          ],
        });
      }

      const hook = state.beforeNextAdvance;
      state.beforeNextAdvance = Option.none();

      if (Option.isSome(hook)) {
        hook.value();
      }

      if (state.refuse) {
        return answer({
          data: { createCommitOnBranch: NULL },
          errors: [{ type: "FORBIDDEN", message: "Repository rule violations found" }],
        });
      }

      const tip = Option.fromUndefinedOr(refs.get(ref));

      if (!Option.contains(tip, input.expectedHeadOid)) {
        let message = `Expected branch to point to "${input.expectedHeadOid}" but it did not.  Pull and try again.`;

        if (state.lostRaceAs === "FORBIDDEN") {
          message = `is at ${Option.getOrElse(tip, () => "nothing")} but expected ${input.expectedHeadOid}`;
        }

        return answer({
          data: { createCommitOnBranch: NULL },
          errors: [{ type: state.lostRaceAs, message }],
        });
      }

      const added = (input.fileChanges?.additions ?? []).map(
        (addition) => [addition.path, Buffer.from(addition.contents, "base64")] as const,
      );

      const oid = commit(
        `${input.message.headline}\n\n${input.message.body ?? ""}`,
        new Map([...filesOf(input.expectedHeadOid), ...added]),
      );

      refs.set(ref, oid);

      return answer({
        data: {
          createCommitOnBranch: { commit: { oid, committedDate: target(oid).committedDate } },
        },
      });
    }

    // Every read names the repo by owner and name.
    if (variables.owner !== owner || variables.name !== name) {
      state.requests.push("graphql of another repo");

      return noSuchRepo(variables.owner ?? NULL, variables.name ?? NULL);
    }

    if (query.includes("object(expression")) {
      const expression = String(variables.expression);
      state.requests.push(`graphql object ${expression}`);
      const [oid = "", path = ""] = expression.split(":");

      const sha = Option.map(Option.fromUndefinedOr(filesOf(oid).get(path)), (bytes) =>
        blobOf(bytes),
      );

      return answer({
        data: {
          repository: {
            object: Option.getOrElse(
              Option.map(sha, (found) => ({ oid: found })),
              () => NULL,
            ),
          },
        },
      });
    }

    if (query.includes("refs(refPrefix")) {
      state.requests.push("graphql refs");
      const prefix = String(variables.prefix);

      // A page's cursor is where the next one starts.
      const start = Option.getOrElse(decodeCursor(variables.after), () => 0);

      const all = refs
        .entries()
        .filter(([ref]) => ref.startsWith(prefix))
        .map(([ref, oid]) => ({ name: ref.slice(prefix.length), target: target(oid) }))
        .toArray();

      const nodes = all.slice(start, start + PAGE);
      const end = start + nodes.length;

      return answer({
        data: {
          repository: {
            refs: {
              nodes,
              pageInfo: {
                hasNextPage: end < all.length,
                endCursor: Arr.match(nodes, { onEmpty: () => NULL, onNonEmpty: () => `${end}` }),
              },
            },
          },
        },
      });
    }

    if (query.includes("ref(qualifiedName")) {
      state.requests.push("graphql ref");
      const tip = Option.fromUndefinedOr(refs.get(String(variables.ref)));

      return answer({
        data: {
          repository: {
            ref: Option.getOrNull(Option.map(tip, (oid) => ({ target: target(oid) }))),
          },
        },
      });
    }

    return Option.none();
  };

  const repo = `/repos/${slug}`;

  // The blobs and trees API: a blob made from base64, read back as base64,
  // and a tree of blobs by path.
  const objects = (method: string, path: string, body: typeof Body.Type) => {
    if (method === "POST" && path === `${repo}/git/blobs`) {
      if (!ENCODINGS.has(body.encoding ?? "utf-8")) {
        return answer({ message: "Invalid encoding" }, 422);
      }

      const sha = blobOf(Buffer.from(body.content ?? "", "base64"));

      return answer({ sha }, 201);
    }

    if (method === "GET" && path.startsWith(`${repo}/git/blobs/`)) {
      const bytes = Option.fromUndefinedOr(blobs.get(path.slice(`${repo}/git/blobs/`.length)));

      return Option.match(bytes, {
        onNone: () => answer({ message: "Not Found" }, 404),
        onSome: (found) =>
          answer({ content: Buffer.from(found).toString("base64"), encoding: "base64" }),
      });
    }

    if (method === "POST" && path === `${repo}/git/trees`) {
      const entries = Schema.decodeUnknownSync(TreeEntries)(body.tree);

      if (entries.some((entry) => !MODES.has(entry.mode) || entry.type !== "blob")) {
        return answer({ message: "Invalid tree info" }, 422);
      }

      const files: Files = new Map(
        entries.map((entry) => [entry.path, blobs.get(entry.sha) ?? new Uint8Array()]),
      );

      made += 1;
      const sha = `${made}`.padStart(40, "f");
      trees.set(sha, files);

      return answer({ sha }, 201);
    }

    return Option.none();
  };

  // The commits and refs API: a commit of a tree GitHub has, and a ref to one.
  const history = (method: string, path: string, body: typeof Body.Type) => {
    if (method === "POST" && path === `${repo}/git/commits`) {
      // A commit's tree and parents must be objects GitHub has.
      const files = Option.flatMap(
        Option.filter(Option.fromUndefinedOr(body.tree), Predicate.isString),
        (tree) => Option.fromUndefinedOr(trees.get(tree)),
      );

      const parents = body.parents ?? [];

      if (Option.isNone(files)) {
        return answer({ message: "Tree SHA does not exist" }, 422);
      }

      if (!parents.every((parent) => Predicate.isString(parent) && commits.has(parent))) {
        return answer({ message: "Parent SHA does not exist or is not a commit object" }, 422);
      }

      const sha = commit(body.message ?? "", files.value);

      return answer({ sha, committer: { date: target(sha).committedDate } }, 201);
    }

    if (method === "POST" && path === `${repo}/git/refs`) {
      const ref = body.ref ?? "";

      const hook = state.beforeNextRef;
      state.beforeNextRef = Option.none();

      if (Option.isSome(hook)) {
        hook.value();
      }

      if (state.refuse) {
        return answer(
          {
            message:
              "Repository rule violations found\n\nCannot create ref due to creations being restricted.",
          },
          422,
        );
      }

      if (refs.has(ref)) {
        return answer({ message: "Reference already exists" }, 422);
      }

      refs.set(ref, body.sha ?? "");

      return answer({ ref, object: { sha: body.sha ?? "" } }, 201);
    }

    return Option.none();
  };

  const handler = (method: string, path: string, raw: Option.Option<Json>) => {
    const body = Schema.decodeUnknownSync(Body)(Option.getOrElse(raw, () => ({})));
    const replaced = state.respond(method, path, body);

    if (Option.isSome(replaced)) {
      state.requests.push(`${method} ${path} (answered by the test)`);

      return replaced;
    }

    if (method === "POST" && path === "/graphql") {
      return graphql(body.query ?? "", body.variables ?? {});
    }

    state.requests.push(`${method} ${path}`);

    const object = objects(method, path, body);

    if (Option.isSome(object)) {
      return object;
    }

    return history(method, path, body);
  };

  return { handler, state, advanceAs, refs, filesOf, everyFile };
};
