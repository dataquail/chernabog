import {
  DEFAULT_LABELS,
  HEADLESS,
  printJson,
  type RepoSettings,
  Usage as UsageService,
} from "@chernabog/sdk";
import { expect, test } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect, effectAtHomeWith } from "../test/effect-test.ts";
import { fixture } from "../test/fixtures.ts";
import { Home } from "./config.ts";
import { HostEnvironment } from "./platform/environment.ts";
import { execTestLayer } from "./platform/exec.ts";
import { DEFAULT_LIMITS } from "./repo-config.ts";
import { UsageLive } from "./sdk-live.ts";
import {
  checkAccount,
  decideLaunch,
  type GateConfig,
  isExpired,
  keychainServiceFor,
  parseUsageReading,
  readStoredOAuth,
  refreshByRunningClaude,
  runUsageGate,
  UsageResponse,
} from "./usage-gate.ts";

const config: GateConfig = {
  targetEndUsage: 0.95,
  taskCostEstimate: 0.04,
  fiveHourCeiling: 0.4,
  humanRatePerHour: 0.005,
};

const now = DateTime.makeUnsafe("2026-10-15T20:00:00Z");

const recorded = fixture("usage.json", UsageResponse).pipe(
  Effect.flatMap((response) => parseUsageReading(response, now)),
);

type Usage = {
  readonly fiveHour?: number;
  readonly sevenDay?: number;
  readonly sevenDayResetsAt?: string;
};

const reading = (usage: Usage) =>
  parseUsageReading(
    {
      five_hour: { utilization: usage.fiveHour ?? 10, resets_at: "2026-10-15T21:00:00Z" },
      seven_day: {
        utilization: usage.sevenDay ?? 20,
        resets_at: usage.sevenDayResetsAt ?? "2026-10-18T20:00:00Z",
      },
    },
    now,
  );

const launches = (usage: Usage) =>
  reading(usage).pipe(Effect.map((parsed) => decideLaunch(parsed, config, now)));

test("the personal config dir reads its own keychain item, the one Claude Code names after its path", () => {
  expect(keychainServiceFor(Option.some("/Users/dev/.claude-personal"))).toBe(
    "Claude Code-credentials-402de754",
  );
});

effect("the recorded reading, early in the week with little used, launches", () =>
  Effect.gen(function* () {
    const decision = decideLaunch(yield* recorded, config, now);
    expect(decision.launch).toBe(true);
  }),
);

effect("utilization arrives as a percentage and is compared as a fraction", () =>
  Effect.gen(function* () {
    expect((yield* recorded).fiveHour.used).toBe(0.01);
  }),
);

effect("five-hour usage at the ceiling skips, leaving room for interactive work", () =>
  Effect.gen(function* () {
    const decision = yield* launches({ fiveHour: 40 });
    expect(decision.launch).toBe(false);
    expect(decision.reason).toMatch(/five-hour/);
  }),
);

effect("weekly headroom below one task skips", () =>
  Effect.gen(function* () {
    // 0.95 − 0.80 − 0.005 × 72h = −0.21
    expect((yield* launches({ sevenDay: 80 })).launch).toBe(false);
  }),
);

effect("close to the weekly reset, what is left gets used", () =>
  Effect.gen(function* () {
    // 0.95 − 0.80 − 0.005 × 2h = 0.14
    expect(
      (yield* launches({ sevenDay: 80, sevenDayResetsAt: "2026-10-15T22:00:00Z" })).launch,
    ).toBe(true);
  }),
);

effect("headroom exactly equal to the estimate launches despite float error", () =>
  Effect.gen(function* () {
    // 0.95 − 0.55 − 0.005 × 72h = 0.04
    expect((yield* launches({ sevenDay: 55 })).launch).toBe(true);
  }),
);

effect("a reading without a usable window fails loudly", () =>
  Effect.gen(function* () {
    const failed = yield* Effect.flip(reading({ sevenDayResetsAt: "whenever" }));
    expect(failed.message).toMatch(/seven_day/);
  }),
);

effect("a five-hour window not running yet, as when nothing was used in it, launches", () =>
  Effect.gen(function* () {
    const idle = yield* fixture("usage-five-hour-idle.json", UsageResponse).pipe(
      Effect.flatMap((response) => parseUsageReading(response, now)),
    );

    expect(idle.fiveHour.used).toBe(0);
    expect(decideLaunch(idle, config, now).launch).toBe(true);
  }),
);

effect(
  "a weekly window not running yet resets a week from now, so the human allowance covers the whole week",
  () =>
    Effect.gen(function* () {
      const unused = yield* fixture("usage-unused.json", UsageResponse).pipe(
        Effect.flatMap((response) => parseUsageReading(response, now)),
      );

      expect(DateTime.formatIso(unused.sevenDay.resetsAt)).toBe("2026-10-22T20:00:00.000Z");
      // 0.95 − 0 − 0.005 × 168h = 0.11
      expect(decideLaunch(unused, config, now).reason).toMatch(/headroom 0\.110/);
    }),
);

test("a token past its expiry is expired; one without an expiry is trusted", () => {
  const nowMs = DateTime.toEpochMillis(now);
  expect(isExpired({ accessToken: "x", expiresAt: nowMs - 1 }, now)).toBe(true);
  expect(isExpired({ accessToken: "x", expiresAt: nowMs + 60_000 }, now)).toBe(false);
  expect(isExpired({ accessToken: "x" }, now)).toBe(false);
});

const execCalls: Array<string> = [];
let refreshStarted = false;

// The keychain's token turns fresh once a tmux session has started.
const effectRefreshing = effectAtHomeWith(
  execTestLayer((command, args) => {
    execCalls.push([command, ...args.slice(0, 2)].join(" "));

    if (command === "tmux" && args[0] === "new-session") {
      refreshStarted = true;
    }

    let expiresAt = 1;

    if (refreshStarted) {
      expiresAt = 4102444800000;
    }

    if (command === "security") {
      return Option.some({
        exitCode: 0,
        stdout: printJson({ claudeAiOauth: { accessToken: "token", expiresAt } }),
        stderr: "",
      });
    }

    return Option.some({ exitCode: 0, stdout: "", stderr: "" });
  }),
  "darwin",
);

effectRefreshing(
  "under a launcher, an expired token refreshes in a short interactive session, never claude -p",
  () =>
    Effect.gen(function* () {
      const account = {
        name: "personal",
        configDir: Option.some("/Users/dev/.claude-personal"),
        expectedEmail: Option.none<string>(),
        oauthTokenEnv: Option.none<string>(),
        usageGate: "usage" as const,
      };

      yield* refreshByRunningClaude(account, {
        launcher: { ...HEADLESS, name: "tmux", from: "machine config" },
        cwd: "/code/demo",
      });
      expect(execCalls).toContain("tmux new-session -d");
      expect(execCalls).toContain("tmux kill-session -t");
      expect(execCalls.filter((call) => call.startsWith("claude"))).toEqual([]);
    }),
);

// On Linux nothing runs `security`; the login is a file in the config directory.
const effectOnLinux = effectAtHomeWith(
  execTestLayer((command) => {
    if (command === "security") {
      return Option.some({ exitCode: 44, stdout: "", stderr: "security: command not found" });
    }

    return Option.none();
  }),
  "linux",
);

const writeCredentials = (dir: string, contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(`${dir}/.credentials.json`, contents);
  });

effectOnLinux("on Linux, the default account reads ~/.claude/.credentials.json", () =>
  Effect.gen(function* () {
    const home = yield* Home;
    yield* writeCredentials(
      `${home.user}/.claude`,
      printJson({ claudeAiOauth: { accessToken: "linux-token", expiresAt: 4102444800000 } }),
    );

    const account = {
      name: "work",
      configDir: Option.none<string>(),
      expectedEmail: Option.none<string>(),
      oauthTokenEnv: Option.none<string>(),
      usageGate: "usage" as const,
    };

    expect((yield* readStoredOAuth(account)).accessToken).toBe("linux-token");
  }),
);

effectOnLinux(
  "on Linux, an account with its own config directory reads the credentials file there",
  () =>
    Effect.gen(function* () {
      const home = yield* Home;
      const configDir = `${home.user}/.claude-personal`;
      yield* writeCredentials(
        configDir,
        printJson({ claudeAiOauth: { accessToken: "personal-token" } }),
      );

      const account = {
        name: "personal",
        configDir: Option.some(configDir),
        expectedEmail: Option.none<string>(),
        oauthTokenEnv: Option.none<string>(),
        usageGate: "usage" as const,
      };

      expect((yield* readStoredOAuth(account)).accessToken).toBe("personal-token");
    }),
);

effectOnLinux("on Linux, a missing credentials file says to log in", () =>
  Effect.gen(function* () {
    const account = {
      name: "work",
      configDir: Option.none<string>(),
      expectedEmail: Option.none<string>(),
      oauthTokenEnv: Option.none<string>(),
      usageGate: "usage" as const,
    };

    const failed = yield* Effect.flip(readStoredOAuth(account));
    expect(failed.message).toMatch(/\.credentials\.json; run claude auth login/);
  }),
);

effectOnLinux("on Linux, a credentials file without an OAuth login fails loudly", () =>
  Effect.gen(function* () {
    const home = yield* Home;
    yield* writeCredentials(`${home.user}/.claude`, printJson({}));

    const account = {
      name: "work",
      configDir: Option.none<string>(),
      expectedEmail: Option.none<string>(),
      oauthTokenEnv: Option.none<string>(),
      usageGate: "usage" as const,
    };

    const failed = yield* Effect.flip(readStoredOAuth(account));
    expect(failed.message).toMatch(/No claudeAiOauth.accessToken in .*\.credentials\.json/);
  }),
);

// A runner with a token and no login of its own: nothing answers `security`, and `claude auth status` answers with authStatus.
let authStatus = printJson({ loggedIn: true, authMethod: "oauth_token" });

// An HTTP client is there for the gate's types; a test that reaches the usage endpoint fails.
const effectWithToken = effectAtHomeWith(
  Layer.mergeAll(
    FetchHttpClient.layer,
    HostEnvironment.fixed({ PATH: "/usr/bin", CI_CLAUDE_TOKEN: "ci-token" }, "linux"),
    execTestLayer((command, args) => {
      if (command === "claude" && args[0] === "auth") {
        return Option.some({ exitCode: 0, stdout: authStatus, stderr: "" });
      }

      return Option.none();
    }),
  ),
  "linux",
);

const tokenAccount = (variable: string, expectedEmail = Option.none<string>()) => ({
  name: "ci",
  configDir: Option.none<string>(),
  expectedEmail,
  oauthTokenEnv: Option.some(variable),
  usageGate: "usage" as const,
});

effectWithToken(
  "an account with oauthTokenEnv reads its token from that variable, with no expiry to refresh",
  () =>
    Effect.gen(function* () {
      const oauth = yield* readStoredOAuth(tokenAccount("CI_CLAUDE_TOKEN"));
      expect(oauth.accessToken).toBe("ci-token");
      expect(isExpired(oauth, now)).toBe(false);
    }),
);

effectWithToken(
  "a token variable that is not set says how to make one, rather than falling back to a login",
  () =>
    Effect.gen(function* () {
      const failed = yield* Effect.flip(readStoredOAuth(tokenAccount("MISSING_TOKEN")));
      expect(failed.message).toMatch(
        /MISSING_TOKEN, which is not set; claude setup-token makes one/,
      );
    }),
);

effectWithToken(
  "a token account passes the check on Claude saying it is logged in, with no email to show",
  () =>
    Effect.gen(function* () {
      authStatus = printJson({ loggedIn: true, authMethod: "oauth_token" });
      expect(yield* checkAccount(tokenAccount("CI_CLAUDE_TOKEN"))).toBe(
        "a token from CI_CLAUDE_TOKEN",
      );
    }),
);

effectWithToken("a token Claude does not accept fails the check", () =>
  Effect.gen(function* () {
    authStatus = printJson({ loggedIn: false, authMethod: "none" });
    const failed = yield* Effect.flip(checkAccount(tokenAccount("CI_CLAUDE_TOKEN")));
    expect(failed.message).toMatch(/does not accept the ci account's token from CI_CLAUDE_TOKEN/);
  }),
);

effectWithToken("an expectedEmail the token cannot show fails closed", () =>
  Effect.gen(function* () {
    authStatus = printJson({ loggedIn: true, authMethod: "oauth_token" });

    const failed = yield* Effect.flip(
      checkAccount(tokenAccount("CI_CLAUDE_TOKEN", Option.some("dev@example.com"))),
    );

    expect(failed.message).toMatch(/shows no email, not dev@example.com/);
  }),
);

effectWithToken(
  "a token account without usageGate none fails its gate with what to add, since the token cannot read usage",
  () =>
    Effect.gen(function* () {
      const gate = runUsageGate(tokenAccount("CI_CLAUDE_TOKEN"), config, {
        launcher: { ...HEADLESS, name: "headless", from: "machine config" },
        cwd: "/code/demo",
      });

      const failed = yield* Effect.flip(gate);
      expect(failed.message).toMatch(
        /logs in with a token, which cannot read usage; add usageGate: none/,
      );
    }),
);

const repoSettings = (account: RepoSettings["account"]): RepoSettings => ({
  name: "demo",
  slug: "dataquail/demo",
  path: "/code/demo",
  baseBranch: "main",
  account,
  agent: "claude",
  agentAccounts: {},
  launcher: { ...HEADLESS, name: "headless", from: "machine config" },
  flowAgents: {},
  labels: DEFAULT_LABELS,
  install: Option.none(),
  localGate: [],
  humanOnly: [],
  humanOnlyPaths: [],
  notes: [],
  board: Option.none(),
  reviewTrigger: Option.none(),
  limits: DEFAULT_LIMITS,
  env: {},
  configDir: "/code/demo/.chernabog",
});

// The repo's Usage service, as a run sees it. Nothing fakes the usage endpoint, so a reading would fail.
const usageOf = (account: RepoSettings["account"]) =>
  UsageService.use((usage) => Effect.all({ decision: usage.gate, who: usage.checkAccount })).pipe(
    Effect.provide(UsageLive(repoSettings(account), config)),
  );

effectWithToken(
  "usageGate none launches without reading usage, and the account is still checked",
  () =>
    Effect.gen(function* () {
      authStatus = printJson({ loggedIn: true, authMethod: "oauth_token" });

      const { decision, who } = yield* usageOf({
        ...tokenAccount("CI_CLAUDE_TOKEN"),
        usageGate: "none",
      });

      expect(decision).toEqual({
        launch: true,
        reason: "the ci account runs without a usage gate (usageGate: none)",
      });
      expect(who).toBe("a token from CI_CLAUDE_TOKEN");

      const unset = yield* Effect.flip(
        usageOf({ ...tokenAccount("MISSING_TOKEN"), usageGate: "none" }),
      );

      expect(unset.message).toMatch(/MISSING_TOKEN, which is not set/);
    }),
);
