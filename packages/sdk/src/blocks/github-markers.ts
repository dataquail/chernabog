// The markers the SDK's blocks put on GitHub, each with its release: a label,
// the persona's assignment, a board Status, and the claim branch. The claim
// ref's is Claims.refMarker. Each is safe to repeat. The engine knows them
// all (builtIn), so a flow lists none of them in its markers.

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { define, type Marker } from "../abi/run-markers.ts";
import { GitHub, Repo } from "../abi/services.ts";
import * as Claims from "./claims.ts";

// A label on an issue or pull request, taken off.
export const label = define(
  "chernabog/label",
  Schema.Struct({ number: Schema.Finite, label: Schema.String }),
  (args) => GitHub.use((github) => github.removeLabel(args.number, args.label)),
);

// The persona's assignment to an issue, taken off. Unassigning someone not
// assigned is not an error.
export const assignment = define(
  "chernabog/assignment",
  Schema.Struct({ number: Schema.Finite, login: Schema.String }),
  (args) =>
    Effect.gen(function* () {
      const repo = yield* Repo;

      yield* (yield* GitHub).request(
        "DELETE",
        `/repos/${repo.slug}/issues/${args.number}/assignees`,
        Option.some({ assignees: [args.login] }),
      );
    }),
);

// An issue moved on the repo's board, moved back to `status`, unless it has
// closed since: the board moves a closed issue itself.
export const boardStatus = define(
  "chernabog/board-status",
  Schema.Struct({ number: Schema.Finite, status: Schema.String }),
  (args) =>
    Effect.gen(function* () {
      const github = yield* GitHub;
      const issue = yield* github.issue(args.number);

      if (issue.state !== "closed") {
        yield* github.moveToStatus(args.number, args.status);
      }
    }).pipe(Effect.catchTag("NotFound", () => Effect.void)),
);

const Compare = Schema.Struct({ ahead_by: Schema.Finite });

// The claim branch, deleted only while it holds no work: no pull request was
// opened from it, and it has no commits its base doesn't, as `cancel` does.
export const claimBranch = define(
  "chernabog/claim-branch",
  Schema.Struct({ branch: Schema.String }),
  (args) =>
    Effect.gen(function* () {
      const github = yield* GitHub;
      const repo = yield* Repo;

      if (Option.isNone(yield* github.branchSha(args.branch))) {
        return;
      }

      if (Option.isSome(yield* github.pullRequestForBranch(args.branch))) {
        return;
      }

      const compared = yield* github.request(
        "GET",
        `/repos/${repo.slug}/compare/${encodeURIComponent(repo.baseBranch)}...${encodeURIComponent(args.branch)}`,
        Option.none(),
      );

      const { ahead_by } = yield* Schema.decodeUnknownEffect(Compare)(compared);

      if (ahead_by === 0) {
        yield* github.deleteBranch(args.branch);
      }
    }),
);

// Every marker the SDK defines, which the engine releases whatever the flow lists.
export const builtIn: ReadonlyArray<Marker> = [
  label,
  assignment,
  boardStatus,
  claimBranch,
  Claims.refMarker,
];
