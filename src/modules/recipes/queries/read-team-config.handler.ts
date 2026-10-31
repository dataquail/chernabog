import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import YAML from "yaml";

import { PersistenceFailed } from "../../../kernel/persistence.errors.ts";
import { TeamConfigFile } from "../storage/team-config.schema.ts";
import { type ReadTeamConfigPayload, TeamConfig } from "./read-team-config.query.ts";

// Read from the checkout's .chernabog/config.yaml itself. An absent or empty
// file says nothing; one that doesn't parse, or holds a key the wrong shape,
// fails naming the file.
export const readTeamConfigHandler = Effect.fn("readTeamConfigHandler")(function* (
  query: ReadTeamConfigPayload,
) {
  const fs = yield* FileSystem.FileSystem;
  const file = `${query.root}/.chernabog/config.yaml`;
  const failed = (message: string) => new PersistenceFailed({ message: `${file}: ${message}` });

  const read = Effect.gen(function* () {
    let text = "{}";

    if (yield* fs.exists(file)) {
      text = yield* fs.readFileString(file);
    }

    if (text.trim().length === 0) {
      text = "{}";
    }

    return text;
  }).pipe(Effect.mapError((error) => failed(error.message)));

  const document = YAML.parseDocument(yield* read);

  if (document.errors.length > 0) {
    return yield* failed(document.errors.map((error) => error.message).join("; "));
  }

  const config = yield* Schema.decodeUnknownEffect(TeamConfigFile)(document.toJS() ?? {}, {
    onExcessProperty: "ignore",
  }).pipe(Effect.mapError((issue) => failed(issue.message)));

  return TeamConfig.make({
    agent: Option.fromUndefinedOr(config.agent),
    runners: Option.fromUndefinedOr(config.runners),
    reviewers: Option.fromUndefinedOr(config.reviewers),
    flows: config.flows ?? {},
  });
});
