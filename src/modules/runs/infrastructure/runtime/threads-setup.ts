// What `chernabog doctor` checks of the protected-branch Progress adapter's
// storage (progress.ts): whether rulesets protect `chernabog/threads/*`, and
// whether a persona may still write there. The adapter is the binary's, not a
// flow's, so the binary checks its setup (ADR 5's engine owns its ports'
// storage; a flow knows no branch). Without the rulesets, writes still work:
// the record is then unprotected, which doctor warns of, rather than a repo
// being locked out by setup only an admin can do.

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { githubRequest } from "../../../../platform/github-api.ts";
import { PROGRESS_DOCS, THREADS, THREADS_PATTERN } from "./progress.ts";

// The rules the threads need: creating and updating a thread only for the
// personas, and deleting or force-pushing one for no one but admins.
export const WRITE_RULES = ["creation", "update"] as const;
export const GUARD_RULES = ["deletion", "non_fast_forward"] as const;

const REQUIRED: ReadonlyArray<string> = [...WRITE_RULES, ...GUARD_RULES];

// What doctor found of a repo's threads, as one login.
export type ThreadsSetup =
  // The repo can't have rulesets: a private repo on GitHub Free, say.
  | { readonly status: "unavailable"; readonly reason: string }
  // No ruleset holds these rules for the threads, so anyone who can push can rewrite a record.
  | { readonly status: "unprotected"; readonly missing: ReadonlyArray<string> }
  // Every rule is there; `writes` is whether the login bypasses the write rules, none when GitHub won't say.
  | { readonly status: "protected"; readonly writes: Option.Option<boolean> };

// One rule that applies to a branch, and the ruleset it comes from.
const AppliedRule = Schema.Struct({ type: Schema.String, ruleset_id: Schema.Finite });

const Ruleset = Schema.Struct({
  current_user_can_bypass: Schema.optionalKey(Schema.String),
});

const Message = Schema.Struct({ message: Schema.String });

const Owner = Schema.Struct({ owner: Schema.Struct({ type: Schema.String }) });

const decode =
  <A>(schema: Schema.Codec<A, unknown>) =>
  (body: Option.Option<unknown>) =>
    Option.flatMap(body, Schema.decodeUnknownOption(schema));

const said = (status: number, body: Option.Option<unknown>) =>
  Option.getOrElse(
    Option.map(decode(Message)(body), (found) => found.message),
    () => `HTTP ${status}`,
  );

// The rules a ruleset on the threads lacks, from the rules GitHub applies to one.
export const missingRules = (applied: ReadonlyArray<{ readonly type: string }>) =>
  REQUIRED.filter((rule) => !applied.some((found) => found.type === rule));

// The rulesets that hold the write rules, which a persona must bypass to write.
export const writeRulesets = (
  applied: ReadonlyArray<{ readonly type: string; readonly ruleset_id: number }>,
) => [
  ...new Set(
    applied
      .values()
      .filter((found) => WRITE_RULES.some((rule) => rule === found.type))
      .map((found) => found.ruleset_id),
  ),
];

// The repo's threads as the login of the GitHubApi in context sees them.
export const checkThreadsSetup = (slug: string) =>
  Effect.gen(function* () {
    // A branch no item names, so the rules found are the pattern's alone.
    const probe = `${THREADS}doctor-probe`;
    const rules = yield* githubRequest("GET", `/repos/${slug}/rules/branches/${probe}`);

    if (rules.status !== 200) {
      return {
        status: "unavailable",
        reason: said(rules.status, rules.body),
      } satisfies ThreadsSetup;
    }

    const applied = Option.getOrElse(decode(Schema.Array(AppliedRule))(rules.body), () => []);
    const missing = missingRules(applied);

    if (missing.length > 0) {
      return { status: "unprotected", missing } satisfies ThreadsSetup;
    }

    const bypasses = yield* Effect.forEach(writeRulesets(applied), (id) =>
      githubRequest("GET", `/repos/${slug}/rulesets/${id}`).pipe(
        Effect.map((found) =>
          Option.flatMap(decode(Ruleset)(found.body), (ruleset) =>
            Option.fromUndefinedOr(ruleset.current_user_can_bypass),
          ),
        ),
      ),
    );

    const writes = Option.map(Option.all(bypasses), (each) =>
      each.every((bypass) => bypass === "always"),
    );

    return { status: "protected", writes } satisfies ThreadsSetup;
  });

// Whether the repo belongs to a person, whose rulesets can't name a team.
export const personalRepo = (slug: string) =>
  githubRequest("GET", `/repos/${slug}`).pipe(
    Effect.map((found) =>
      Option.exists(decode(Owner)(found.body), (repo) => repo.owner.type === "User"),
    ),
  );

// What a person does to set the threads up, for doctor's fix text.
export const setupFix = (slug: string, personal: boolean) => {
  let who = "the write ruleset's bypass list names a team holding the personas";

  if (personal) {
    who =
      "a personal repo has no teams, so the write ruleset's bypass list names the repository admin role, which lets the personas delete threads too";
  }

  return `add two branch rulesets to ${slug} on ${THREADS_PATTERN}: creation and update, which only the personas bypass (${who}); and deletion and non_fast_forward, which only admins bypass. ${PROGRESS_DOCS} has the commands`;
};
