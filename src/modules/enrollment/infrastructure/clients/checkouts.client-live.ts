// A checkout through git (its root and its origin on GitHub) and its working
// copy's .chernabog/ (the flows it has). The team's config.yaml is the recipes
// module's, which enrollment asks through TeamFlowsAcl.

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { RepoSlug } from "../../../../kernel/repo-slug.id.ts";
import { type Exec, execOk } from "../../../../platform/exec.ts";
import { flowNames } from "../../../../platform/flow-loader.ts";
import { CheckoutTree } from "../../domain/enrolled-repo/checkout.value-object.ts";
import { CheckoutUnreadable } from "../../domain/enrolled-repo/enrolled-repo.errors.ts";
import { CheckoutsClient } from "../../domain/ports/clients/checkouts.client.ts";

// owner/name of a remote on GitHub, from an https or ssh URL.
export const slugFromRemote = (url: string) =>
  Option.map(
    Option.fromNullishOr(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim())),
    (match) => match[1],
  );

const unreadable = (error: { readonly message: string }) =>
  new CheckoutUnreadable({ message: error.message });

export const CheckoutsClientLive = Layer.effect(
  CheckoutsClient,
  Effect.gen(function* () {
    const services = yield* Effect.context<Exec | FileSystem.FileSystem>();

    const rootOf = (path: string) =>
      execOk("git", ["-C", path, "rev-parse", "--show-toplevel"]).pipe(
        Effect.map((root) => root.trim()),
        Effect.mapError(unreadable),
        Effect.provideContext(services),
      );

    const inspect = (root: string) =>
      Effect.gen(function* () {
        const remote = yield* execOk("git", ["-C", root, "remote", "get-url", "origin"]);

        const slug = yield* Effect.fromOption(slugFromRemote(remote)).pipe(
          Effect.mapError(
            () =>
              new CheckoutUnreadable({
                message: `${root}: origin (${remote.trim()}) is not a GitHub repo`,
              }),
          ),
        );

        return CheckoutTree.make({
          root,
          repo: RepoSlug.make(slug),
          flows: yield* flowNames(`${root}/.chernabog`),
        });
      }).pipe(Effect.mapError(unreadable), Effect.provideContext(services));

    const exists = (path: string) =>
      FileSystem.FileSystem.use((fs) => fs.exists(path)).pipe(
        Effect.orElseSucceed(() => true),
        Effect.provideContext(services),
      );

    return CheckoutsClient.of({ rootOf, inspect, exists });
  }),
);
