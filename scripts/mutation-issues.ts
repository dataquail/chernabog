// Files or updates the issue that holds one module's surviving mutants, from
// its mutation.json (epic #574, decision 4), and closes it once none is left.
// The nightly mutation workflow runs it after each module's run. It adds no
// label: people triage first.
// Run: bun scripts/mutation-issues.ts <module> [--report <path>] [--run-url <url>] [--dry-run]
// GH_TOKEN (or GITHUB_TOKEN) authenticates it, the repo is GITHUB_REPOSITORY
// or the git remote's, and GITHUB_API_URL, as Actions sets it, moves the API.

import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as Arr from "effect/Array";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpMethod from "effect/http/HttpMethod";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";

import {
  Action,
  actionFor,
  closingComment,
  findingsOf,
  markedModule,
  MutationReport,
  type Open,
  renderIssue,
} from "./mutation-report.ts";

class MutationIssueError extends Schema.TaggedError<
  MutationIssueError,
  { readonly brand: "MutationIssueError" }
>()("MutationIssueError", {
  message: Schema.String,
}) {}

const failWith = (message: string) => () => new MutationIssueError({ message });

// A setting from the environment, unset when empty, as Actions leaves one it has no value for.
const setting = (name: string) =>
  Effect.map(Config.option(Config.String(name)), (value) =>
    Option.filter(value, (found) => found !== ""),
  );

const token = Effect.gen(function* () {
  const gh = yield* setting("GH_TOKEN");
  const actions = yield* setting("GITHUB_TOKEN");

  return yield* Effect.fromOption(Option.orElse(gh, () => actions)).pipe(
    Effect.mapError(failWith("set GH_TOKEN (or GITHUB_TOKEN) to a token that can write issues")),
  );
});

// owner/name, from a GitHub remote's URL over https or ssh.
const slugOf = (url: string) =>
  Option.flatMap(
    Option.fromNullishOr(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim())),
    (match) => Option.fromUndefinedOr(match[1]),
  );

const repo = Effect.gen(function* () {
  const named = yield* setting("GITHUB_REPOSITORY");

  if (Option.isSome(named)) {
    return named.value;
  }

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const remote = yield* spawner
    .lines(
      ChildProcess.make("git", ["remote", "get-url", "origin"], { forceKillAfter: "5 seconds" }),
    )
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

  return yield* Effect.fromOption(Option.flatMap(Arr.head(remote), slugOf)).pipe(
    Effect.mapError(
      failWith("couldn't tell the repo: set GITHUB_REPOSITORY, or run it in a checkout of one"),
    ),
  );
});

const IssueJson = Schema.Struct({
  number: Schema.Finite,
  title: Schema.String,
  body: Schema.optionalKey(Schema.NullOr(Schema.String)),
  state: Schema.String,
  pull_request: Schema.optionalKey(Schema.Unknown),
});

const IssuesJson = Schema.Array(IssueJson);
const CreatedJson = Schema.Struct({ number: Schema.Finite });

const PER_PAGE = 100;

const github = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const bearer = yield* token;
  const slug = yield* repo;

  const root = Option.getOrElse(yield* setting("GITHUB_API_URL"), () => "https://api.github.com");

  const request = <A, I>(
    method: HttpMethod.HttpMethod,
    path: string,
    schema: Schema.Codec<A, I>,
    body: Option.Option<Readonly<Record<string, string>>> = Option.none(),
  ) =>
    Effect.gen(function* () {
      const base = HttpClientRequest.make(method)(`${root}/repos/${slug}${path}`).pipe(
        HttpClientRequest.bearerToken(bearer),
        HttpClientRequest.setHeaders({
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        }),
      );

      const sent = Option.match(body, {
        onNone: () => base,
        onSome: (json) => HttpClientRequest.bodyJsonUnsafe(base, json),
      });

      const response = yield* client.execute(sent);
      const text = yield* response.text;

      if (response.status >= 300) {
        return yield* new MutationIssueError({
          message: `${method} ${path} returned HTTP ${response.status}: ${text}`,
        });
      }

      return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text);
    }).pipe(
      Effect.mapError(
        (error) => new MutationIssueError({ message: `${method} ${path}: ${error.message}` }),
      ),
    );

  // The open issues, a page at a time; GitHub lists pull requests among them.
  const openIssues = Effect.gen(function* () {
    const found: Array<typeof IssueJson.Type> = [];

    for (let page = 1; ; page += 1) {
      const listed = yield* request(
        "GET",
        `/issues?state=open&per_page=${PER_PAGE}&page=${page}`,
        IssuesJson,
      );

      for (const issue of listed) {
        if (issue.state === "open" && !("pull_request" in issue)) {
          found.push(issue);
        }
      }

      if (listed.length < PER_PAGE) {
        return found;
      }
    }
  });

  return { request, openIssues, slug };
});

// The module's open issue: the oldest whose marker names it.
const moduleIssue = (issues: ReadonlyArray<typeof IssueJson.Type>, module: string) =>
  Option.map(
    Arr.last(issues.filter((issue) => Option.contains(markedModule(issue.body ?? ""), module))),
    (issue): Open => ({ number: issue.number, title: issue.title, body: issue.body ?? "" }),
  );

type Options = {
  readonly module: string;
  readonly report: Option.Option<string>;
  readonly runUrl: Option.Option<string>;
  readonly dryRun: boolean;
};

const fileIssue = (options: Options) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { dryRun, module, runUrl } = options;

    const path = Option.getOrElse(options.report, () => `reports/mutation/${module}/mutation.json`);

    const report = yield* fs.readFileString(path).pipe(
      Effect.flatMap(Schema.decodeEffect(MutationReport)),
      Effect.mapError(
        (error) => new MutationIssueError({ message: `couldn't read ${path}: ${error.message}` }),
      ),
    );

    const api = yield* github;
    const open = moduleIssue(yield* api.openIssues, module);
    const rendered = renderIssue(module, findingsOf(report), runUrl);
    const action = actionFor(open, rendered, closingComment(module, runUrl));

    yield* Action.$match(action, {
      Nothing: () => Console.log(`No surviving mutants in ${module}, and no open issue to close.`),
      Unchanged: ({ number }) => Console.log(`#${number} is up to date.`),
      Create: ({ issue }) =>
        Effect.gen(function* () {
          if (dryRun) {
            return yield* Console.log(`Would create an issue: ${issue.title}\n\n${issue.body}`);
          }

          const created = yield* api.request(
            "POST",
            "/issues",
            CreatedJson,
            Option.some({ title: issue.title, body: issue.body }),
          );

          return yield* Console.log(`Created #${created.number}: ${issue.title}`);
        }),
      Update: ({ issue, number }) =>
        Effect.gen(function* () {
          if (dryRun) {
            return yield* Console.log(`Would update #${number}: ${issue.title}\n\n${issue.body}`);
          }

          yield* api.request(
            "PATCH",
            `/issues/${number}`,
            Schema.Unknown,
            Option.some({ title: issue.title, body: issue.body }),
          );

          return yield* Console.log(`Updated #${number}: ${issue.title}`);
        }),
      Close: ({ comment, number }) =>
        Effect.gen(function* () {
          if (dryRun) {
            return yield* Console.log(`Would close #${number}, commenting:\n\n${comment}`);
          }

          yield* api.request(
            "POST",
            `/issues/${number}/comments`,
            Schema.Unknown,
            Option.some({ body: comment }),
          );

          yield* api.request(
            "PATCH",
            `/issues/${number}`,
            Schema.Unknown,
            Option.some({ state: "closed", state_reason: "completed" }),
          );

          return yield* Console.log(`Closed #${number}`);
        }),
    });
  });

const command = Command.make(
  "mutation-issues",
  {
    module: Argument.String("module").pipe(
      Argument.withDescription("The module, as stryker/<module>.conf.mjs names it"),
    ),
    report: Flag.String("report").pipe(
      Flag.withDescription("Its mutation.json (default: reports/mutation/<module>/mutation.json)"),
      Flag.optional,
    ),
    runUrl: Flag.String("run-url").pipe(
      Flag.withDescription("The workflow run whose artifacts hold the HTML report"),
      Flag.optional,
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Print what it would write, and write nothing"),
      Flag.withDefault(false),
    ),
  },
  fileIssue,
);

// What went wrong, said once on stderr, without the stack.
Command.run(command, { version: "0.0.0" }).pipe(
  Effect.tapError((error) => Console.error(`mutation-issues: ${error.message}`)),
  Effect.provide(Layer.merge(BunServices.layer, FetchHttpClient.layer)),
  BunRuntime.runMain({ disableErrorReporting: true }),
);
