import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { EnrollmentQueries } from "../../../modules/enrollment/enrollment.query-handlers.ts";
import { type TrustOutcome } from "../../../modules/trust/commands/trust-repo.command.ts";
import { TrustCommands } from "../../../modules/trust/trust.command-handlers.ts";
import { daemonReload } from "../../daemon/daemon.client.ts";
import { optionalRepo } from "../repo.arguments.ts";

// What trusting one repo says: what changed, then that it's trusted; or that
// it already was.
const describeTrust = (name: string, outcome: TrustOutcome) =>
  Option.match(outcome.changes, {
    onNone: () => [`${name}: already trusted (${outcome.tree.slice(0, 8)})`],
    onSome: (changes) => [`${name}: ${changes}`, `${name}: trusted ${outcome.tree.slice(0, 8)}`],
  });

// Trusting is a person's approval of the code the daemon will run, so this
// command, and no agent-facing adapter, offers it.
export const trustCommand = Command.make("trust", { repo: optionalRepo }, ({ repo }) =>
  Effect.gen(function* () {
    const { repos } = yield* (yield* EnrollmentQueries).ListEnrolledReposQuery({ name: repo });
    const trust = yield* TrustCommands;
    let changed = false;

    for (const target of repos) {
      const outcome = yield* trust.TrustRepoCommand({
        repo: target.repo,
        path: target.path,
      });

      yield* Effect.forEach(describeTrust(target.name, outcome), (line) => Console.log(line), {
        discard: true,
      });

      if (outcome.trusted) {
        changed = true;
      }
    }

    // The daemon picks up the trusted tree when it reloads.
    if (changed) {
      yield* daemonReload.pipe(Effect.ignore);
    }
  }),
).pipe(
  Command.withDescription(
    ".chernabog/ on a repo's base branch: show what changed since it was last trusted, and trust it",
  ),
);
