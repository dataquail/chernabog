// Decides whether a Claude subscription has room for one more autonomous task
// this week. Each account (work `claude`, personal `pclaude`) has its own quota.

import { createHash } from 'node:crypto';

import { type Account, type ResolvedLauncher, UsageError } from '@chernabog/sdk';
import * as Config from 'effect/Config';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as Option from 'effect/Option';
import * as Schedule from 'effect/Schedule';
import * as Schema from 'effect/Schema';

import { API_KEYS } from './agents/adapter.ts';
import { CLAUDE_OAUTH_TOKEN, claudeHomeOf, claudeTokenOf, claudeTokenVariables, Home, homePaths } from './config.ts';
import { execOk } from './Exec.ts';
import { type Launcher, launcherFor } from './launchers.ts';
import { LaunchSpecJson } from './launchers/shim.ts';
import { type Environment, HostEnvironment, withVariables } from './platform/environment.ts';
import { selfCommand } from './self.ts';

export type GateConfig = {
  readonly targetEndUsage: number;
  readonly taskCostEstimate: number;
  readonly fiveHourCeiling: number;
  readonly humanRatePerHour: number;
};

type UsageWindow = { readonly used: number; readonly resetsAt: DateTime.Utc };

export type UsageReading = { readonly fiveHour: UsageWindow; readonly sevenDay: UsageWindow };

export type LaunchDecision = { readonly launch: boolean; readonly reason: string };

export { UsageError };

const HOUR_MS = 60 * 60 * 1000;
const FLOAT_TOLERANCE = 1e-9;

// Claude Code keeps each CLAUDE_CONFIG_DIR's login in its own keychain item,
// named after a hash of the directory, so the work and personal logins never mix.
export const keychainServiceFor = (configDir: Option.Option<string>) =>
  Option.match(configDir, {
    onNone: () => 'Claude Code-credentials',
    onSome: (dir) => `Claude Code-credentials-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`,
  });

// The environment `claude` runs with for an account: its config directory, or
// none for the default one, and a token only when the account has its own, so
// a token left in the shell never logs in another account.
export const accountEnv = (account: Account, base: Environment) => {
  const withoutToken = withVariables(base, {}, [CLAUDE_OAUTH_TOKEN]);

  const env = Option.match(account.configDir, {
    onNone: () => withVariables(withoutToken, {}, ['CLAUDE_CONFIG_DIR']),
    onSome: (dir) => withVariables(withoutToken, { CLAUDE_CONFIG_DIR: dir }, []),
  });

  return { ...env, ...claudeTokenVariables(account, base) };
};

// One window of the usage endpoint's answer, as it arrives: utilization in
// percent. No reset time means no window is running: nothing used since the
// last one ended.
const UsageWindowWire = Schema.Struct({ utilization: Schema.Finite, resets_at: Schema.NullOr(Schema.String) });

export const UsageResponse = Schema.Struct({ five_hour: UsageWindowWire, seven_day: UsageWindowWire });

export type UsageResponse = typeof UsageResponse.Type;

// A window that is not running yet starts with the next use, so it resets a whole window from now.
const toWindow = (wire: typeof UsageWindowWire.Type, name: string, length: Partial<DateTime.DateTime.PartsForMath>, now: DateTime.Utc) =>
  Option.match(Option.fromNullishOr(wire.resets_at), {
    onNone: () => Effect.succeed({ used: wire.utilization / 100, resetsAt: DateTime.add(now, length) }),
    onSome: (resetsAt) =>
      Option.match(DateTime.make(resetsAt), {
        onNone: () => Effect.fail(new UsageError({ message: `Usage reading has no usable ${name} window: ${resetsAt}` })),
        onSome: (parsed) => Effect.succeed({ used: wire.utilization / 100, resetsAt: DateTime.toUtc(parsed) }),
      }),
  });

export const parseUsageReading = (response: UsageResponse, now: DateTime.Utc) =>
  Effect.all({ fiveHour: toWindow(response.five_hour, 'five_hour', { hours: 5 }, now), sevenDay: toWindow(response.seven_day, 'seven_day', { days: 7 }, now) });

export const decideLaunch = (reading: UsageReading, config: GateConfig, now: DateTime.Utc): LaunchDecision => {
  if (reading.fiveHour.used >= config.fiveHourCeiling) {
    return { launch: false, reason: `five-hour usage ${reading.fiveHour.used} is at or over the ${config.fiveHourCeiling} ceiling` };
  }

  const hoursUntilWeeklyReset = Math.max(0, (DateTime.toEpochMillis(reading.sevenDay.resetsAt) - DateTime.toEpochMillis(now)) / HOUR_MS);
  const remainingBudget = config.targetEndUsage - reading.sevenDay.used;
  const expectedHumanUse = config.humanRatePerHour * hoursUntilWeeklyReset;
  const headroom = remainingBudget - expectedHumanUse;
  const summary = `weekly headroom ${headroom.toFixed(3)} (budget ${remainingBudget.toFixed(3)} − human ${expectedHumanUse.toFixed(3)} over ${hoursUntilWeeklyReset.toFixed(1)}h)`;

  if (headroom + FLOAT_TOLERANCE < config.taskCostEstimate) {
    return { launch: false, reason: `${summary} is below the ${config.taskCostEstimate} task estimate` };
  }

  return { launch: true, reason: `${summary} covers the ${config.taskCostEstimate} task estimate` };
};

const StoredOAuth = Schema.Struct({ accessToken: Schema.String, expiresAt: Schema.optionalKey(Schema.Finite) });

export type StoredOAuth = typeof StoredOAuth.Type;

// What Claude Code stores for a login, in the keychain item or the credentials file.
const StoredCredentials = Schema.fromJsonString(Schema.Struct({ claudeAiOauth: StoredOAuth }));

export const isExpired = (oauth: StoredOAuth, now: DateTime.Utc) => Option.exists(Option.fromUndefinedOr(oauth.expiresAt), (expiresAt) => expiresAt < DateTime.toEpochMillis(now));

const usageError = (error: { readonly message: string }) => new UsageError({ message: error.message });

const tokenUnset = (name: string, variable: string) => new UsageError({ message: `the ${name} account takes its token from ${variable}, which is not set; claude setup-token makes one` });

const decodeStored = (stored: string, where: string) =>
  Schema.decodeEffect(StoredCredentials)(stored.trim()).pipe(
    Effect.map((item) => item.claudeAiOauth),
    Effect.mapError(() => new UsageError({ message: `No claudeAiOauth.accessToken in ${where}` })),
  );

// An account with its own token reads only its variable: a token from
// `claude setup-token`, which carries no expiry and never refreshes. Otherwise
// the login is in the keychain on macOS, and elsewhere in .credentials.json in
// the config directory.
export const readStoredOAuth = (account: Account) =>
  Effect.gen(function* () {
    const host = yield* HostEnvironment;

    if (Option.isSome(account.oauthTokenEnv)) {
      const variable = account.oauthTokenEnv.value;
      const token = yield* Effect.fromOption(claudeTokenOf(account, host.variables)).pipe(Effect.mapError(() => tokenUnset(account.name, variable)));

      return { accessToken: token } satisfies StoredOAuth;
    }

    if (host.platform === 'darwin') {
      const service = keychainServiceFor(account.configDir);

      return yield* decodeStored(yield* execOk('security', ['find-generic-password', '-s', service, '-w']), `keychain item "${service}"`);
    }

    const file = `${claudeHomeOf(account, (yield* Home).user)}/.credentials.json`;
    const stored = yield* (yield* FileSystem.FileSystem).readFileString(file).pipe(Effect.mapError(() => new UsageError({ message: `No Claude login in ${file}; run claude auth login` })));

    return yield* decodeStored(stored, file);
  });

// How the token gets refreshed: under the repo's launcher, in its checkout,
// where Claude already trusts the folder.
export type TokenRefresh = { readonly launcher: ResolvedLauncher; readonly cwd: string };

const REFRESH_PROMPT = 'Reply with OK.';

const tokenRefreshed = (account: Account) =>
  Effect.gen(function* () {
    const oauth = yield* readStoredOAuth(account);

    return !isExpired(oauth, yield* DateTime.now);
  }).pipe(Effect.orElseSucceed(() => false));

// The same one-line prompt as an ordinary session, closed once the token is fresh.
const refreshInteractively = (account: Account, launcher: Launcher, cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* Home;
    const host = yield* HostEnvironment;
    const dir = `${homePaths(home.root).sessions}/refresh-${account.name}`;
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(`${dir}/prompt.md`, REFRESH_PROMPT);
    const env = withVariables(accountEnv(account, host.variables), {}, API_KEYS);
    const spec = yield* Schema.encodeEffect(LaunchSpecJson)({ command: 'claude', args: ['--model', 'haiku', '--permission-mode', 'auto'], cwd, env, promptFile: `${dir}/prompt.md` });
    yield* fs.writeFileString(`${dir}/spec.json`, spec);
    const handle = yield* launcher.start({ title: `chernabog-refresh-${account.name}`, cwd, command: [...selfCommand(), '__launch', `${dir}/spec.json`] });

    yield* tokenRefreshed(account).pipe(
      Effect.repeat({ schedule: Schedule.spaced('2 seconds'), until: (fresh) => fresh }),
      Effect.timeout('2 minutes'),
      Effect.ignore,
      Effect.ensuring(Effect.ignore(launcher.close(handle))),
    );
  }).pipe(Effect.mapError((error) => new UsageError({ message: `refreshing the ${account.name} token in ${launcher.name}: ${error.message}` })));

// The stored token only refreshes when claude itself runs. A one-line prompt on
// the cheapest model is the smallest thing that makes it do so: headless as
// `claude -p`, else as a short session under the repo's launcher.
export const refreshByRunningClaude = (account: Account, refresh: TokenRefresh) =>
  Option.match(launcherFor(refresh.launcher), {
    onSome: (launcher) => refreshInteractively(account, launcher, refresh.cwd),
    onNone: () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* Home;
        const host = yield* HostEnvironment;
        yield* fs.makeDirectory(home.root, { recursive: true });
        yield* execOk('claude', ['-p', REFRESH_PROMPT, '--model', 'haiku'], { cwd: home.root, env: accountEnv(account, host.variables), timeout: '2 minutes' });
      }).pipe(Effect.mapError(usageError)),
  });

const freshAccessToken = (account: Account, refresh: TokenRefresh) =>
  Effect.gen(function* () {
    const oauth = yield* readStoredOAuth(account);

    if (!isExpired(oauth, yield* DateTime.now)) return oauth.accessToken;

    yield* refreshByRunningClaude(account, refresh);
    const refreshed = yield* readStoredOAuth(account);

    if (isExpired(refreshed, yield* DateTime.now)) {
      return yield* new UsageError({ message: `The ${account.name} account's OAuth token is expired and did not refresh; open a session with it once` });
    }

    return refreshed.accessToken;
  });

const fetchUsage = (accessToken: string) =>
  Effect.gen(function* () {
    // CHERNABOG_USAGE_URL points at a test server.
    const url = yield* Config.String('CHERNABOG_USAGE_URL').pipe(Config.withDefault('https://api.anthropic.com/api/oauth/usage'));
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const request = HttpClientRequest.get(url).pipe(HttpClientRequest.bearerToken(accessToken), HttpClientRequest.setHeader('anthropic-beta', 'oauth-2025-04-20'));

    return yield* client.execute(request).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(UsageResponse)));
  }).pipe(Effect.mapError((error) => new UsageError({ message: `Usage endpoint: ${error.message}` })));

const UsageLogEntry = Schema.fromJsonString(
  Schema.Struct({
    at: Schema.String,
    five_hour: UsageWindowWire,
    seven_day: UsageWindowWire,
    launch: Schema.Boolean,
    reason: Schema.String,
  }),
);

export type UsageLogEntry = typeof UsageLogEntry.Type;

// Each reading and what the gate made of it, one line per check; the TUI shows the latest.
export const logUsage = (account: Account, response: UsageResponse, decision: LaunchDecision) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* Home;
    const at = DateTime.formatIso(yield* DateTime.now);
    const line = yield* Schema.encodeEffect(UsageLogEntry)({ at, ...response, ...decision });
    yield* fs.makeDirectory(home.root, { recursive: true });
    yield* fs.writeFileString(homePaths(home.root).usageLog(account.name), `${line}\n`, { flag: 'a' });
  });

export const readUsageLogLine = (line: string) => Schema.decodeOption(UsageLogEntry)(line);

export const runUsageGate = (account: Account, gate: GateConfig, refresh: TokenRefresh) =>
  Effect.gen(function* () {
    const response = yield* fetchUsage(yield* freshAccessToken(account, refresh));
    const now = yield* DateTime.now;
    const decision = decideLaunch(yield* parseUsageReading(response, now), gate, now);
    yield* logUsage(account, response, decision);

    return decision;
  }).pipe(Effect.mapError(usageError));

const AuthStatus = Schema.fromJsonString(
  Schema.Struct({
    loggedIn: Schema.optionalKey(Schema.Boolean),
    authMethod: Schema.optionalKey(Schema.String),
    email: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
);

const authStatus = (account: Account) =>
  Effect.gen(function* () {
    const host = yield* HostEnvironment;
    const status = yield* execOk('claude', ['auth', 'status'], { env: accountEnv(account, host.variables) });

    return yield* Schema.decodeEffect(AuthStatus)(status.trim()).pipe(Effect.mapError((issue) => new UsageError({ message: `claude auth status: ${issue.message}` })));
  });

export const loggedInEmail = (account: Account) => authStatus(account).pipe(Effect.map((status) => Option.fromNullishOr(status.email)));

// A token login has no email to show, so Claude's own word that it is logged
// in stands for it. An expectedEmail it cannot show fails closed.
const checkTokenAccount = (account: Account, variable: string) =>
  Effect.gen(function* () {
    const host = yield* HostEnvironment;

    if (Option.isNone(claudeTokenOf(account, host.variables))) return yield* tokenUnset(account.name, variable);

    const status = yield* authStatus(account);

    if (status.loggedIn !== true) return yield* new UsageError({ message: `Claude does not accept the ${account.name} account's token from ${variable}` });

    const email = Option.fromNullishOr(status.email);

    if (Option.isSome(account.expectedEmail) && !Option.contains(email, account.expectedEmail.value)) {
      const shown = Option.getOrElse(email, () => 'no email');

      return yield* new UsageError({ message: `the ${account.name} account's token shows ${shown}, not ${account.expectedEmail.value}` });
    }

    return Option.getOrElse(email, () => `a token from ${variable}`);
  });

// Fails closed when the account is logged out or logged in as someone unexpected,
// so a personal repo never spends the work quota or the other way round.
export const checkAccount = (account: Account) =>
  Effect.gen(function* () {
    if (Option.isSome(account.oauthTokenEnv)) return yield* checkTokenAccount(account, account.oauthTokenEnv.value);

    const email = yield* loggedInEmail(account);

    if (Option.isNone(email)) return yield* new UsageError({ message: `the ${account.name} account is not logged in` });

    if (Option.isSome(account.expectedEmail) && email.value !== account.expectedEmail.value) {
      return yield* new UsageError({ message: `the ${account.name} account is logged in as ${email.value}, not ${account.expectedEmail.value}` });
    }

    return email.value;
  }).pipe(Effect.mapError(usageError));
