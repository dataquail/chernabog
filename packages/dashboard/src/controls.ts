// The controls on each repo that change it, for the persona each belongs to:
// pause and resume on the repo, an on/off switch and a schedule field on each
// flow, and an account picker for each persona and for each of its roles.
// Each says what it shows and, given what the person did, what it asks for
// (settings.ts says what that sends); repos.tsx renders them.

import * as Option from "effect/Option";

import type { PersonaStatus, RepoStatus } from "#daemon/protocol";

import {
  type Attempt,
  type Offered,
  scheduleProblem,
  type Setting,
  typedSchedule,
} from "./settings.ts";

type FlowStatus = RepoStatus["flows"][number];

export type PauseControl = {
  readonly kind: "pause";
  readonly label: string;
  readonly text: string;
  readonly send: () => Attempt;
};

export type SwitchControl = {
  readonly kind: "switch";
  readonly label: string;
  readonly on: boolean;
  readonly send: (on: boolean) => Attempt;
};

export type ScheduleControl = {
  readonly kind: "schedule";
  readonly label: string;
  // The persona's own schedule, and the team's beside it.
  readonly own: Option.Option<string>;
  readonly team: Option.Option<string>;
  readonly send: (text: string) => Attempt;
};

export type AccountControl = {
  readonly kind: "account";
  readonly label: string;
  // The role it picks for; none for the persona's own account.
  readonly role: Option.Option<string>;
  // The persona's pick, if any; none is the default.
  readonly current: Option.Option<string>;
  readonly send: (account: string) => Attempt;
};

export type Control = PauseControl | SwitchControl | ScheduleControl | AccountControl;

const optional = Option.fromUndefinedOr;

const send = (setting: Setting): Attempt => ({ kind: "send", setting });

// How a label names a persona: by login, or as the default.
export const personaName = (persona: Option.Option<string>) =>
  Option.match(persona, { onNone: () => "the default persona", onSome: (login) => `@${login}` });

const pauseText = (paused: boolean) => {
  if (paused) {
    return "resume";
  }

  return "pause";
};

// Pauses the repo if it runs, resumes it if it's paused.
export const pauseControl = (repo: RepoStatus): PauseControl => ({
  kind: "pause",
  label: `${pauseText(repo.paused)} ${repo.name}`,
  text: pauseText(repo.paused),
  send: () => send({ kind: "pause", repo: repo.name, paused: !repo.paused }),
});

// Turns the flow on or off for the persona it runs as.
export const flowSwitch = (repo: RepoStatus, flow: FlowStatus): SwitchControl => ({
  kind: "switch",
  label: `${flow.name} on for ${personaName(optional(flow.persona))}`,
  on: flow.enabled,
  send: (enabled) =>
    send({
      kind: "toggle-flow",
      repo: repo.name,
      persona: optional(flow.persona),
      flow: flow.name,
      enabled,
    }),
});

// Sets the persona's own schedule for the flow, checked as cron before it is
// sent; empty, the team's applies again. A manual flow has none.
export const scheduleField = (repo: RepoStatus, flow: FlowStatus): Option.Option<ScheduleControl> =>
  Option.liftPredicate(
    {
      kind: "schedule",
      label: `${flow.name} schedule for ${personaName(optional(flow.persona))}`,
      own: optional(flow.ownSchedule),
      team: optional(flow.teamSchedule),
      send: (text: string) =>
        Option.match(scheduleProblem(text), {
          onSome: (message): Attempt => ({ kind: "invalid", message }),
          onNone: () =>
            send({
              kind: "set-schedule",
              repo: repo.name,
              persona: optional(flow.persona),
              flow: flow.name,
              schedule: typedSchedule(text),
            }),
        }),
    } satisfies ScheduleControl,
    () => flow.manual !== true,
  );

// Picks the account the persona spends, and one for each of its roles, of
// those machine config offers; "" picks the default again.
export const accountPickers = (
  repo: RepoStatus,
  persona: PersonaStatus,
  offered: Offered,
): ReadonlyArray<AccountControl> => {
  const name = personaName(optional(persona.persona));

  const picker = (
    role: Option.Option<string>,
    current: Option.Option<string>,
    label: string,
  ): AccountControl => ({
    kind: "account",
    label,
    role,
    current,
    send: (account) =>
      send({
        kind: "set-account",
        repo: repo.name,
        persona: optional(persona.persona),
        role,
        account: Option.liftPredicate(account, (picked) => picked !== ""),
        offered,
      }),
  });

  return [
    picker(Option.none(), persona.ownAccount, `account for ${name}`),
    ...persona.roles.map((role) =>
      picker(Option.some(role.role), role.account, `${role.role} account for ${name}`),
    ),
  ];
};

// Every control on a repo.
export const controlsOf = (repo: RepoStatus, offered: Offered): ReadonlyArray<Control> => [
  pauseControl(repo),
  ...repo.flows.flatMap((flow) => [
    flowSwitch(repo, flow),
    ...Option.toArray(scheduleField(repo, flow)),
  ]),
  ...(repo.personas ?? []).flatMap((persona) => accountPickers(repo, persona, offered)),
];
