// `chernabog ci apps` (#481): a repo's GitHub Apps, author and reviewer
// (#477), made from manifests. For each role it opens a listener on
// 127.0.0.1 and the browser on it: the page there posts the role's manifest
// to GitHub's new-App page, GitHub sends the person back with a code once
// they click Create, and the machine module trades it for the App and keeps
// its key. The person installs it on the repo, and the machine module adds
// it as a persona and, when asked, sets up its Environment. A role this
// machine already acts as reuses its App, so one App serves every repo of
// its owner it's installed on: the person only adds the repo to its
// installation. The person clicks; Chernabog does the rest.

import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";

import {
  type AppPlan,
  type CreatedApp,
  type InstalledApp,
  MachineCommands,
  MachineQueries,
} from "../../modules/machine/machine.platform.ts";
import { ConfigError } from "../../platform/config-error.ts";
import { Exec, execOk } from "../../platform/exec.ts";
import { fail } from "./cli.output.ts";

type Role = "author" | "reviewer";

const ROLES: ReadonlyArray<Role> = ["author", "reviewer"];

// A code GitHub sends back lasts an hour; nobody takes longer than that to click.
const WAIT = Duration.hours(1);

// How often to ask whether the App is installed on the repo yet, between
// the redirects GitHub sends back after an install.
const RECHECK = Duration.seconds(5);

// The role being set up now: its plan, the state its manifest was sent
// with, the App once GitHub has made it, and the redirect GitHub sends after
// an install, which asks for a check now.
type Session = {
  readonly role: Role;
  readonly plan: AppPlan;
  readonly state: string;
  readonly created: Deferred.Deferred<CreatedApp, ConfigError>;
  readonly nudge: Ref.Ref<Deferred.Deferred<boolean>>;
};

const escape = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const page = (title: string, body: string, status = 200) =>
  HttpServerResponse.text(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title>` +
      `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem}</style>` +
      `</head><body><h1>${escape(title)}</h1>${body}</body></html>`,
    { status, contentType: "text/html; charset=utf-8" },
  );

// The page that posts the manifest to GitHub, by itself, with the state GitHub echoes back.
const manifestPage = (session: Session) =>
  page(
    `Creating ${session.plan.name}`,
    `<p>Sending you to GitHub to create the ${session.role} App…</p>` +
      `<form id="manifest" method="post" action="${escape(`${session.plan.newAppPage}?state=${session.state}`)}">` +
      `<input type="hidden" name="manifest" value="${escape(session.plan.manifest)}">` +
      `<button type="submit">Continue to GitHub</button></form>` +
      `<script>document.getElementById("manifest").submit()</script>`,
  );

// An unguessable state for GitHub to echo back, 16 random bytes in hex.
const randomState = Effect.gen(function* () {
  const bytes = yield* (yield* Crypto.Crypto).randomBytes(16);

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}).pipe(Effect.orDie);

// The program that opens a URL in the person's default browser.
const opener = () => {
  if (process.platform === "darwin") {
    return "open";
  }

  return "xdg-open";
};

const asConfigError = (error: { readonly message: string }) =>
  new ConfigError({ message: error.message });

// The checkout's repo, as gh sees its origin.
const checkoutRepo = execOk("gh", [
  "repo",
  "view",
  "--json",
  "nameWithOwner",
  "--jq",
  ".nameWithOwner",
]).pipe(
  Effect.map((stdout) => stdout.trim()),
  Effect.mapError(
    (error) =>
      new ConfigError({
        message: `couldn't tell this checkout's repo (${error.message}); name it with --repo owner/name`,
      }),
  ),
);

const flags = {
  repo: Flag.String("repo").pipe(
    Flag.withDescription(
      "The repo to install the Apps on, as owner/name (default: this checkout's)",
    ),
    Flag.optional,
  ),
  role: Flag.Literals("role", ["author", "reviewer"]).pipe(
    Flag.withDescription("Set up only this role's App (default: both)"),
    Flag.optional,
  ),
  prefix: Flag.String("prefix").pipe(
    Flag.withDescription(
      "What the Apps' names start with, before -author and -review (default: <owner>-chernabog)",
    ),
    Flag.optional,
  ),
  environments: Flag.Boolean("environments").pipe(
    Flag.withDescription(
      "Also make the repo's chernabog-author and chernabog-review Environments, holding each App's id and key for CI. Needs admin on the repo",
    ),
    Flag.withDefault(false),
  ),
  replace: Flag.Boolean("replace").pipe(
    Flag.withDescription("Make a new App for a role this machine already acts as"),
    Flag.withDefault(false),
  ),
  print: Flag.Boolean("print").pipe(
    Flag.withDescription("Print each page's URL instead of opening it in the browser"),
    Flag.withDefault(false),
  ),
};

type Flags = {
  readonly repo: Option.Option<string>;
  readonly role: Option.Option<Role>;
  readonly prefix: Option.Option<string>;
  readonly environments: boolean;
  readonly replace: boolean;
  readonly print: boolean;
};

const describeInstalled = (plan: AppPlan, done: InstalledApp, repo: string) => [
  `${plan.name}: installed on ${repo} (installation ${done.installation}); this machine acts as ${done.login}`,
  // GitHub's install page offers every repo of the owner first: say what else its key reaches.
  ...Option.toArray(
    Option.map(
      Option.liftPredicate(done.alsoOn, (others) => others.length > 0),
      (others) =>
        `  warning: its installation also covers ${others.join(", ")}; its key can write to all of them. Keep it to ${repo} under the App's Configure, Repository access`,
    ),
  ),
  ...Option.toArray(
    Option.map(
      done.environment,
      (environment) =>
        `  the ${environment} Environment holds its id (CHERNABOG_APP_ID) and key (CHERNABOG_APP_KEY)`,
    ),
  ),
];

const setUpApps = (given: Flags) =>
  Effect.gen(function* () {
    const repo = yield* Option.match(given.repo, {
      onSome: Effect.succeed,
      onNone: () => checkoutRepo,
    });

    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      return yield* new ConfigError({ message: `--repo ${repo}: name it as owner/name` });
    }

    const queries = yield* MachineQueries;
    const commands = yield* MachineCommands;
    const current = yield* Ref.make(Option.none<Session>());

    // What the listener answers: only as itself, so a page elsewhere that
    // rebinds a name to 127.0.0.1 is refused, and only for the role underway.
    const answer = (port: number) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, `http://127.0.0.1:${port}`);
        const host = Headers.get(request.headers, "host");

        if (
          !Option.exists(host, (named) =>
            [`127.0.0.1:${port}`, `localhost:${port}`].includes(named),
          )
        ) {
          return page("Refused", "<p>This page answers only as 127.0.0.1.</p>", 403);
        }

        const session = yield* Ref.get(current);

        if (Option.isNone(session)) {
          return page(
            "Nothing to set up",
            "<p>chernabog ci apps isn't setting up an App now.</p>",
            404,
          );
        }

        const underway = session.value;
        const param = (name: string) => Option.fromNullishOr(url.searchParams.get(name));

        if (url.pathname === "/start") {
          if (!Option.contains(param("state"), underway.state)) {
            return page("Refused", "<p>Open the URL chernabog ci apps printed.</p>", 403);
          }

          return manifestPage(underway);
        }

        if (url.pathname === "/created") {
          if (!Option.contains(param("state"), underway.state)) {
            return page(
              "Refused",
              "<p>GitHub sent back a state this setup didn't send; the App, if one was made, is not kept. Run chernabog ci apps again.</p>",
              403,
            );
          }

          const code = param("code");

          if (Option.isNone(code)) {
            return page("No code", "<p>GitHub sent no code back; no App was made.</p>", 400);
          }

          const created = yield* commands
            .CreateAppCommand({ code: code.value })
            .pipe(Effect.result);

          if (Result.isFailure(created)) {
            yield* Deferred.fail(underway.created, asConfigError(created.failure));

            return page("The App wasn't kept", `<p>${escape(created.failure.message)}</p>`, 502);
          }

          yield* Deferred.succeed(underway.created, created.success);

          return HttpServerResponse.redirect(created.success.installUrl, { status: 303 });
        }

        // GitHub's word that the App was installed, or its installation
        // changed. Its installation_id can be forged, so it only asks for a
        // check: the command finds the App's installation on the repo as the
        // App.
        if (url.pathname === "/installed") {
          yield* Deferred.succeed(yield* Ref.get(underway.nudge), true);

          return page(
            `Checking ${underway.plan.name}`,
            "<p>Chernabog is checking it's installed on the repo; the terminal says when it's set up. You can close this tab.</p>",
          );
        }

        return page("Not found", "", 404);
      });

    const services = yield* Effect.context<MachineCommands | MachineQueries>();

    const server = yield* BunHttpServer.make({
      hostname: "127.0.0.1",
      port: 0,
      development: false,
    });

    if (Predicate.isTagged(server.address, "UnixPathAddress")) {
      return yield* new ConfigError({ message: "the listener opened on a socket, not a port" });
    }

    const port = server.address.port;
    const origin = `http://127.0.0.1:${port}`;

    yield* server.serve(answer(port).pipe(Effect.provideContext(services)));

    const already = (yield* queries.ReadMachineSetupQuery().pipe(Effect.mapError(asConfigError)))
      .personas;

    const roles = Option.match(given.role, { onNone: () => ROLES, onSome: (only) => [only] });

    const show = (name: string, url: string, what: string) =>
      Effect.gen(function* () {
        if (given.print) {
          return yield* Console.log(`${name}: ${what}: open ${url}`);
        }

        yield* (yield* Exec).run(opener(), [url]).pipe(
          Effect.andThen(Console.log(`${name}: ${what}: opened ${url}`)),
          Effect.catch(() => Console.log(`${name}: ${what}: open ${url}`)),
        );
      });

    // Asks until the App is on the repo: at once, then each time GitHub
    // sends the person back, and every few seconds between. The first time
    // it isn't, the person is shown where to install it, unless they're
    // already on their way there.
    const installed = (
      session: Session,
      login: string,
      created: Option.Option<{ readonly id: string; readonly key: string }>,
    ) =>
      Effect.gen(function* () {
        let shown = Option.isSome(created);

        for (;;) {
          const attempt = yield* commands
            .InstallAppCommand({
              role: session.role,
              repo,
              login,
              created,
              environments: given.environments,
            })
            .pipe(Effect.result);

          if (Result.isSuccess(attempt)) {
            return attempt.success;
          }

          // Too soon for GitHub to take the new App's key: ask again shortly.
          const tooSoon = Predicate.isTagged(attempt.failure, "AppKeyNotReady");

          if (!tooSoon && !Predicate.isTagged(attempt.failure, "InstallationNotOnRepo")) {
            return yield* asConfigError(attempt.failure);
          }

          if (!shown && Predicate.isTagged(attempt.failure, "InstallationNotOnRepo")) {
            yield* show(session.plan.name, attempt.failure.installUrl, `add ${repo} to it`);
            shown = true;
          }

          const nudge = yield* Ref.get(session.nudge);

          yield* Deferred.await(nudge).pipe(Effect.timeoutOption(RECHECK));
          yield* Ref.set(session.nudge, yield* Deferred.make<boolean>());
        }
      });

    for (const role of roles) {
      const plan = yield* queries
        .PlanAppQuery({ role, repo, prefix: given.prefix, origin })
        .pipe(Effect.mapError(asConfigError));

      const session: Session = {
        role,
        plan,
        state: yield* randomState,
        created: yield* Deferred.make<CreatedApp, ConfigError>(),
        nudge: yield* Ref.make(yield* Deferred.make<boolean>()),
      };

      yield* Ref.set(current, Option.some(session));

      const setUp = Effect.gen(function* () {
        if (already.includes(plan.login) && !given.replace) {
          yield* Console.log(
            `${plan.name}: this machine acts as ${plan.login} already; checking it's installed on ${repo} (--replace makes a new App)`,
          );

          return yield* installed(session, plan.login, Option.none());
        }

        yield* show(plan.name, `${origin}/start?state=${session.state}`, "create it on GitHub");

        const app = yield* Deferred.await(session.created);

        return yield* installed(session, app.login, Option.some({ id: app.id, key: app.key }));
      });

      const done = yield* setUp.pipe(
        Effect.timeoutOrElse({
          duration: WAIT,
          orElse: () =>
            Effect.fail(
              new ConfigError({
                message: `${plan.name}: not set up within an hour; run chernabog ci apps again`,
              }),
            ),
        }),
      );

      yield* Ref.set(current, Option.none());

      for (const line of describeInstalled(plan, done, repo)) {
        yield* Console.log(line);
      }
    }
  }).pipe(
    Effect.scoped,
    Effect.catchTag("ConfigError", (error) => fail(error.message)),
  );

export const appsCommand = Command.make("apps", flags, setUpApps).pipe(
  Command.withDescription(
    "Make the repo's GitHub Apps, author and reviewer, from manifests: you click Create and Install on GitHub for each, and this machine keeps its key and acts as it. Safe to run again",
  ),
);
