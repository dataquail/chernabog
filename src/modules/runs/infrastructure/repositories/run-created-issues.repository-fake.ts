import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { type RunCreatedIssueEntity } from "../../domain/run/run-created-issue.entity.ts";
import { RunCreatedIssuesRepository } from "../../domain/run/run-created-issues.repository.ts";

// The issues runs created, in memory, starting from `created`.
export const RunCreatedIssuesRepositoryFake = (created: ReadonlyArray<RunCreatedIssueEntity>) =>
  Layer.effect(
    RunCreatedIssuesRepository,
    Effect.gen(function* () {
      const store = yield* Ref.make(created);

      return RunCreatedIssuesRepository.of({
        findMany: (spec) => Ref.get(store).pipe(Effect.map((stored) => stored.filter(spec))),
        insertOne: (issue: RunCreatedIssueEntity) =>
          Ref.update(store, (stored) => {
            if (stored.some((each) => each.runId === issue.runId && each.issue === issue.issue)) {
              return stored;
            }

            return [...stored, issue];
          }),
      });
    }),
  );
