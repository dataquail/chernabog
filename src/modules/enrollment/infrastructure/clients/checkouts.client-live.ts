// A checkout through git (its root, its origin on GitHub and the branch
// origin calls HEAD) and its working copy's .chernabog/ (the flows it has,
// and what the team's config.yaml says of them).

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { RepoSlug } from "../../../../kernel/repo-slug.id.ts";
import { Exec, execOk } from "../../../../platform/exec.ts";
import { flowNames } from "../../../../platform/flow-loader.ts";
import { readYaml, RepoConfigFile } from "../../../../repo-config.ts";
import { Checkout } from "../../domain/enrolled-repo/checkout.value-object.ts";
import { CheckoutUnreadable } from "../../domain/enrolled-repo/enrolled-repo.errors.ts";
import { TeamFlows } from "../../domain/enrolled-repo/team-flows.value-object.ts";
import { CheckoutsClient } from "../../domain/ports/clients/checkouts.client.ts";

// owner/name of a remote on GitHub, from an https or ssh URL.
export const slugFromRemote = (url: string) =>
  Option.map(
    Option.fromNullishOr(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim())),
    (match) => match[1],
  );

const unreadable = (error: { readonly message: string }) =>
  new CheckoutUnreadable({ message: error.message });

const teamOf = (file: RepoConfigFile) =>
  TeamFlows.make({
    agent: Option.fromUndefinedOr(file.agent),
    runners: Option.fromUndefinedOr(file.runners),
    ...Option.match(Option.fromUndefinedOr(file.reviewers), {
      onNone: () => ({}),
      onSome: (reviewers) => ({ reviewers }),
    }),
    flows: Object.fromEntries(
      Object.entries(file.flows ?? {}).map(([flow, settings]) => [
        flow,
        {
          ...Option.match(Option.fromUndefinedOr(settings.enabled), {
            onNone: () => ({}),
            onSome: (enabled) => ({ enabled }),
          }),
          ...Option.match(Option.fromUndefinedOr(settings.agent), {
            onNone: () => ({}),
            onSome: (agent) => ({ agent }),
          }),
          ...Option.match(Option.fromUndefinedOr(settings.agents), {
            onNone: () => ({}),
            onSome: (agents) => ({ agents }),
          }),
          ...Option.match(Option.fromUndefinedOr(settings.runners), {
            onNone: () => ({}),
            onSome: (runners) => ({ runners }),
          }),
        },
      ]),
    ),
  });

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

        const head = yield* (yield* Exec)
          .run("git", ["-C", root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
          .pipe(
            Effect.map((result) =>
              Option.getOrElse(
                Option.liftPredicate(result.stdout.trim(), () => result.exitCode === 0),
                () => "origin/main",
              ),
            ),
          );

        return Checkout.make({
          root,
          repo: RepoSlug.make(slug),
          baseBranch: head.replace(/^origin\//, ""),
          flows: yield* flowNames(`${root}/.chernabog`),
          team: teamOf(yield* readYaml(RepoConfigFile, `${root}/.chernabog/config.yaml`)),
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
