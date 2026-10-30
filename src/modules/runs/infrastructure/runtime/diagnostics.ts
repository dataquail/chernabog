// What a repo's flows tell `chernabog doctor` beyond what it checks itself:
// each flow's doctor checks (defineFlow({ doctor })), run as each of the
// repo's personas on this machine with that persona's settings. The binary
// knows no flow; a flow that contributes no checks gets no warnings.

import { type Flow, Repo, Settings, type Warning } from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type Persona } from "../../../../kernel/persona.value-object.ts";
import { type EffectiveRepo, flowOff, flowSettingsInput } from "../../../../repo-config.ts";

// A warning a flow's check gave, and the persona it ran as.
export type FlowWarning = { readonly persona: Persona; readonly warning: Warning };

// The warnings the repo's flows give as its personas, each once: a warning
// two personas give alike is said for the first. `personas` are the logins
// this machine acts as, and `loginOf` who a persona is on GitHub, which for
// the implicit one only gh can say.
export const flowWarnings = <R>(
  repo: EffectiveRepo,
  flows: ReadonlyMap<string, Flow>,
  personas: ReadonlyArray<string>,
  loginOf: (persona: Persona) => Effect.Effect<Option.Option<string>, never, R>,
) =>
  Effect.gen(function* () {
    const found: Array<FlowWarning> = [];

    // Each flow, the logins here that run it in this repo, and its checks.
    const all = [...flows].map(([name, flow]) => ({
      name,
      runners: repo.personas
        .filter((own) => Option.isNone(flowOff(own, name)))
        .flatMap((own) => Option.toArray(own.persona)),
      doctor: flow.doctor ?? [],
    }));

    for (const { doctor: checks, name } of all) {
      if (checks.length === 0) {
        continue;
      }

      for (const own of repo.personas) {
        const context = {
          flow: name,
          personas,
          login: yield* loginOf(own.persona),
          runs: Option.isNone(flowOff(own, name)),
          flows: all,
        };

        for (const check of checks) {
          const warnings = yield* check(context).pipe(
            Effect.provideService(Repo, own.settings),
            Effect.provideService(Settings.FlowSettings, { input: flowSettingsInput(own, name) }),
          );

          for (const warning of warnings) {
            found.push({ persona: own.persona, warning });
          }
        }
      }
    }

    return Arr.dedupeWith(
      found,
      (left, right) =>
        left.warning.warning === right.warning.warning && left.warning.fix === right.warning.fix,
    );
  });
