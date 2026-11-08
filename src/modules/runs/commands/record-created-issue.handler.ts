import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { RunCreatedIssueEntity } from "../domain/run/run-created-issue.entity.ts";
import { RunCreatedIssuesRepository } from "../domain/run/run-created-issues.repository.ts";
import { type RecordCreatedIssuePayload } from "./record-created-issue.command.ts";

export const recordCreatedIssueHandler = Effect.fn("recordCreatedIssueHandler")(
  function* ({ issue, runId }: RecordCreatedIssuePayload) {
    const createdAt = DateTime.formatIso(yield* DateTime.now);

    yield* (yield* RunCreatedIssuesRepository).insertOne(
      RunCreatedIssueEntity.make({ runId, issue, createdAt }),
    );
  },
  withUnitOfWork,
  // state.db is a file on this machine: it has no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
