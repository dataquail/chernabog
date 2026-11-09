// A stand-in for the parts of GitHub the protected-branch Progress adapter
// talks to: commits made through the API, refs, the GraphQL reads of a ref and
// of every ref under a prefix, and createCommitOnBranch's compare-and-set,
// answering a lost race with HTTP 200 and errors, as GitHub does
// (docs/run-progress/storage-test.md). It answers githubTestLayer's handler.

import { type Json } from "@chernabog/core";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

type Commit = { readonly oid: string; readonly message: string };

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
  // Every request, as "<method> <path>", and a GraphQL one by what it asks.
  readonly requests: Array<string>;
};

const Body = Schema.Struct({
  query: Schema.optionalKey(Schema.String),
  variables: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  message: Schema.optionalKey(Schema.String),
  ref: Schema.optionalKey(Schema.String),
  sha: Schema.optionalKey(Schema.String),
});

const AdvanceInput = Schema.Struct({
  branch: Schema.Struct({ branchName: Schema.String }),
  expectedHeadOid: Schema.String,
  message: Schema.Struct({ headline: Schema.String, body: Schema.optionalKey(Schema.String) }),
});

// GitHub's JSON null, for a field it leaves empty.
const NULL = Schema.encodeSync(Schema.OptionFromNullOr(Schema.Json))(Option.none());

const answer = (body: Json, status = 200) => Option.some({ status, body });

export const makeThreadsFake = (slug: string) => {
  const commits = new Map<string, Commit>();
  // Each ref's tip, by its full name.
  const refs = new Map<string, string>();
  let made = 0;

  const state: ThreadsFakeState = {
    lostRaceAs: "STALE_DATA",
    refuse: false,
    beforeNextAdvance: Option.none(),
    requests: [],
  };

  const commit = (message: string) => {
    made += 1;
    const oid = made.toString(16).padStart(40, "0");
    commits.set(oid, { oid, message });

    return oid;
  };

  const target = (oid: string) => ({
    oid,
    message: Option.getOrElse(
      Option.map(Option.fromUndefinedOr(commits.get(oid)), (found) => found.message),
      () => "",
    ),
  });

  // Moves a branch on as another writer would, with this message.
  const advanceAs = (branch: string, message: string) => {
    const oid = commit(message);
    refs.set(`refs/heads/${branch}`, oid);

    return oid;
  };

  const graphql = (query: string, variables: Readonly<Record<string, Json>>) => {
    if (query.includes("createCommitOnBranch")) {
      state.requests.push("graphql createCommitOnBranch");
      const input = Schema.decodeUnknownSync(AdvanceInput)(variables.input);
      const ref = `refs/heads/${input.branch.branchName}`;

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

      const oid = commit(`${input.message.headline}\n\n${input.message.body ?? ""}`);
      refs.set(ref, oid);

      return answer({ data: { createCommitOnBranch: { commit: { oid } } } });
    }

    if (query.includes("refs(refPrefix")) {
      state.requests.push("graphql refs");
      const prefix = String(variables.prefix);

      const nodes = refs
        .entries()
        .filter(([name]) => name.startsWith(prefix))
        .map(([name, oid]) => ({ name: name.slice(prefix.length), target: target(oid) }))
        .toArray();

      return answer({
        data: {
          repository: {
            refs: { nodes, pageInfo: { hasNextPage: false, endCursor: NULL } },
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

  const handler = (method: string, path: string, raw: Option.Option<Json>) => {
    const body = Schema.decodeUnknownSync(Body)(Option.getOrElse(raw, () => ({})));

    if (method === "POST" && path === "/graphql") {
      return graphql(body.query ?? "", body.variables ?? {});
    }

    state.requests.push(`${method} ${path}`);

    if (method === "POST" && path === `${repo}/git/commits`) {
      return answer({ sha: commit(body.message ?? "") }, 201);
    }

    if (method === "POST" && path === `${repo}/git/refs`) {
      const ref = body.ref ?? "";

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

  return { handler, state, advanceAs, refs };
};
