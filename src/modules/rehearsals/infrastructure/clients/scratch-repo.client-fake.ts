import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Record from "effect/Record";

import {
  type IssueRemoval,
  type ItemState,
  ScratchRepoClient,
} from "../../domain/ports/clients/scratch-repo.client.ts";
import { ScratchRepoFailed } from "../../domain/scenario/scenario.errors.ts";

// A repo in memory: what was opened, closed and deleted, in order, as
// `log`. Numbers count up from 100; `failOn` fails the first call whose log
// line starts with it; `admin` deletes issues rather than closing them.
export const scratchRepoFake = (
  options: {
    readonly failOn?: string;
    readonly admin?: boolean;
    readonly states?: Readonly<Record<string, ItemState>>;
    readonly pullsFrom?: Readonly<Record<string, ReadonlyArray<number>>>;
  } = {},
) => {
  const log: Array<string> = [];
  let next = 100;

  const numbered = () => {
    next += 1;

    return next - 1;
  };

  const record = <A>(line: string, value: () => A) =>
    Effect.suspend(() => {
      if (
        Option.exists(Option.fromUndefinedOr(options.failOn), (prefix) => line.startsWith(prefix))
      ) {
        return Effect.fail(new ScratchRepoFailed({ message: `failed: ${line}` }));
      }

      log.push(line);

      return Effect.succeed(value());
    });

  const layer = Layer.succeed(
    ScratchRepoClient,
    ScratchRepoClient.of({
      defaultBranch: () => Effect.succeed("main"),
      openIssue: (_repo, seed) => record(`open issue ${seed.title}`, numbered),
      openPullRequest: (_repo, base, seed) =>
        record(`open pull request ${seed.branch} on ${base}`, numbered),
      stateOf: (_repo, number) =>
        Effect.succeed(
          Option.getOrElse(
            Option.flatMap(Option.fromUndefinedOr(options.states), (states) =>
              Record.get(states, String(number)),
            ),
            (): ItemState => ({ labels: [], reviewRequests: [] }),
          ),
        ),
      pullRequestsFrom: (_repo, branch) =>
        Effect.succeed(
          Option.getOrElse(
            Option.flatMap(Option.fromUndefinedOr(options.pullsFrom), (pulls) =>
              Record.get(pulls, branch),
            ),
            (): ReadonlyArray<number> => [],
          ),
        ),
      removeIssue: (_repo, number) => {
        let how: IssueRemoval = "closed";

        if (options.admin === true) {
          how = "deleted";
        }

        return record(`${how} issue #${number}`, () => how);
      },
      closePullRequest: (_repo, number) =>
        Effect.asVoid(record(`close pull request #${number}`, () => number)),
      deleteBranch: (_repo, branch) =>
        Effect.asVoid(record(`delete branch ${branch}`, () => branch)),
    }),
  );

  return { layer, log };
};
