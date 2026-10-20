// Where agent sessions are found again: the agent's own session id for each
// of ours (for agents that pick their own), and every session a run opened,
// for `chernabog attach` and the TUI.

import { type Account, decodeJsonLines, UsageGateMode } from '@chernabog/sdk';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';

import { Home, homePaths } from '../config.ts';

const SessionLink = Schema.fromJsonString(Schema.Struct({ session: Schema.String, at: Schema.String }));

const linkFile = (root: string, adapter: string, sessionId: string) => `${homePaths(root).sessions}/${adapter}/${sessionId}.json`;

// The agent's own id for one of our stable session ids, once the agent reported it.
export const knownSession = (adapter: string, sessionId: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = linkFile((yield* Home).root, adapter, sessionId);

    if (!(yield* fs.exists(file))) return Option.none<string>();

    return Option.map(Schema.decodeOption(SessionLink)(yield* fs.readFileString(file)), (link) => link.session);
  }).pipe(Effect.orElseSucceed(() => Option.none<string>()));

export const rememberSession = (adapter: string, sessionId: string, session: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = (yield* Home).root;
    yield* fs.makeDirectory(`${homePaths(root).sessions}/${adapter}`, { recursive: true });
    const at = DateTime.formatIso(yield* DateTime.now);
    yield* fs.writeFileString(linkFile(root, adapter, sessionId), yield* Schema.encodeEffect(SessionLink)({ session, at }));
  }).pipe(Effect.orDie);

// Records written before oauthTokenEnv and usageGate existed leave them out.
const AccountRecord = Schema.Struct({
  name: Schema.String,
  configDir: Schema.OptionFromNullOr(Schema.String),
  expectedEmail: Schema.OptionFromNullOr(Schema.String),
  oauthTokenEnv: Schema.OptionFromOptionalKey(Schema.String),
  usageGate: UsageGateMode.pipe(Schema.withDecodingDefaultKey(Effect.succeed('usage' as const))),
});

export const SessionRecord = Schema.Struct({ adapter: Schema.String, sessionId: Schema.String, cwd: Schema.String, account: AccountRecord, at: Schema.String });

export type SessionRecord = typeof SessionRecord.Type;

const SessionLine = Schema.fromJsonString(SessionRecord);

const runSessionsFile = (root: string, runId: string) => `${homePaths(root).sessions}/runs/${runId}.jsonl`;

export const recordRunSession = (runId: string, adapter: string, sessionId: string, cwd: string, account: Account) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = (yield* Home).root;
    yield* fs.makeDirectory(`${homePaths(root).sessions}/runs`, { recursive: true });
    const at = DateTime.formatIso(yield* DateTime.now);
    const line = yield* Schema.encodeEffect(SessionLine)({ adapter, sessionId, cwd, account, at });
    yield* fs.writeFileString(runSessionsFile(root, runId), `${line}\n`, { flag: 'a' });
  }).pipe(Effect.orDie);

// Every session a run opened, oldest first.
export const runSessions = (runId: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = runSessionsFile((yield* Home).root, runId);

    if (!(yield* fs.exists(file))) return [];

    return decodeJsonLines(SessionLine, yield* fs.readFileString(file));
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<SessionRecord> => []));
