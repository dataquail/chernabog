// The controls that change a persona's settings from the page: each sends its
// command, for the persona it belongs to, to POST /api/commands/:tag; a
// schedule is checked as cron first; a busy file says to try again.

import { describe, expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { it } from "effect-bun-test";
import { renderToStaticMarkup } from "react-dom/server";

import { type DaemonStatus, Refusal, type RepoStatus } from "#daemon/protocol";

import { type Control, controlsOf } from "./controls.ts";
import { everything, filtered } from "./filter.ts";
import { initial } from "./live.ts";
import { Overview } from "./overview.tsx";
import { Repos } from "./repos.tsx";
import {
  type Attempt,
  BUSY,
  type Offered,
  offeredBy,
  scheduleProblem,
  sendSetting,
  type Setting,
  settingCommand,
  SettingRefused,
} from "./settings.ts";

const NOW = Date.parse("2026-10-31T12:00:00.000Z");

const offered: Offered = {
  personas: ["bob"],
  accounts: [
    { name: "work", agent: "claude" },
    { name: "codex", agent: "codex" },
  ],
};

const demo: RepoStatus = {
  name: "demo",
  slug: "acme/demo",
  status: "ready",
  message: Option.none(),
  paused: false,
  enabled: true,
  tree: Option.none(),
  launcher: Option.none(),
  flows: [
    {
      name: "implement",
      persona: "bob",
      schedule: "*/5 * * * *",
      teamSchedule: "*/5 * * * *",
      next: Option.none(),
      lastTick: Option.none(),
      enabled: true,
      queued: [],
    },
    {
      name: "review",
      schedule: "0 * * * *",
      teamSchedule: "*/10 * * * *",
      ownSchedule: "0 * * * *",
      next: Option.none(),
      lastTick: Option.none(),
      enabled: false,
      queued: [],
    },
  ],
  personas: [
    {
      persona: "bob",
      account: "work",
      ownAccount: Option.none(),
      roles: [{ role: "reviewer", account: Option.none() }],
    },
    { account: "work", ownAccount: Option.some("work"), roles: [] },
  ],
};

const status: DaemonStatus = {
  pid: 4242,
  startedAt: "2026-10-31T09:00:00.000Z",
  busy: 0,
  reloadPending: false,
  repos: [demo],
  accounts: offered.accounts,
  active: [],
  recent: [],
  skips: [],
};

const controlsIn = (repos: ReadonlyArray<RepoStatus>) =>
  repos.flatMap((repo) => controlsOf(repo, offered));

// The control of a kind a label names, on the repos.
const control = <K extends Control["kind"]>(
  kind: K,
  label: string,
  repos: ReadonlyArray<RepoStatus> = [demo],
) =>
  Option.getOrThrow(
    Arr.findFirst(
      controlsIn(repos),
      (found): found is Extract<Control, { readonly kind: K }> =>
        found.kind === kind && found.label === label,
    ),
  );

const labels = (repos: ReadonlyArray<RepoStatus>) => controlsIn(repos).map((found) => found.label);

const markup = (repos: ReadonlyArray<RepoStatus>) =>
  renderToStaticMarkup(<Repos act={() => {}} enrolled now={NOW} offered={offered} repos={repos} />);

// The command a control's attempt sends and the setting it carries, or why
// it sends nothing.
const commandOf = (attempt: Attempt) => {
  if (attempt.kind === "invalid") {
    return { invalid: attempt.message };
  }

  return { tag: settingCommand(attempt.setting).tag, setting: attempt.setting };
};

const BOB = Option.some("bob");
const NONE = Option.none();

describe("each control", () => {
  test("the switch on a flow turns it on or off for its persona", () => {
    const asked = [
      control("switch", "implement on for @bob").send(false),
      control("switch", "review on for the default persona").send(true),
    ];

    expect(asked.map(commandOf)).toEqual([
      {
        tag: "SetPersonaFlowCommand",
        setting: {
          kind: "toggle-flow",
          repo: "demo",
          persona: BOB,
          flow: "implement",
          enabled: false,
        },
      },
      {
        tag: "SetPersonaFlowCommand",
        setting: {
          kind: "toggle-flow",
          repo: "demo",
          persona: NONE,
          flow: "review",
          enabled: true,
        },
      },
    ]);
    expect(control("switch", "implement on for @bob").on).toBe(true);
    expect(markup([demo])).toContain('aria-label="implement on for @bob" checked=""');
    expect(markup([demo])).not.toContain('aria-label="review on for the default persona" checked');
  });

  test("the schedule field sets the persona's own on enter, and empty goes back to the team's", () => {
    const asked = [
      control("schedule", "implement schedule for @bob").send(" 0 9 * * 1-5 "),
      control("schedule", "review schedule for the default persona").send(""),
    ];

    expect(asked.map(commandOf)).toEqual([
      {
        tag: "SetFlowScheduleCommand",
        setting: {
          kind: "set-schedule",
          repo: "demo",
          persona: BOB,
          flow: "implement",
          schedule: Option.some("0 9 * * 1-5"),
        },
      },
      {
        tag: "SetFlowScheduleCommand",
        setting: {
          kind: "set-schedule",
          repo: "demo",
          persona: NONE,
          flow: "review",
          schedule: NONE,
        },
      },
    ]);
  });

  test("the schedule field checks cron before sending anything", () => {
    const asked = control("schedule", "implement schedule for @bob").send("every tuesday");

    expect(commandOf(asked)).toEqual({
      invalid: scheduleProblem("every tuesday").pipe(Option.getOrThrow),
    });
    expect(Option.getOrElse(scheduleProblem("every tuesday"), () => "")).toContain(
      `"every tuesday" isn't a schedule`,
    );
  });

  test("the schedule field shows the team's schedule beside the persona's own", () => {
    const page = markup([demo]);

    expect(page).toContain("team <code>*/10 * * * *</code>, own <code>0 * * * *</code>");
    expect(page).toContain('placeholder="*/10 * * * *"');
    expect(page).toContain('value="0 * * * *"');
  });

  test("the account pickers pick for the persona, and for each of its roles", () => {
    const asked = [
      control("account", "account for @bob").send("codex"),
      control("account", "reviewer account for @bob").send("codex"),
      control("account", "account for the default persona").send(""),
    ];

    expect(asked.map(commandOf)).toEqual([
      {
        tag: "SetPersonaAccountCommand",
        setting: {
          kind: "set-account",
          repo: "demo",
          persona: BOB,
          role: NONE,
          account: Option.some("codex"),
          offered,
        },
      },
      {
        tag: "SetPersonaAccountCommand",
        setting: {
          kind: "set-account",
          repo: "demo",
          persona: BOB,
          role: Option.some("reviewer"),
          account: Option.some("codex"),
          offered,
        },
      },
      {
        tag: "SetPersonaAccountCommand",
        setting: {
          kind: "set-account",
          repo: "demo",
          persona: NONE,
          role: NONE,
          account: NONE,
          offered,
        },
      },
    ]);
    expect(control("account", "account for the default persona").current).toEqual(
      Option.some("work"),
    );
  });

  test("pause and resume on each repo", () => {
    const repos = [demo, { ...demo, name: "api", paused: true }];

    const asked = [
      control("pause", "pause demo", repos).send(),
      control("pause", "resume api", repos).send(),
    ];

    expect(asked.map(commandOf)).toEqual([
      { tag: "PauseRepoCommand", setting: { kind: "pause", repo: "demo", paused: true } },
      { tag: "ResumeRepoCommand", setting: { kind: "pause", repo: "api", paused: false } },
    ]);
  });

  test("filtered to a persona, shows only its own flows and accounts to change", () => {
    const shown = filtered(status, { ...everything, persona: Option.some("bob") });

    expect(labels(shown.repos)).toEqual([
      "pause demo",
      "implement on for @bob",
      "implement schedule for @bob",
      "account for @bob",
      "reviewer account for @bob",
    ]);
  });

  test("each renders on the page, under the label it is found by", () => {
    const page = markup([demo]);

    for (const label of labels([demo])) {
      expect(page).toContain(`aria-label="${label}"`);
    }
  });

  test("a manual flow has no schedule to set", () => {
    const manual = { ...demo, flows: [{ ...demo.flows[0], manual: true }] };

    expect(labels([manual])).not.toContain("implement schedule for @bob");
  });

  test("the account pickers are checked against what the status says machine config offers", () => {
    expect(offeredBy(status)).toEqual(offered);
  });
});

// The acceptance test sends these same bodies to a real daemon
// (test/acceptance/dashboard.test.ts), which decodes each with its command's
// own schema.
describe("a setting's command", () => {
  test("carries the persona, as the daemon decodes it", () => {
    const bob = Option.some("bob");

    const settings: ReadonlyArray<Setting> = [
      { kind: "pause", repo: "nope", paused: true },
      { kind: "pause", repo: "nope", paused: false },
      { kind: "toggle-flow", repo: "nope", persona: bob, flow: "implement", enabled: false },
      {
        kind: "set-schedule",
        repo: "nope",
        persona: bob,
        flow: "implement",
        schedule: Option.some("0 9 * * 1-5"),
      },
      {
        kind: "set-account",
        repo: "nope",
        persona: bob,
        role: Option.some("reviewer"),
        account: Option.some("work"),
        offered: { personas: ["bob"], accounts: [{ name: "work", agent: "claude" }] },
      },
    ];

    expect(settings.map(settingCommand)).toEqual([
      { tag: "PauseRepoCommand", body: '{"name":"nope"}' },
      { tag: "ResumeRepoCommand", body: '{"name":"nope"}' },
      {
        tag: "SetPersonaFlowCommand",
        body: '{"name":"nope","persona":{"_tag":"Some","value":"bob"},"flow":"implement","enabled":false}',
      },
      {
        tag: "SetFlowScheduleCommand",
        body: '{"name":"nope","persona":{"_tag":"Some","value":"bob"},"flow":"implement","schedule":{"_tag":"Some","value":"0 9 * * 1-5"}}',
      },
      {
        tag: "SetPersonaAccountCommand",
        body: '{"name":"nope","persona":{"_tag":"Some","value":"bob"},"role":{"_tag":"Some","value":"reviewer"},"account":{"_tag":"Some","value":"work"},"offered":{"personas":["bob"],"accounts":[{"name":"work","agent":"claude"}]}}',
      },
    ]);
  });
});

type Sent = {
  readonly method: string;
  readonly url: string;
  readonly type: string;
  readonly body: string;
};

// A daemon that answers every request with `reply`, and what it was sent.
const daemonAnswering = (reply: () => Response) => {
  const asked: Array<Sent> = [];

  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const { body } = request;

      if (Predicate.isTagged(body, "Uint8Array")) {
        asked.push({
          method: request.method,
          url: url.href,
          type: body.contentType,
          body: new TextDecoder().decode(body.body),
        });
      }

      return HttpClientResponse.fromWeb(request, reply());
    }),
  );

  return { asked, client };
};

const sendTo = (daemon: ReturnType<typeof daemonAnswering>, setting: Setting) =>
  sendSetting("http://127.0.0.1:4848", setting).pipe(
    Effect.provideService(HttpClient.HttpClient, daemon.client),
  );

const toggle: Setting = {
  kind: "toggle-flow",
  repo: "demo",
  persona: Option.some("bob"),
  flow: "implement",
  enabled: false,
};

const encodeRefusal = Schema.encodeSync(Schema.fromJsonString(Refusal));

const refusing = (refusal: Refusal) => () =>
  new Response(encodeRefusal(refusal), {
    status: 422,
    headers: { "content-type": "application/json" },
  });

describe("sending a setting", () => {
  it.live("POSTs its command's payload, as JSON, to the dashboard's /api/commands/:tag", () =>
    Effect.gen(function* () {
      const daemon = daemonAnswering(() => new Response("{}", { status: 200 }));

      yield* sendTo(daemon, toggle);

      expect(daemon.asked).toEqual([
        {
          method: "POST",
          url: "http://127.0.0.1:4848/api/commands/SetPersonaFlowCommand",
          type: "application/json",
          body: settingCommand(toggle).body,
        },
      ]);
    }),
  );

  it.live("a file another process holds says machine config is busy, try again", () =>
    Effect.gen(function* () {
      const daemon = daemonAnswering(
        refusing({
          error: "config.yaml is being changed by pid 7 (editing machine config)",
          tag: "PersistenceFailed",
          busy: true,
        }),
      );

      const refused = yield* Effect.flip(sendTo(daemon, toggle));

      expect(refused).toEqual(new SettingRefused({ message: BUSY }));
    }),
  );

  it.live("any other refusal says the daemon's reason", () =>
    Effect.gen(function* () {
      const daemon = daemonAnswering(
        refusing({
          error: "config.yaml doesn't parse",
          tag: "PersistenceFailed",
        }),
      );

      const refused = yield* Effect.flip(sendTo(daemon, toggle));

      expect(refused.message).toBe("config.yaml doesn't parse");
    }),
  );
});

describe("the page says", () => {
  const page = (notice: Parameters<typeof Overview>[0]["notice"]) =>
    renderToStaticMarkup(
      <Overview
        act={() => {}}
        notice={notice}
        live={{ ...initial, connection: { kind: "live" }, status: Option.some(status) }}
        filter={everything}
        selected={Option.none()}
        now={NOW}
        onFilter={() => {}}
      />,
    );

  test("why a setting wasn't made", () => {
    expect(page(Option.some({ kind: "problem", text: BUSY }))).toContain(
      `role="alert">${BUSY}</p>`,
    );
  });

  test("that the daemon took one", () => {
    expect(page(Option.some({ kind: "done", text: "paused demo" }))).toContain(
      'role="status">paused demo</p>',
    );
  });
});
