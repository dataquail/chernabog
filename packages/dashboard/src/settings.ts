// What the page's controls change: a repo paused or resumed, and a persona's
// flow on or off, its schedule and its accounts. Each is one of the commands
// the dashboard's listener lets a browser send (POST /api/commands/:tag,
// DAEMON_COMMAND_LISTENERS.tcp), for the persona the control belongs to; the
// daemon dispatches it on its bus, so every connected page hears of it.
//
// The bodies are the commands' payloads as the daemon decodes them, written
// here because the page can't name the commands themselves (they reach the
// engine); the acceptance test sends these bodies to a real daemon.

import * as Cron from "effect/Cron";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { type DaemonStatus, Refusal } from "#daemon/protocol";

// What machine setup offers a persona: the logins it acts as and the
// accounts its runs spend, which an account's pick is checked against.
export type Offered = {
  readonly personas: ReadonlyArray<string>;
  readonly accounts: ReadonlyArray<{ readonly name: string; readonly agent: string }>;
};

// What the status says machine config offers: the accounts in it, and the
// personas its repos run as.
export const offeredBy = (status: DaemonStatus): Offered => ({
  personas: [
    ...new Set(
      status.repos.flatMap((repo) =>
        (repo.personas ?? []).flatMap((persona) =>
          Option.toArray(Option.fromUndefinedOr(persona.persona)),
        ),
      ),
    ),
  ],
  accounts: status.accounts ?? [],
});

export type Setting =
  | { readonly kind: "pause"; readonly repo: string; readonly paused: boolean }
  | {
      readonly kind: "toggle-flow";
      readonly repo: string;
      readonly persona: Option.Option<string>;
      readonly flow: string;
      readonly enabled: boolean;
    }
  | {
      readonly kind: "set-schedule";
      readonly repo: string;
      readonly persona: Option.Option<string>;
      readonly flow: string;
      // None clears the persona's own, so the team's applies again.
      readonly schedule: Option.Option<string>;
    }
  | {
      readonly kind: "set-account";
      readonly repo: string;
      readonly persona: Option.Option<string>;
      // None picks the persona's own account; a role picks that role's.
      readonly role: Option.Option<string>;
      // None clears the pick, so the default applies again.
      readonly account: Option.Option<string>;
      readonly offered: Offered;
    };

const Maybe = Schema.Option(Schema.String);

const RepoPayload = Schema.Struct({ name: Schema.String });

const FlowPayload = Schema.Struct({
  name: Schema.String,
  persona: Maybe,
  flow: Schema.String,
  enabled: Schema.Boolean,
});

const SchedulePayload = Schema.Struct({
  name: Schema.String,
  persona: Maybe,
  flow: Schema.String,
  schedule: Maybe,
});

const AccountPayload = Schema.Struct({
  name: Schema.String,
  persona: Maybe,
  role: Maybe,
  account: Maybe,
  offered: Schema.Struct({
    personas: Schema.Array(Schema.String),
    accounts: Schema.Array(Schema.Struct({ name: Schema.String, agent: Schema.String })),
  }),
});

const encodeRepo = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(RepoPayload)));
const encodeFlow = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(FlowPayload)));

const encodeSchedule = Schema.encodeSync(
  Schema.fromJsonString(Schema.toCodecJson(SchedulePayload)),
);

const encodeAccount = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(AccountPayload)));

// The command a setting is, by its tag, and its payload as JSON.
export type SettingCommand = { readonly tag: string; readonly body: string };

export const settingCommand = (setting: Setting): SettingCommand => {
  switch (setting.kind) {
    case "pause": {
      const body = encodeRepo({ name: setting.repo });

      if (setting.paused) {
        return { tag: "PauseRepoCommand", body };
      }

      return { tag: "ResumeRepoCommand", body };
    }

    case "toggle-flow":
      return {
        tag: "SetPersonaFlowCommand",
        body: encodeFlow({
          name: setting.repo,
          persona: setting.persona,
          flow: setting.flow,
          enabled: setting.enabled,
        }),
      };
    case "set-schedule":
      return {
        tag: "SetFlowScheduleCommand",
        body: encodeSchedule({
          name: setting.repo,
          persona: setting.persona,
          flow: setting.flow,
          schedule: setting.schedule,
        }),
      };
    case "set-account":
      return {
        tag: "SetPersonaAccountCommand",
        body: encodeAccount({
          name: setting.repo,
          persona: setting.persona,
          role: setting.role,
          account: setting.account,
          offered: setting.offered,
        }),
      };
  }
};

// Why a schedule a person typed isn't a cron expression, if it isn't; an
// empty one clears the persona's own and is fine.
export const scheduleProblem = (text: string): Option.Option<string> => {
  const expression = text.trim();

  if (expression === "") {
    return Option.none();
  }

  return Result.match(Cron.parse(expression), {
    onSuccess: () => Option.none(),
    onFailure: (error) => Option.some(`"${expression}" isn't a schedule: ${error.message}`),
  });
};

// The schedule a person typed, as a setting carries it: none when empty.
export const typedSchedule = (text: string) =>
  Option.liftPredicate(text.trim(), (expression) => expression !== "");

// What a control asks for: a setting to send, or why what the person gave
// can't be sent, as a schedule that isn't cron.
export type Attempt =
  | { readonly kind: "send"; readonly setting: Setting }
  | { readonly kind: "invalid"; readonly message: string };

const pick = (condition: boolean, yes: string, no: string) => {
  if (condition) {
    return yes;
  }

  return no;
};

const who = (persona: Option.Option<string>) =>
  Option.match(persona, { onNone: () => "", onSome: (login) => ` for @${login}` });

// What the page says once the daemon took a setting.
export const describeSetting = (setting: Setting): string => {
  switch (setting.kind) {
    case "pause":
      return `${pick(setting.paused, "paused", "resumed")} ${setting.repo}`;
    case "toggle-flow":
      return `turned ${setting.flow} ${pick(setting.enabled, "on", "off")}${who(setting.persona)} in ${setting.repo}`;
    case "set-schedule":
      return Option.match(setting.schedule, {
        onNone: () =>
          `${setting.flow}${who(setting.persona)} in ${setting.repo} follows the team's schedule`,
        onSome: (cron) =>
          `${setting.flow}${who(setting.persona)} in ${setting.repo} runs on ${cron}`,
      });
    case "set-account": {
      const what = Option.match(setting.role, {
        onNone: () => "the account",
        onSome: (role) => `${role}'s account`,
      });

      return Option.match(setting.account, {
        onNone: () => `${what}${who(setting.persona)} in ${setting.repo} is the default again`,
        onSome: (account) => `${what}${who(setting.persona)} in ${setting.repo} is ${account}`,
      });
    }
  }
};

export const BUSY = "machine config is busy, try again";

// What the page says of the last setting: that the daemon took it, or why not.
export type Notice = { readonly kind: "done" | "problem"; readonly text: string };

export class SettingRefused extends Schema.TaggedError<
  SettingRefused,
  { readonly brand: "SettingRefused" }
>()("SettingRefused", { message: Schema.String }) {}

// What a person reads of a refusal: that a file another process held was
// busy, else the daemon's own reason.
export const refusalMessage = (refusal: Refusal): string => {
  if (refusal.busy === true) {
    return BUSY;
  }

  return refusal.error;
};

const refused = (response: HttpClientResponse.HttpClientResponse) =>
  HttpClientResponse.schemaBodyJson(Refusal)(response).pipe(
    Effect.match({
      onFailure: () => `the daemon answered ${response.status}`,
      onSuccess: refusalMessage,
    }),
    Effect.flatMap((message) => Effect.fail(new SettingRefused({ message }))),
  );

// Sends a setting to the daemon that served the page at `origin`.
export const sendSetting = (
  origin: string,
  setting: Setting,
): Effect.Effect<void, SettingRefused, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const command = settingCommand(setting);

    const request = HttpClientRequest.post(
      new URL(`/api/commands/${encodeURIComponent(command.tag)}`, origin),
    ).pipe(HttpClientRequest.bodyText(command.body, "application/json"));

    const response = yield* HttpClient.execute(request).pipe(
      Effect.mapError(
        () => new SettingRefused({ message: "the daemon didn't answer; is it running?" }),
      ),
    );

    if (response.status >= 200 && response.status < 300) {
      return;
    }

    return yield* refused(response);
  });
