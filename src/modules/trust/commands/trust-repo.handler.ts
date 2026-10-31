import { EventBus } from "@effect-server-utils/cqrs";
import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ConfigTreeClient } from "../domain/ports/clients/config-tree.client.ts";
import { TrustRecordsRepository } from "../domain/ports/repositories/trust-records.repository.ts";
import { TrustEvents } from "../domain/trust-record/trust-record.events.ts";
import { TrustRecordRootOps } from "../domain/trust-record/trust-record.root-ops.ts";
import { TrustOutcome, type TrustRepoPayload } from "./trust-repo.command.ts";

export const trustRepoHandler = Effect.fn("trustRepoHandler")(
  function* (cmd: TrustRepoPayload) {
    const records = yield* TrustRecordsRepository;
    const trees = yield* ConfigTreeClient;
    const tree = yield* trees.treeOf(cmd.path);
    const record = yield* records.findOne(cmd.repo);
    const previous = Option.map(record, (found) => found.tree);

    const approved = TrustRecordRootOps.approve(
      record,
      cmd.repo,
      tree,
      DateTime.formatIso(yield* DateTime.now),
    );

    if (Option.isNone(approved)) {
      return TrustOutcome.make({
        repo: cmd.repo,
        tree,
        previous,
        changes: Option.none(),
        trusted: false,
      });
    }

    const changes = yield* trees.changesSince(cmd.path, previous, tree);
    yield* records.save(approved.value);
    yield* (yield* EventBus).dispatch([TrustEvents.trusted(approved.value, previous)]);

    return TrustOutcome.make({
      repo: cmd.repo,
      tree,
      previous,
      changes: Option.some(changes),
      trusted: true,
    });
  },
  withUnitOfWork,
  // Its stores are files on this machine: they have no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
