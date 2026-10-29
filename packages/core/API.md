# @chernabog/core's API

What `@chernabog/core` declares, module by module, as `tsc` emits it. `bun run gen:core-api` writes this file, and a test fails when it is out of date. Within a major, change it only by adding to it: see [ADR 0004](../../docs/adr/0004-core-abi.md).

## claims.ts

```ts
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { type GitHubError } from "./errors.ts";
import * as Markers from "./run-markers.ts";
import { GitHub, Run } from "./services.ts";
export declare const issue: (number: number) => string;
export declare const pullRequest: (number: number) => string;
export declare const epic: (number: number) => string;
export declare const refFor: (item: string) => string;
export declare const leaseRefFor: (item: string, sha: string) => string;
export declare const DEFAULT_LEASE_TTL: Duration.Duration;
export declare const branchFor: (number: number) => string;
export type Holder = {
    readonly runId: string;
    readonly persona: string;
    readonly flow: string;
    readonly claimedAt: string;
    readonly withPerson: boolean;
    readonly expiresAt?: string;
    readonly renewedAt?: string;
    readonly takenOverFrom?: string;
};
export declare const messageOf: (holder: Holder) => string;
export declare const holderOf: (message: string) => Option.Option<Holder>;
export type Claim = {
    readonly sha: string;
    readonly holder: Holder;
};
export declare const current: (item: string) => Effect.Effect<Option.Option<Claim>, GitHubError, GitHub>;
export declare const holder: (item: string) => Effect.Effect<Option.Option<Holder>, GitHubError, GitHub>;
export declare const expiresAt: (found: Holder) => Option.Option<DateTime.Utc>;
export declare const expired: (found: Holder, now: DateTime.Utc) => boolean;
export declare const liveHolder: (item: string) => Effect.Effect<Option.Option<Holder>, GitHubError, GitHub>;
export type Renewal = {
    readonly status: "renewed";
    readonly expiresAt: string;
} | {
    readonly status: "lost";
    readonly holder: Option.Option<Holder>;
} | {
    readonly status: "released";
};
export declare const renew: (item: string, runId: string, ttl: Duration.Duration) => Effect.Effect<Renewal, GitHubError, GitHub>;
export type Holding = {
    readonly held: true;
} | {
    readonly held: false;
    readonly holder: Option.Option<Holder>;
};
export declare const holds: (item: string, runId: string) => Effect.Effect<Holding, GitHubError, GitHub>;
export declare const releaseFor: (item: string, runId: string) => Effect.Effect<boolean, GitHubError, GitHub>;
export declare const refMarker: Markers.Definition<{
    readonly item: string;
    readonly runId: string;
}>;
export type AcquireOptions = {
    readonly withPerson?: boolean;
};
export type Acquired = {
    readonly acquired: true;
    readonly takenOver: Option.Option<Holder>;
} | {
    readonly acquired: false;
    readonly holder: Option.Option<Holder>;
};
export declare const acquire: (item: string, options?: AcquireOptions) => Effect.Effect<{
    acquired: true;
    takenOver: Option.Option<Holder>;
} | {
    acquired: false;
    holder: Option.Option<Holder>;
}, GitHubError | import("./errors.ts").StepFailed, GitHub | Run>;
export declare const release: (item: string) => Effect.Effect<boolean, GitHubError | import("./errors.ts").StepFailed, GitHub | Run>;
export declare const releasing: (item: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R | import("effect/workflow/WorkflowEngine").WorkflowEngine | import("effect/workflow/WorkflowEngine").WorkflowInstance | Markers.ReleaseServices>;
export declare const describeHolder: (item: string, held: Option.Option<Holder>) => string;
export declare const describeLoss: (item: string, held: Option.Option<Holder>) => string;
export declare const describeTakeover: (previous: Holder) => string;
```

## errors.ts

```ts
import * as Schema from "effect/Schema";
declare const Skip_base: Schema.Class<Skip, Schema.TaggedStruct<"Skip", {
    readonly reason: Schema.String;
}>, import("effect/Cause").YieldableError & {
    readonly brand: "Skip";
}>;
export declare class Skip extends Skip_base {
}
declare const NeedsHuman_base: Schema.Class<NeedsHuman, Schema.TaggedStruct<"NeedsHuman", {
    readonly reason: Schema.String;
}>, import("effect/Cause").YieldableError & {
    readonly brand: "NeedsHuman";
}>;
export declare class NeedsHuman extends NeedsHuman_base {
}
declare const StepFailed_base: Schema.Class<StepFailed, Schema.TaggedStruct<"StepFailed", {
    readonly step: Schema.String;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError & {
    readonly brand: "StepFailed";
}>;
export declare class StepFailed extends StepFailed_base {
}
declare const GitHubError_base: Schema.Class<GitHubError, Schema.TaggedStruct<"GitHubError", {
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError & {
    readonly brand: "GitHubError";
}>;
export declare class GitHubError extends GitHubError_base {
}
declare const GitError_base: Schema.Class<GitError, Schema.TaggedStruct<"GitError", {
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError & {
    readonly brand: "GitError";
}>;
export declare class GitError extends GitError_base {
}
declare const AgentError_base: Schema.Class<AgentError, Schema.TaggedStruct<"AgentError", {
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError & {
    readonly brand: "AgentError";
}>;
export declare class AgentError extends AgentError_base {
}
declare const UsageError_base: Schema.Class<UsageError, Schema.TaggedStruct<"UsageError", {
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError & {
    readonly brand: "UsageError";
}>;
export declare class UsageError extends UsageError_base {
}
export type ReportedError = GitHubError | GitError | AgentError | UsageError;
declare const NotFound_base: Schema.Class<NotFound, Schema.TaggedStruct<"NotFound", {
    readonly what: Schema.String;
}>, import("effect/Cause").YieldableError & {
    readonly brand: "NotFound";
}>;
export declare class NotFound extends NotFound_base {
    get message(): string;
}
declare const PullRequestClosed_base: Schema.Class<PullRequestClosed, Schema.TaggedStruct<"PullRequestClosed", {
    readonly pullRequest: Schema.Finite;
    readonly state: Schema.Literals<readonly ["closed", "merged"]>;
}>, import("effect/Cause").YieldableError & {
    readonly brand: "PullRequestClosed";
}>;
export declare class PullRequestClosed extends PullRequestClosed_base {
    get message(): string;
}
declare const MergeRefused_base: Schema.Class<MergeRefused, Schema.TaggedStruct<"MergeRefused", {
    readonly pullRequest: Schema.Finite;
    readonly reason: Schema.String;
}>, import("effect/Cause").YieldableError & {
    readonly brand: "MergeRefused";
}>;
export declare class MergeRefused extends MergeRefused_base {
    get message(): string;
}
declare const PushRejected_base: Schema.Class<PushRejected, Schema.TaggedStruct<"PushRejected", {
    readonly branch: Schema.String;
    readonly reason: Schema.String;
    readonly missingScope: Schema.optionalKey<Schema.String>;
}>, import("effect/Cause").YieldableError & {
    readonly brand: "PushRejected";
}>;
export declare class PushRejected extends PushRejected_base {
    get message(): string;
}
declare const NothingCommitted_base: Schema.Class<NothingCommitted, Schema.TaggedStruct<"NothingCommitted", {
    readonly branch: Schema.String;
}>, import("effect/Cause").YieldableError & {
    readonly brand: "NothingCommitted";
}>;
export declare class NothingCommitted extends NothingCommitted_base {
    get message(): string;
}
declare const CiTimedOut_base: Schema.Class<CiTimedOut, Schema.TaggedStruct<"CiTimedOut", {
    readonly pullRequest: Schema.Finite;
    readonly after: Schema.String;
}>, import("effect/Cause").YieldableError & {
    readonly brand: "CiTimedOut";
}>;
export declare class CiTimedOut extends CiTimedOut_base {
    get message(): string;
}
export declare const WorkError: Schema.Union<readonly [typeof NotFound, typeof PullRequestClosed, typeof MergeRefused, typeof PushRejected, typeof NothingCommitted, typeof CiTimedOut]>;
export type WorkError = typeof WorkError.Type;
declare const PersonaUnavailable_base: Schema.Class<PersonaUnavailable, Schema.TaggedStruct<"PersonaUnavailable", {
    readonly login: Schema.String;
    readonly reason: Schema.String;
}>, import("effect/Cause").YieldableError & {
    readonly brand: "PersonaUnavailable";
}>;
export declare class PersonaUnavailable extends PersonaUnavailable_base {
    get message(): string;
}
declare const NotAuthenticated_base: Schema.Class<NotAuthenticated, Schema.TaggedStruct<"NotAuthenticated", {
    readonly reason: Schema.String;
}>, import("effect/Cause").YieldableError & {
    readonly brand: "NotAuthenticated";
}>;
export declare class NotAuthenticated extends NotAuthenticated_base {
    get message(): string;
}
declare const NotInReviewerPool_base: Schema.Class<NotInReviewerPool, Schema.TaggedStruct<"NotInReviewerPool", {
    readonly login: Schema.optionalKey<Schema.String>;
    readonly reviewers: Schema.$Array<Schema.String>;
}>, import("effect/Cause").YieldableError & {
    readonly brand: "NotInReviewerPool";
}>;
export declare class NotInReviewerPool extends NotInReviewerPool_base {
    get message(): string;
}
export declare const SetupError: Schema.Union<readonly [typeof PersonaUnavailable, typeof NotAuthenticated, typeof NotInReviewerPool]>;
export type SetupError = typeof SetupError.Type;
export declare const isSetupError: <I>(input: I) => input is I & (NotAuthenticated | NotInReviewerPool | PersonaUnavailable);
export {};
```

## flow.ts

```ts
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as DurableDeferred from "effect/workflow/DurableDeferred";
import type * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { NeedsHuman, type ReportedError, Skip, StepFailed } from "./errors.ts";
import type { Json } from "./json.ts";
import type { Marker } from "./run-markers.ts";
import { type Agent, type Git, type GitHub, type Repo, type ReviewerSeat, type Run, RunLog, type Usage, type WorkItem, type Worktree } from "./services.ts";
declare const StepRunner_base: Context.ServiceClass<StepRunner, "@chernabog/sdk/StepRunner", {
    run(name: string, input: Json): Effect.Effect<Json, Skip | StepFailed>;
}>;
export declare class StepRunner extends StepRunner_base {
}
declare const Signals_base: Context.ServiceClass<Signals, "@chernabog/sdk/Signals", {
    register(signal: string, deferred: string, token: string): Effect.Effect<void>;
}>;
export declare class Signals extends Signals_base {
}
export type TriggerServices = Repo | GitHub | Git | Worktree | Usage | Agent | ReviewerSeat | RunLog | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner;
export type WorkflowServices = TriggerServices | Run | StepRunner | Signals | WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance | Scope.Scope;
export type FlowError = Skip | NeedsHuman | StepFailed;
export type FlowLabel = {
    readonly name: string;
    readonly color?: string;
    readonly description?: string;
};
export type ItemLookup = (key: string) => Effect.Effect<Option.Option<WorkItem>, FlowError, TriggerServices>;
export type Valid = {
    readonly valid: true;
};
export type Gone = {
    readonly valid: false;
    readonly reason: string;
};
export type Validity = Valid | Gone;
export declare const valid: Valid;
export declare const gone: (reason: string) => Gone;
export declare const isGone: (validity: Validity) => validity is Gone;
export type StillValid = (item: WorkItem) => Effect.Effect<Validity, FlowError, TriggerServices | Run>;
type FlowCommon = {
    readonly gate?: Effect.Effect<void, FlowError, TriggerServices>;
    readonly concurrency?: number;
    readonly labels?: ReadonlyArray<FlowLabel>;
    readonly ownWork?: boolean;
    readonly stillValid?: StillValid;
    readonly markers?: ReadonlyArray<Marker>;
    readonly workflow: (item: WorkItem) => Effect.Effect<string | void, FlowError, WorkflowServices>;
};
export type TriggeredFlow = FlowCommon & {
    readonly trigger: Effect.Effect<ReadonlyArray<WorkItem>, FlowError, TriggerServices>;
    readonly schedule?: string;
    readonly item?: ItemLookup;
};
export type ManualFlow = FlowCommon & {
    readonly trigger?: never;
    readonly schedule?: never;
    readonly item: ItemLookup;
};
export type Flow = TriggeredFlow | ManualFlow;
export declare const defineFlow: (flow: Flow) => Flow;
export declare const isManual: (flow: Flow) => flow is ManualFlow;
export declare const triggerOf: (flow: Flow) => TriggeredFlow["trigger"];
export declare const describeError: <E>(error: E) => string;
export declare const reportAs: (step: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, StepFailed | Exclude<E, Extract<E, ReportedError>>, R>;
export declare const CurrentActivity: Context.Reference<Option.Option<string>>;
export declare const activity: <S extends Schema.Constraint = typeof Schema.Void, E = never, R = never>(name: string, execute: Effect.Effect<S["Type"], E, R>, success?: S) => Effect.Effect<S["Type"], Extract<E, import("./errors.ts").CiTimedOut | import("./errors.ts").MergeRefused | import("./errors.ts").NotFound | import("./errors.ts").NothingCommitted | import("./errors.ts").PullRequestClosed | import("./errors.ts").PushRejected> | FlowError, WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance | S["DecodingServices"] | Exclude<Exclude<R, never>, Scope.Scope | WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance>>;
export declare const step: <A>(name: string, input: Json, output: Schema.Codec<A, Json>, id?: Option.Option<string>) => Effect.Effect<A, FlowError, StepRunner | WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance>;
export declare const sleep: (name: string, duration: Duration.Input) => Effect.Effect<void, never, WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance>;
export declare const signalDeferred: (name: string) => DurableDeferred.DurableDeferred<Schema.Literal<true>, Schema.Never>;
export type Wait = {
    readonly id: string;
    readonly timeout: Duration.Input;
};
export declare const awaitSignal: (signals: ReadonlyArray<string>, wait: Wait) => Effect.Effect<string, FlowError, Signals | WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance>;
export {};
```

## github-markers.ts

```ts
import { type Marker } from "./run-markers.ts";
export declare const label: import("./run-markers.ts").Definition<{
    readonly number: number;
    readonly label: string;
}>;
export declare const assignment: import("./run-markers.ts").Definition<{
    readonly number: number;
    readonly login: string;
}>;
export declare const boardStatus: import("./run-markers.ts").Definition<{
    readonly number: number;
    readonly status: string;
}>;
export declare const claimBranch: import("./run-markers.ts").Definition<{
    readonly branch: string;
}>;
export declare const builtIn: ReadonlyArray<Marker>;
```

## index.ts

```ts
export * as Claims from "./claims.ts";
export * from "./errors.ts";
export * from "./flow.ts";
export * from "./json.ts";
export * from "./markers.ts";
export * as Markers from "./markers-api.ts";
export * from "./paths.ts";
export * from "./roles.ts";
export * from "./services.ts";
export * from "./stage.ts";
```

## json.ts

```ts
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
export type Json = Schema.Json;
export declare const parseJson: (text: string) => Option.Option<Json>;
export declare const printJson: (value: Json) => string;
export declare const decodeJsonLines: <A>(schema: Schema.Codec<A, string>, text: string) => ReadonlyArray<A>;
```

## markers-api.ts

```ts
export * from "./github-markers.ts";
export * from "./run-markers.ts";
```

## markers.ts

```ts
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
export declare const SessionMarker: Schema.Struct<{
    readonly adapter: Schema.String;
    readonly sessionId: Schema.String;
    readonly issue: Schema.Finite;
    readonly branch: Schema.String;
    readonly withPerson: Schema.optionalKey<Schema.Boolean>;
}>;
export type SessionMarker = typeof SessionMarker.Type;
export declare const ReviewMarker: Schema.Struct<{
    readonly sha: Schema.String;
    readonly round: Schema.Finite;
    readonly verdict: Schema.Literals<readonly ["approve", "request-changes"]>;
    readonly reviewer: Schema.optionalKey<Schema.String>;
    readonly sessionId: Schema.optionalKey<Schema.String>;
    readonly adapter: Schema.optionalKey<Schema.String>;
}>;
export type ReviewMarker = typeof ReviewMarker.Type;
export declare const ClaimMarker: Schema.Struct<{
    readonly runId: Schema.String;
    readonly claimedAt: Schema.String;
    readonly branch: Schema.String;
    readonly base: Schema.optionalKey<Schema.String>;
    readonly withPerson: Schema.optionalKey<Schema.Boolean>;
    readonly ref: Schema.optionalKey<Schema.Boolean>;
    readonly adopted: Schema.optionalKey<Schema.Struct<{
        readonly number: Schema.Finite;
        readonly url: Schema.String;
        readonly draft: Schema.Boolean;
    }>>;
}>;
export type ClaimMarker = typeof ClaimMarker.Type;
export declare const OwnerMarker: Schema.Struct<{
    readonly flow: Schema.String;
    readonly runId: Schema.String;
    readonly released: Schema.Boolean;
    readonly ref: Schema.optionalKey<Schema.Boolean>;
}>;
export type OwnerMarker = typeof OwnerMarker.Type;
export declare const PlanMarker: Schema.Struct<{
    readonly round: Schema.Finite;
}>;
export type PlanMarker = typeof PlanMarker.Type;
export declare const PlanNodeMarker: Schema.Struct<{
    readonly spec: Schema.Finite;
    readonly key: Schema.String;
}>;
export type PlanNodeMarker = typeof PlanNodeMarker.Type;
export declare const claimMarker: {
    write: (value: {
        readonly runId: string;
        readonly claimedAt: string;
        readonly branch: string;
        readonly base?: string | undefined;
        readonly withPerson?: boolean | undefined;
        readonly ref?: boolean | undefined;
        readonly adopted?: {
            readonly number: number;
            readonly url: string;
            readonly draft: boolean;
        } | undefined;
    }) => string;
    read: (body: string) => Option.Option<{
        readonly runId: string;
        readonly claimedAt: string;
        readonly branch: string;
        readonly base?: string | undefined;
        readonly withPerson?: boolean | undefined;
        readonly ref?: boolean | undefined;
        readonly adopted?: {
            readonly number: number;
            readonly url: string;
            readonly draft: boolean;
        } | undefined;
    }>;
};
export declare const sessionMarker: {
    write: (value: {
        readonly adapter: string;
        readonly sessionId: string;
        readonly issue: number;
        readonly branch: string;
        readonly withPerson?: boolean | undefined;
    }) => string;
    read: (body: string) => Option.Option<{
        readonly adapter: string;
        readonly sessionId: string;
        readonly issue: number;
        readonly branch: string;
        readonly withPerson?: boolean | undefined;
    }>;
};
export declare const reviewMarker: {
    write: (value: {
        readonly sha: string;
        readonly round: number;
        readonly verdict: "approve" | "request-changes";
        readonly reviewer?: string | undefined;
        readonly sessionId?: string | undefined;
        readonly adapter?: string | undefined;
    }) => string;
    read: (body: string) => Option.Option<{
        readonly sha: string;
        readonly round: number;
        readonly verdict: "approve" | "request-changes";
        readonly reviewer?: string | undefined;
        readonly sessionId?: string | undefined;
        readonly adapter?: string | undefined;
    }>;
};
export declare const ownerMarker: {
    write: (value: {
        readonly flow: string;
        readonly runId: string;
        readonly released: boolean;
        readonly ref?: boolean | undefined;
    }) => string;
    read: (body: string) => Option.Option<{
        readonly flow: string;
        readonly runId: string;
        readonly released: boolean;
        readonly ref?: boolean | undefined;
    }>;
};
export declare const planMarker: {
    write: (value: {
        readonly round: number;
    }) => string;
    read: (body: string) => Option.Option<{
        readonly round: number;
    }>;
};
export declare const planNodeMarker: {
    write: (value: {
        readonly spec: number;
        readonly key: string;
    }) => string;
    read: (body: string) => Option.Option<{
        readonly spec: number;
        readonly key: string;
    }>;
};
export declare const hasMarker: (body: string) => boolean;
export declare const latestMarker: <A>(read: (body: string) => Option.Option<A>, bodies: ReadonlyArray<string>) => Option.Option<A>;
```

## paths.ts

```ts
export declare const globToRegExp: (glob: string) => RegExp;
export declare const pathsMatching: (paths: ReadonlyArray<string>, globs: ReadonlyArray<string>) => string[];
```

## roles.ts

```ts
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Repo, Run } from "./services.ts";
export type RoleOptions = {
    readonly role?: string;
};
export declare const adapterFor: (role: Option.Option<string>) => Effect.Effect<Option.Option<string>, never, Repo | Run>;
```

## run-markers.ts

```ts
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import { StepFailed } from "./errors.ts";
import type { Json } from "./json.ts";
import { type Agent, type Git, type GitHub, type Repo, type ReviewerSeat, type Run, RunLog, type Usage, type Worktree } from "./services.ts";
export type Ending = "done" | "skipped" | "needs-human" | "failed" | "cancelled" | "superseded" | "lost";
export type ReleaseServices = Repo | GitHub | Git | Worktree | Usage | Agent | ReviewerSeat | RunLog | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Run;
export type Marker = {
    readonly name: string;
    readonly releaseJson: (args: Json) => Effect.Effect<void, ArgumentsChanged | unknown, ReleaseServices>;
};
export type Definition<A> = Marker & {
    readonly args: Schema.Codec<A, Json>;
    readonly release: (args: A) => Effect.Effect<void, unknown, ReleaseServices>;
};
declare const ArgumentsChanged_base: Schema.Class<ArgumentsChanged, Schema.TaggedStruct<"ArgumentsChanged", {
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError & {
    readonly brand: "ArgumentsChanged";
}>;
export declare class ArgumentsChanged extends ArgumentsChanged_base {
}
export declare const define: <A>(name: string, args: Schema.Codec<A, Json>, release: (args: A) => Effect.Effect<void, unknown, ReleaseServices>) => Definition<A>;
export type HoldOptions = {
    readonly keepOn?: ReadonlyArray<Ending>;
};
declare const MarkerHolds_base: Context.ServiceClass<MarkerHolds, "@chernabog/sdk/MarkerHolds", {
    hold(name: string, args: Json, keepOn: ReadonlyArray<Ending>): Effect.Effect<void, StepFailed>;
    held(name: string): Effect.Effect<ReadonlyArray<Json>>;
    forget(name: string, args: Json): Effect.Effect<void>;
}>;
export declare class MarkerHolds extends MarkerHolds_base {
}
export declare const hold: <A>(marker: Definition<A>, args: A, options?: HoldOptions) => Effect.Effect<void, StepFailed, never>;
export declare const forget: <A>(marker: Definition<A>, args: A) => Effect.Effect<void, StepFailed, never>;
export declare const drop: <A>(marker: Definition<A>, args: A) => Effect.Effect<void, StepFailed, ReleaseServices>;
export declare const dropAll: <A>(marker: Definition<A>) => Effect.Effect<void, never, ReleaseServices>;
export declare const find: (markers: ReadonlyArray<Marker>, name: string) => Option.Option<Marker>;
export declare const unlisted: (name: string) => StepFailed;
export {};
```

## services.ts

```ts
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { AgentError, GitError, GitHubError, MergeRefused, NotFound, PullRequestClosed, PushRejected, UsageError } from "./errors.ts";
import type { Json } from "./json.ts";
export declare const Labels: Schema.Struct<{
    readonly eligible: Schema.String;
    readonly inProgress: Schema.String;
    readonly needsReview: Schema.String;
    readonly changesRequested: Schema.String;
    readonly approved: Schema.String;
    readonly needsHuman: Schema.String;
    readonly needsClarification: Schema.String;
    readonly stale: Schema.String;
    readonly ship: Schema.String;
    readonly hybrid: Schema.String;
}>;
export type Labels = typeof Labels.Type;
export declare const DEFAULT_LABELS: Labels;
export declare const Board: Schema.Struct<{
    readonly projectNumber: Schema.Finite;
    readonly readyStatus: Schema.String;
    readonly inProgressStatus: Schema.String;
}>;
export type Board = typeof Board.Type;
export declare const UsageGateMode: Schema.Literals<readonly ["usage", "none"]>;
export type UsageGateMode = typeof UsageGateMode.Type;
export declare const Account: Schema.Struct<{
    readonly name: Schema.String;
    readonly configDir: Schema.Option<Schema.String>;
    readonly expectedEmail: Schema.Option<Schema.String>;
    readonly oauthTokenEnv: Schema.Option<Schema.String>;
    readonly usageGate: Schema.Literals<readonly ["usage", "none"]>;
}>;
export type Account = typeof Account.Type;
export declare const Limits: Schema.Struct<{
    readonly localGateRounds: Schema.Finite;
    readonly ciRounds: Schema.Finite;
    readonly reviewRounds: Schema.Finite;
    readonly staleAfter: Schema.Duration;
    readonly ciTimeout: Schema.Duration;
    readonly planNodes: Schema.Finite;
    readonly planRounds: Schema.Finite;
    readonly stackDepth: Schema.Finite;
}>;
export type Limits = typeof Limits.Type;
export declare const LauncherCommands: Schema.Struct<{
    readonly start: Schema.$Array<Schema.String>;
    readonly close: Schema.$Array<Schema.String>;
    readonly alive: Schema.Option<Schema.$Array<Schema.String>>;
    readonly attach: Schema.Option<Schema.$Array<Schema.String>>;
}>;
export type LauncherCommands = typeof LauncherCommands.Type;
export declare const ResolvedLauncher: Schema.Struct<{
    readonly name: Schema.String;
    readonly from: Schema.String;
    readonly custom: Schema.Option<Schema.Struct<{
        readonly start: Schema.$Array<Schema.String>;
        readonly close: Schema.$Array<Schema.String>;
        readonly alive: Schema.Option<Schema.$Array<Schema.String>>;
        readonly attach: Schema.Option<Schema.$Array<Schema.String>>;
    }>>;
}>;
export type ResolvedLauncher = typeof ResolvedLauncher.Type;
export declare const HEADLESS: ResolvedLauncher;
export declare const RepoSettings: Schema.Struct<{
    readonly name: Schema.String;
    readonly slug: Schema.String;
    readonly path: Schema.String;
    readonly baseBranch: Schema.String;
    readonly reviewers: Schema.optionalKey<Schema.$Array<Schema.String>>;
    readonly persona: Schema.optionalKey<Schema.String>;
    readonly account: Schema.Struct<{
        readonly name: Schema.String;
        readonly configDir: Schema.Option<Schema.String>;
        readonly expectedEmail: Schema.Option<Schema.String>;
        readonly oauthTokenEnv: Schema.Option<Schema.String>;
        readonly usageGate: Schema.Literals<readonly ["usage", "none"]>;
    }>;
    readonly agent: Schema.String;
    readonly agentAccounts: Schema.$Record<Schema.String, Schema.Struct<{
        readonly name: Schema.String;
        readonly configDir: Schema.Option<Schema.String>;
        readonly expectedEmail: Schema.Option<Schema.String>;
        readonly oauthTokenEnv: Schema.Option<Schema.String>;
        readonly usageGate: Schema.Literals<readonly ["usage", "none"]>;
    }>>;
    readonly launcher: Schema.Struct<{
        readonly name: Schema.String;
        readonly from: Schema.String;
        readonly custom: Schema.Option<Schema.Struct<{
            readonly start: Schema.$Array<Schema.String>;
            readonly close: Schema.$Array<Schema.String>;
            readonly alive: Schema.Option<Schema.$Array<Schema.String>>;
            readonly attach: Schema.Option<Schema.$Array<Schema.String>>;
        }>>;
    }>;
    readonly flowAgents: Schema.$Record<Schema.String, Schema.String>;
    readonly flowRoleAgents: Schema.optionalKey<Schema.$Record<Schema.String, Schema.$Record<Schema.String, Schema.String>>>;
    readonly roleAgents: Schema.optionalKey<Schema.$Record<Schema.String, Schema.String>>;
    readonly labels: Schema.Struct<{
        readonly eligible: Schema.String;
        readonly inProgress: Schema.String;
        readonly needsReview: Schema.String;
        readonly changesRequested: Schema.String;
        readonly approved: Schema.String;
        readonly needsHuman: Schema.String;
        readonly needsClarification: Schema.String;
        readonly stale: Schema.String;
        readonly ship: Schema.String;
        readonly hybrid: Schema.String;
    }>;
    readonly install: Schema.Option<Schema.String>;
    readonly localGate: Schema.$Array<Schema.String>;
    readonly humanOnly: Schema.$Array<Schema.String>;
    readonly humanOnlyPaths: Schema.$Array<Schema.String>;
    readonly notes: Schema.$Array<Schema.String>;
    readonly board: Schema.Option<Schema.Struct<{
        readonly projectNumber: Schema.Finite;
        readonly readyStatus: Schema.String;
        readonly inProgressStatus: Schema.String;
    }>>;
    readonly reviewTrigger: Schema.Option<Schema.String>;
    readonly limits: Schema.Struct<{
        readonly localGateRounds: Schema.Finite;
        readonly ciRounds: Schema.Finite;
        readonly reviewRounds: Schema.Finite;
        readonly staleAfter: Schema.Duration;
        readonly ciTimeout: Schema.Duration;
        readonly planNodes: Schema.Finite;
        readonly planRounds: Schema.Finite;
        readonly stackDepth: Schema.Finite;
    }>;
    readonly env: Schema.$Record<Schema.String, Schema.String>;
    readonly configDir: Schema.String;
}>;
export type RepoSettings = typeof RepoSettings.Type;
declare const Repo_base: Context.ServiceClass<Repo, "@chernabog/sdk/Repo", {
    readonly name: string;
    readonly slug: string;
    readonly path: string;
    readonly baseBranch: string;
    readonly reviewers?: readonly string[] | undefined;
    readonly persona?: string | undefined;
    readonly account: {
        readonly name: string;
        readonly configDir: Option.Option<string>;
        readonly expectedEmail: Option.Option<string>;
        readonly oauthTokenEnv: Option.Option<string>;
        readonly usageGate: "none" | "usage";
    };
    readonly agent: string;
    readonly agentAccounts: {
        readonly [x: string]: {
            readonly name: string;
            readonly configDir: Option.Option<string>;
            readonly expectedEmail: Option.Option<string>;
            readonly oauthTokenEnv: Option.Option<string>;
            readonly usageGate: "none" | "usage";
        };
    };
    readonly launcher: {
        readonly name: string;
        readonly from: string;
        readonly custom: Option.Option<{
            readonly start: readonly string[];
            readonly close: readonly string[];
            readonly alive: Option.Option<readonly string[]>;
            readonly attach: Option.Option<readonly string[]>;
        }>;
    };
    readonly flowAgents: {
        readonly [x: string]: string;
    };
    readonly flowRoleAgents?: {
        readonly [x: string]: {
            readonly [x: string]: string;
        };
    } | undefined;
    readonly roleAgents?: {
        readonly [x: string]: string;
    } | undefined;
    readonly labels: {
        readonly eligible: string;
        readonly inProgress: string;
        readonly needsReview: string;
        readonly changesRequested: string;
        readonly approved: string;
        readonly needsHuman: string;
        readonly needsClarification: string;
        readonly stale: string;
        readonly ship: string;
        readonly hybrid: string;
    };
    readonly install: Option.Option<string>;
    readonly localGate: readonly string[];
    readonly humanOnly: readonly string[];
    readonly humanOnlyPaths: readonly string[];
    readonly notes: readonly string[];
    readonly board: Option.Option<{
        readonly projectNumber: number;
        readonly readyStatus: string;
        readonly inProgressStatus: string;
    }>;
    readonly reviewTrigger: Option.Option<string>;
    readonly limits: {
        readonly localGateRounds: number;
        readonly ciRounds: number;
        readonly reviewRounds: number;
        readonly staleAfter: import("effect/Duration").Duration;
        readonly ciTimeout: import("effect/Duration").Duration;
        readonly planNodes: number;
        readonly planRounds: number;
        readonly stackDepth: number;
    };
    readonly env: {
        readonly [x: string]: string;
    };
    readonly configDir: string;
}>;
export declare class Repo extends Repo_base {
}
export declare const WorkItem: Schema.Struct<{
    readonly key: Schema.String;
    readonly title: Schema.optionalKey<Schema.String>;
    readonly url: Schema.optionalKey<Schema.String>;
    readonly data: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    readonly signals: Schema.optionalKey<Schema.$Array<Schema.String>>;
    readonly wakeOnly: Schema.optionalKey<Schema.Boolean>;
    readonly held: Schema.optionalKey<Schema.String>;
    readonly assignees: Schema.optionalKey<Schema.$Array<Schema.String>>;
    readonly reviewers: Schema.optionalKey<Schema.$Array<Schema.String>>;
}>;
export type WorkItem = typeof WorkItem.Type;
export declare const RunInfo: Schema.Struct<{
    readonly flow: Schema.String;
    readonly runId: Schema.String;
    readonly executionId: Schema.String;
    readonly item: Schema.Struct<{
        readonly key: Schema.String;
        readonly title: Schema.optionalKey<Schema.String>;
        readonly url: Schema.optionalKey<Schema.String>;
        readonly data: Schema.Codec<Schema.Json, Schema.Json, never, never>;
        readonly signals: Schema.optionalKey<Schema.$Array<Schema.String>>;
        readonly wakeOnly: Schema.optionalKey<Schema.Boolean>;
        readonly held: Schema.optionalKey<Schema.String>;
        readonly assignees: Schema.optionalKey<Schema.$Array<Schema.String>>;
        readonly reviewers: Schema.optionalKey<Schema.$Array<Schema.String>>;
    }>;
    readonly pullRequest: Schema.optionalKey<Schema.Finite>;
    readonly leaseTtl: Schema.optionalKey<Schema.Finite>;
}>;
export type RunInfo = typeof RunInfo.Type;
declare const Run_base: Context.ServiceClass<Run, "@chernabog/sdk/Run", {
    readonly flow: string;
    readonly runId: string;
    readonly executionId: string;
    readonly item: {
        readonly key: string;
        readonly title?: string | undefined;
        readonly url?: string | undefined;
        readonly data: Schema.Json;
        readonly signals?: readonly string[] | undefined;
        readonly wakeOnly?: boolean | undefined;
        readonly held?: string | undefined;
        readonly assignees?: readonly string[] | undefined;
        readonly reviewers?: readonly string[] | undefined;
    };
    readonly pullRequest?: number | undefined;
    readonly leaseTtl?: number | undefined;
}>;
export declare class Run extends Run_base {
}
export type FlowPackageInfo = {
    readonly name: string;
    readonly version: string;
    readonly dir: string;
};
declare const FlowPackage_base: Context.ServiceClass<FlowPackage, "@chernabog/sdk/FlowPackage", FlowPackageInfo>;
export declare class FlowPackage extends FlowPackage_base {
}
export type Issue = {
    readonly number: number;
    readonly title: string;
    readonly body: string;
    readonly url: string;
    readonly createdAt: string;
    readonly labels: ReadonlyArray<string>;
    readonly assignees: ReadonlyArray<string>;
    readonly state?: "open" | "closed";
};
export type LinkedIssue = Issue & {
    readonly state: "open" | "closed";
};
export type NewIssue = {
    readonly title: string;
    readonly body: string;
    readonly labels: ReadonlyArray<string>;
};
export type Comment = {
    readonly id: number;
    readonly author: string;
    readonly body: string;
    readonly createdAt: string;
    readonly trusted: boolean;
};
export type ReviewNote = Comment & {
    readonly location: Option.Option<{
        readonly path: string;
        readonly line: number;
    }>;
};
export type PullRequest = {
    readonly number: number;
    readonly title: string;
    readonly body: string;
    readonly url: string;
    readonly state: "open" | "closed" | "merged";
    readonly headRef: string;
    readonly headSha: string;
    readonly baseRef: string;
    readonly labels: ReadonlyArray<string>;
    readonly author: string;
    readonly assignees: ReadonlyArray<string>;
    readonly requestedReviewers: ReadonlyArray<string>;
};
export type ReviewComment = {
    readonly path: string;
    readonly line: number;
    readonly body: string;
};
export type NewPullRequest = {
    readonly head: string;
    readonly base: string;
    readonly title: string;
    readonly body: string;
};
export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
export type NewReview = {
    readonly body: string;
    readonly commitSha: string;
    readonly comments: ReadonlyArray<ReviewComment>;
    readonly event?: ReviewEvent;
};
export type SubmittedReview = {
    readonly author: string;
    readonly state: string;
    readonly commitSha: string;
};
export type NewCommit = {
    readonly message: string;
    readonly tree: string;
    readonly parents: ReadonlyArray<string>;
};
export type RefCommit = {
    readonly sha: string;
    readonly message: string;
};
export type MergeMethod = "merge" | "squash" | "rebase";
export type MergeRequest = {
    readonly method: MergeMethod;
    readonly sha: string;
};
export type Merged = {
    readonly sha: string;
};
export type CiState = ({
    state: "pending";
    waitingOn: Array<string>;
} | {
    state: "green";
} | {
    state: "red";
    failedChecks: Array<string>;
}) & {
    readonly caveat?: string;
};
export type CiFailedRun = {
    readonly name: string;
    readonly url: string;
    readonly job: Option.Option<number>;
    readonly workflowRun: Option.Option<number>;
};
export type CiReport = CiState & {
    readonly failedRuns: ReadonlyArray<CiFailedRun>;
};
export type CiFailureDetails = {
    readonly url: string;
    readonly logTail: Option.Option<string>;
};
export type CommitCiOptions = {
    readonly event?: string;
};
declare const GitHub_base: Context.ServiceClass<GitHub, "@chernabog/sdk/GitHub", {
    readonly queuedIssues: Effect.Effect<ReadonlyArray<Issue>, GitHubError>;
    queuedIssuesLabelled(label: string): Effect.Effect<ReadonlyArray<Issue>, GitHubError>;
    readonly oldestQueued: Effect.Effect<Option.Option<number>, GitHubError>;
    issuesLabelled(label: string): Effect.Effect<ReadonlyArray<Issue>, GitHubError>;
    issue(number: number): Effect.Effect<Issue, NotFound | GitHubError>;
    createIssue(issue: NewIssue): Effect.Effect<Issue, GitHubError>;
    subIssues(parent: number): Effect.Effect<ReadonlyArray<LinkedIssue>, GitHubError>;
    addSubIssue(parent: number, child: number): Effect.Effect<void, GitHubError>;
    blockedBy(issue: number): Effect.Effect<ReadonlyArray<LinkedIssue>, GitHubError>;
    addBlockedBy(issue: number, blocker: number): Effect.Effect<void, GitHubError>;
    removeBlockedBy(issue: number, blocker: number): Effect.Effect<void, GitHubError>;
    trustedComments(number: number): Effect.Effect<ReadonlyArray<Comment>, GitHubError>;
    comments(number: number): Effect.Effect<ReadonlyArray<Comment>, GitHubError>;
    comment(number: number, body: string): Effect.Effect<void, GitHubError>;
    addLabel(number: number, label: string): Effect.Effect<void, GitHubError>;
    removeLabel(number: number, label: string): Effect.Effect<void, GitHubError>;
    moveToStatus(number: number, status: string): Effect.Effect<void, GitHubError>;
    assignSelf(number: number): Effect.Effect<void, GitHubError>;
    readonly login: Effect.Effect<string, GitHubError>;
    branchSha(branch: string): Effect.Effect<Option.Option<string>, GitHubError>;
    createBranch(branch: string, sha: string): Effect.Effect<"created" | "already-exists", GitHubError>;
    deleteBranch(branch: string): Effect.Effect<void, GitHubError>;
    createCommit(commit: NewCommit): Effect.Effect<string, GitHubError>;
    createRef(ref: string, sha: string): Effect.Effect<"created" | "already-exists", GitHubError>;
    ref(ref: string): Effect.Effect<Option.Option<RefCommit>, GitHubError>;
    deleteRef(ref: string): Effect.Effect<void, GitHubError>;
    updateRef(ref: string, sha: string): Effect.Effect<void, GitHubError>;
    pullRequest(number: number): Effect.Effect<PullRequest, NotFound | GitHubError>;
    pullRequestForBranch(branch: string): Effect.Effect<Option.Option<PullRequest>, GitHubError>;
    pullRequestsLabelled(label: string): Effect.Effect<ReadonlyArray<PullRequest>, GitHubError>;
    readonly openPullRequests: Effect.Effect<ReadonlyArray<PullRequest>, GitHubError>;
    requestReviewers(pullRequest: number, logins: ReadonlyArray<string>): Effect.Effect<void, PullRequestClosed | GitHubError>;
    reviews(pullRequest: number): Effect.Effect<ReadonlyArray<SubmittedReview>, GitHubError>;
    openPullRequest(pullRequest: NewPullRequest): Effect.Effect<PullRequest, GitHubError>;
    ciState(pullRequest: number): Effect.Effect<CiState, GitHubError>;
    commitCiState(sha: string, options?: CommitCiOptions): Effect.Effect<CiReport, GitHubError>;
    branchCiState(branch: string): Effect.Effect<CiReport, GitHubError>;
    ciFailureDetails(run: CiFailedRun): Effect.Effect<CiFailureDetails, GitHubError>;
    pullRequestFiles(pullRequest: number): Effect.Effect<ReadonlyArray<string>, GitHubError>;
    closedPullRequestsLabelled(label: string): Effect.Effect<ReadonlyArray<PullRequest>, GitHubError>;
    review(pullRequest: number, review: NewReview): Effect.Effect<void, PullRequestClosed | GitHubError>;
    reviewComments(pullRequest: number): Effect.Effect<ReadonlyArray<ReviewNote>, GitHubError>;
    merge(pullRequest: number, merge: MergeRequest): Effect.Effect<Merged, MergeRefused | PullRequestClosed | GitHubError>;
    request(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body: Option.Option<Json>): Effect.Effect<Json, GitHubError>;
}>;
export declare class GitHub extends GitHub_base {
}
declare const Git_base: Context.ServiceClass<Git, "@chernabog/sdk/Git", {
    run(args: ReadonlyArray<string>, cwd: string): Effect.Effect<string, GitError>;
    headSha(cwd: string): Effect.Effect<string, GitError>;
    commitsAhead(cwd: string, base: string): Effect.Effect<number, GitError>;
    changedFiles(cwd: string, base: string): Effect.Effect<ReadonlyArray<string>, GitError>;
    push(cwd: string, branch: string): Effect.Effect<void, PushRejected | GitError>;
    pull(cwd: string, branch: string): Effect.Effect<void, GitError>;
}>;
export declare class Git extends Git_base {
}
declare const Worktree_base: Context.ServiceClass<Worktree, "@chernabog/sdk/Worktree", {
    ensure(branch: string, runId?: string): Effect.Effect<string, GitError>;
    pathFor(branch: string): string;
    remove(branch: string): Effect.Effect<void, GitError>;
    checkout(name: string, ref: string): Effect.Effect<string, GitError>;
}>;
export declare class Worktree extends Worktree_base {
}
export type LaunchDecision = {
    readonly launch: boolean;
    readonly reason: string;
};
declare const Usage_base: Context.ServiceClass<Usage, "@chernabog/sdk/Usage", {
    readonly gate: Effect.Effect<LaunchDecision, UsageError>;
    readonly checkAccount: Effect.Effect<string, UsageError>;
}>;
export declare class Usage extends Usage_base {
}
export type AgentResult = {
    readonly sessionId: string;
    readonly output: Json;
    readonly costUsd: Option.Option<number>;
};
export type AgentRequest = {
    readonly cwd: string;
    readonly prompt: string;
    readonly sessionId: string;
    readonly resumePrompt: Option.Option<string>;
    readonly outputSchema: Option.Option<Json>;
    readonly adapter: Option.Option<string>;
    readonly withPerson?: boolean;
    readonly step?: string;
};
declare const Agent_base: Context.ServiceClass<Agent, "@chernabog/sdk/Agent", {
    run(request: AgentRequest): Effect.Effect<AgentResult, AgentError>;
    readonly adapters: ReadonlyArray<string>;
}>;
export declare class Agent extends Agent_base {
}
declare const ReviewerSeat_base: Context.ServiceClass<ReviewerSeat, "@chernabog/sdk/ReviewerSeat", {
    readonly login: Effect.Effect<string>;
}>;
export declare class ReviewerSeat extends ReviewerSeat_base {
}
declare const Runs_base: Context.ServiceClass<Runs, "@chernabog/sdk/Runs", {
    isActive(runId: string): Effect.Effect<Option.Option<boolean>>;
}>;
export declare class Runs extends Runs_base {
}
declare const RunLog_base: Context.ServiceClass<RunLog, "@chernabog/sdk/RunLog", {
    log(line: string): Effect.Effect<void>;
    step(name: string): Effect.Effect<void>;
    stepDone(name: string): Effect.Effect<void>;
}>;
export declare class RunLog extends RunLog_base {
}
export {};
```

## stage.ts

```ts
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type { Json } from "./json.ts";
import type { Agent, Git, GitHub, Repo, Run, RunLog, Usage, Worktree } from "./services.ts";
export type StageServices = Repo | Run | GitHub | Git | Worktree | Usage | Agent | RunLog;
export type Stage<I, O, E> = {
    readonly name: string;
    readonly input: Schema.Codec<I, Json>;
    readonly output: Schema.Codec<O, Json>;
    readonly run: (input: I) => Effect.Effect<O, E, StageServices>;
};
export declare const defineStage: <I, O, E>(stage: Stage<I, O, E>) => Stage<I, O, E>;
export declare const STEP_EXIT: {
    readonly ok: 0;
    readonly skip: 78;
};
```
