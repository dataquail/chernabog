// The team's config of a checkout, read from its .chernabog/config.yaml. The
// file is the checkout's, so a read finds it by the root its spec pins.

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import YAML from "yaml";

import { PersistenceFailed } from "../../../../kernel/persistence.errors.ts";
import { pinnedValue, type Specification } from "../../../../kernel/specification.ts";
import { type TeamConfigRoot } from "../../domain/team-config/team-config.root.ts";
import { TeamConfigsRepository } from "../../domain/team-config/team-configs.repository.ts";
import { TeamConfigFile, toRoot } from "./team-config.mapper.ts";

const configOf = (root: string) => `${root}/.chernabog/config.yaml`;

const failed = (root: string, message: string) =>
  new PersistenceFailed({ message: `${configOf(root)}: ${message}` });

export const TeamConfigsRepositoryLive = Layer.effect(
  TeamConfigsRepository,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    // An absent or empty file sets nothing.
    const read = (root: string) =>
      Effect.gen(function* () {
        let text = "{}";

        if (yield* fs.exists(configOf(root))) {
          text = yield* fs.readFileString(configOf(root));
        }

        if (text.trim().length === 0) {
          text = "{}";
        }

        const document = YAML.parseDocument(text);

        if (document.errors.length > 0) {
          return yield* failed(root, document.errors.map((error) => error.message).join("; "));
        }

        const file = yield* Schema.decodeUnknownEffect(TeamConfigFile)(document.toJS() ?? {}, {
          onExcessProperty: "ignore",
        }).pipe(Effect.mapError((issue) => failed(root, issue.message)));

        return toRoot(root, file);
      }).pipe(
        Effect.catchTag("PlatformError", (error) => Effect.fail(failed(root, error.message))),
      );

    // A spec that names no checkout is a bug in its caller: there is no
    // listing of every checkout's config.
    const findOne = (spec: Specification<TeamConfigRoot>) =>
      Option.match(pinnedValue(spec.criteria, "root"), {
        onNone: () => Effect.die(new Error("a team's config is read by its checkout's root")),
        onSome: (root) =>
          read(String(root)).pipe(Effect.map((config) => Option.liftPredicate(config, spec))),
      });

    return TeamConfigsRepository.of({ findOne });
  }),
);
