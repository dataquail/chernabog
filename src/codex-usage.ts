// Codex reports no quota over an API, but every session logs its rate limits:
// token_count events in $CODEX_HOME/sessions/YYYY/MM/DD/*.jsonl carry the
// five-hour window (primary) and the weekly one (secondary). The newest one
// read is the reading; nightshift reads them the same way.

import { type Account, UsageError } from "@chernabog/sdk";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";

import { codexHomeOf, Home } from "./config.ts";
import { HostEnvironment, withVariables } from "./platform/environment.ts";
import { execOk } from "./platform/exec.ts";
import {
  decideLaunch,
  type GateConfig,
  logUsage,
  type UsageReading,
  type UsageResponse,
} from "./usage-gate.ts";

const RateLimit = Schema.Struct({
  used_percent: Schema.Finite,
  resets_at: Schema.optionalKey(Schema.Finite),
  resets_in_seconds: Schema.optionalKey(Schema.Finite),
});

type RateLimit = typeof RateLimit.Type;

const TokenCountEvent = Schema.fromJsonString(
  Schema.Struct({
    timestamp: Schema.optionalKey(Schema.String),
    payload: Schema.Struct({
      rate_limits: Schema.Struct({ primary: RateLimit, secondary: RateLimit }),
    }),
  }),
);

const toWindow = (limit: RateLimit, at: DateTime.Utc) => ({
  used: limit.used_percent / 100,
  resetsAt: Option.match(Option.fromUndefinedOr(limit.resets_at), {
    onNone: () => DateTime.add(at, { seconds: limit.resets_in_seconds ?? 0 }),
    onSome: (seconds) => DateTime.makeUnsafe(seconds * 1000),
  }),
});

// The latest rate limits in one session file, if it has any.
export const latestRateLimits = (text: string, readAt: DateTime.Utc): Option.Option<UsageReading> =>
  Arr.findFirst(text.trimEnd().split("\n").reverse(), (line) => line.includes("rate_limits")).pipe(
    Option.flatMap((line) => Schema.decodeOption(TokenCountEvent)(line)),
    Option.map((entry) => {
      const at = Option.getOrElse(
        Option.flatMap(Option.fromUndefinedOr(entry.timestamp), DateTime.make),
        () => readAt,
      );

      const limits = entry.payload.rate_limits;

      return {
        fiveHour: toWindow(limits.primary, DateTime.toUtc(at)),
        sevenDay: toWindow(limits.secondary, DateTime.toUtc(at)),
      };
    }),
  );

type SessionFile = { readonly path: string; readonly modified: number };

const newestFirst = Order.flip(Order.mapInput(Order.Number, (file: SessionFile) => file.modified));

export const readCodexUsage = (account: Account) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = `${codexHomeOf(account, (yield* Home).user)}/sessions`;
    const now = yield* DateTime.now;

    if (!(yield* fs.exists(root))) {
      return Option.none<UsageReading>();
    }

    const files: Array<SessionFile> = [];

    for (const file of yield* fs.readDirectory(root, { recursive: true })) {
      if (file.endsWith(".jsonl")) {
        const info = yield* fs.stat(`${root}/${file}`);
        files.push({
          path: `${root}/${file}`,
          modified: Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }),
        });
      }
    }

    for (const file of Arr.sort(files, newestFirst).slice(0, 20)) {
      const reading = latestRateLimits(yield* fs.readFileString(file.path), now);

      if (Option.isSome(reading)) {
        return reading;
      }
    }

    return Option.none<UsageReading>();
  });

type Window = UsageReading["fiveHour"];

// A window that has reset since it was read starts over at zero.
const currentWindow = (window: Window, now: DateTime.Utc): Window => {
  if (DateTime.isLessThan(window.resetsAt, now)) {
    return { ...window, used: 0 };
  }

  return window;
};

const asLogged = (window: Window) => ({
  utilization: window.used * 100,
  resets_at: DateTime.formatIso(window.resetsAt),
});

export const codexUsageGate = (account: Account, gate: GateConfig) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const reading = yield* readCodexUsage(account);

    if (Option.isNone(reading)) {
      return { launch: true, reason: "no Codex session has recorded its rate limits yet" };
    }

    const fresh = {
      fiveHour: currentWindow(reading.value.fiveHour, now),
      sevenDay: currentWindow(reading.value.sevenDay, now),
    };

    const decision = decideLaunch(fresh, gate, now);

    const logged: UsageResponse = {
      five_hour: asLogged(fresh.fiveHour),
      seven_day: asLogged(fresh.sevenDay),
    };

    yield* logUsage(account, logged, decision);

    return decision;
  }).pipe(Effect.mapError((error) => new UsageError({ message: `Codex usage: ${error.message}` })));

const AuthFile = Schema.fromJsonString(
  Schema.Struct({ tokens: Schema.optionalKey(Schema.Struct({ id_token: Schema.String })) }),
);

const IdTokenClaims = Schema.fromJsonString(
  Schema.Struct({ email: Schema.optionalKey(Schema.String) }),
);

// The email in the ChatGPT login Codex keeps in $CODEX_HOME/auth.json.
export const codexEmail = (account: Account) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = `${codexHomeOf(account, (yield* Home).user)}/auth.json`;

    if (!(yield* fs.exists(file))) {
      return Option.none<string>();
    }

    return Schema.decodeOption(AuthFile)(yield* fs.readFileString(file)).pipe(
      Option.flatMap((auth) => Option.fromUndefinedOr(auth.tokens)),
      Option.flatMap((tokens) => Arr.get(tokens.id_token.split("."), 1)),
      Option.flatMap((claims) =>
        Schema.decodeOption(IdTokenClaims)(Buffer.from(claims, "base64url").toString("utf8")),
      ),
      Option.flatMap((claims) => Option.fromUndefinedOr(claims.email)),
    );
  }).pipe(Effect.orElseSucceed(() => Option.none<string>()));

export const checkCodexAccount = (account: Account) =>
  Effect.gen(function* () {
    const host = yield* HostEnvironment;

    const env = withVariables(
      host.variables,
      { CODEX_HOME: codexHomeOf(account, (yield* Home).user) },
      [],
    );

    const status = yield* execOk("codex", ["login", "status"], { env }).pipe(
      Effect.mapError(
        (error) => new UsageError({ message: `the ${account.name} account: ${error.message}` }),
      ),
    );

    if (!/logged in/i.test(status) || /not logged in/i.test(status)) {
      return yield* new UsageError({
        message: `the ${account.name} account is not logged in to Codex`,
      });
    }

    if (/api key/i.test(status)) {
      return yield* new UsageError({
        message: `the ${account.name} account uses an API key; Chernabog only spends subscription capacity`,
      });
    }

    const email = yield* codexEmail(account);

    if (
      Option.isSome(account.expectedEmail) &&
      !Option.contains(email, account.expectedEmail.value)
    ) {
      const actual = Option.getOrElse(email, () => "unknown");

      return yield* new UsageError({
        message: `the ${account.name} account is logged in to Codex as ${actual}, not ${account.expectedEmail.value}`,
      });
    }

    return Option.getOrElse(email, () => "logged in");
  });
