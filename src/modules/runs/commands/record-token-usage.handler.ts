import { EventBus } from "@effect-server-utils/cqrs";
import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { TokenUsageRecorded } from "../domain/token-usage/token-usage.events.ts";
import { TokenUsageRoot } from "../domain/token-usage/token-usage.root.ts";
import { TokenUsagesRepository } from "../domain/token-usage/token-usages.repository.ts";
import { TokenUsageCursorRoot } from "../domain/token-usage-cursor/token-usage-cursor.root.ts";
import { TokenUsageCursorsRepository } from "../domain/token-usage-cursor/token-usage-cursors.repository.ts";
import { type RecordTokenUsagePayload } from "./record-token-usage.command.ts";

// The rows and the cursor commit together, so a crash between them leaves the
// cursor where it was, and the next read of the session picks the call up.
export const recordTokenUsageHandler = Effect.fn("recordTokenUsageHandler")(
  function* ({ adapter, reading, runId, sessionId, step }: RecordTokenUsagePayload) {
    const recordedAt = DateTime.formatIso(yield* DateTime.now);
    const call = { runId, step, adapter, sessionId, recordedAt };

    const rows = Option.match(reading, {
      onNone: () => [
        TokenUsageRoot.make({
          ...call,
          model: Option.none(),
          input: Option.none(),
          output: Option.none(),
          cacheRead: Option.none(),
          cacheWrite: Option.none(),
          reported: false,
        }),
      ],
      onSome: (read) =>
        read.records.map((record) =>
          TokenUsageRoot.make({
            ...call,
            ...record,
            model: Option.some(record.model),
            reported: true,
          }),
        ),
    });

    yield* (yield* TokenUsagesRepository).insertMany(rows);

    for (const read of Option.toArray(reading)) {
      yield* (yield* TokenUsageCursorsRepository).upsertOne(
        TokenUsageCursorRoot.make({ adapter, sessionId, cursor: read.cursor }),
      );
    }

    yield* (yield* EventBus).dispatch([
      TokenUsageRecorded.make({
        eventId: `${runId}:usage:${adapter}:${sessionId}:${recordedAt}`,
        ...call,
        reported: Option.isSome(reading),
      }),
    ]);
  },
  withUnitOfWork,
  // state.db is a file on this machine: it has no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
