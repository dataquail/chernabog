// A checkout's .chernabog/ through git: its tree on the base branch (fetched
// first, or as git has it), and a diff since the tree trusted before.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { Exec, execOk } from "../../../../Exec.ts";
import { configTree } from "../../../../snapshot.ts";
import { ConfigTreeClient } from "../../domain/ports/clients/config-tree.client.ts";
import { ConfigTreeUnavailable } from "../../domain/trust-record/trust-record.errors.ts";

const unavailable = (error: { readonly message: string }) =>
  new ConfigTreeUnavailable({ message: error.message });

const listFiles = (path: string, tree: string) =>
  Effect.gen(function* () {
    const files = yield* execOk("git", ["-C", path, "ls-tree", "-r", "--name-only", tree]);

    return `first trust; .chernabog/ holds:\n${files
      .trim()
      .split("\n")
      .map((file) => `  ${file}`)
      .join("\n")}`;
  });

const diffSince = (path: string, previous: string, tree: string) =>
  Effect.gen(function* () {
    const diff = yield* (yield* Exec).run("git", [
      "-C",
      path,
      "diff",
      "--stat",
      "-p",
      previous,
      tree,
    ]);

    if (diff.exitCode !== 0) {
      return `could not diff ${previous}..${tree} (${diff.stderr.trim()}); review .chernabog/ on the base branch`;
    }

    if (diff.stdout.length === 0) {
      return "no changes";
    }

    return diff.stdout;
  });

export const ConfigTreeClientLive = Layer.effect(
  ConfigTreeClient,
  Effect.gen(function* () {
    const services = yield* Effect.context<Exec>();

    return ConfigTreeClient.of({
      treeOf: (path, baseBranch) =>
        configTree(path, baseBranch).pipe(
          Effect.mapError(unavailable),
          Effect.provideContext(services),
        ),
      localTreeOf: (path, baseBranch) =>
        configTree(path, baseBranch, false).pipe(
          Effect.mapError(unavailable),
          Effect.provideContext(services),
        ),
      changesSince: (path, previous, tree) =>
        Option.match(previous, {
          onNone: () => listFiles(path, tree),
          onSome: (from) => diffSince(path, from, tree),
        }).pipe(Effect.mapError(unavailable), Effect.provideContext(services)),
    });
  }),
);
