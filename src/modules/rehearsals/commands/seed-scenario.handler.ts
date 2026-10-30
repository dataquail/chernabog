import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { ScratchRepoClient } from "../domain/ports/clients/scratch-repo.client.ts";
import { SeedingFailed } from "../domain/scenario/scenario.errors.ts";
import { NOTHING_SEEDED, type Seeded } from "../domain/scenario/seeded.value-object.ts";
import { type SeedScenarioPayload } from "./seed-scenario.command.ts";

export const seedScenarioHandler = Effect.fn("seedScenarioHandler")(function* (
  cmd: SeedScenarioPayload,
) {
  const { as, scenario } = cmd;
  const client = yield* ScratchRepoClient;
  const made = yield* Ref.make<Seeded>(NOTHING_SEEDED);
  const given = scenario.given ?? {};

  const seeding = Effect.gen(function* () {
    for (const issue of given.issues ?? []) {
      const number = yield* client.openIssue(scenario.repo, issue, as);
      yield* Ref.update(made, (seeded) => ({
        ...seeded,
        issues: [...seeded.issues, { name: issue.name, number }],
      }));
    }

    const pullRequests = given.pullRequests ?? [];

    if (pullRequests.length === 0) {
      return;
    }

    const defaultBranch = yield* client.defaultBranch(scenario.repo, as);

    for (const pull of pullRequests) {
      const base = Option.getOrElse(Option.fromUndefinedOr(pull.base), () => defaultBranch);

      // The branch is made before the pull request, so cleanup removes it even if opening fails.
      yield* Ref.update(made, (seeded) => ({
        ...seeded,
        pullRequests: [...seeded.pullRequests, { name: pull.name, number: 0, branch: pull.branch }],
      }));

      const number = yield* client.openPullRequest(scenario.repo, base, pull, as);

      yield* Ref.update(made, (seeded) => ({
        ...seeded,
        pullRequests: seeded.pullRequests.map((known) => {
          if (known.branch === pull.branch) {
            return { ...known, number };
          }

          return known;
        }),
      }));
    }
  });

  yield* seeding.pipe(
    Effect.catchTag("ScratchRepoFailed", (error) =>
      Effect.flatMap(Ref.get(made), (seeded) =>
        Effect.fail(new SeedingFailed({ message: error.message, seeded })),
      ),
    ),
  );

  return yield* Ref.get(made);
});
