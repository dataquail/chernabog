// The dashboard's listener for a browser: TCP on 127.0.0.1, which the daemon
// opens only when a person asks (POST /dashboard/start on its socket, which
// `chernabog ui` sends) and opens again when it restarts, as dashboard.json
// in the chernabog home records.
//
// It answers the page at / and the socket's router under /api/, by passing
// each request on to the socket, so a route is written once and answers on
// both. A page the person visits can't use it: every request must name
// 127.0.0.1:<port> or localhost:<port> as its Host (DNS rebinding sends
// another name), a request that changes something must come from that origin
// as JSON, and /api/ answers only a browser holding the cookie the token in
// dashboard.token sets. Of the commands the socket dispatches, a browser may
// send only the ones DAEMON_COMMAND_LISTENERS.tcp names.

import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Headers from "effect/http/Headers";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { writeFileAtomic } from "../../platform/atomic-write.ts";
import { homePaths } from "../../platform/home.ts";
import { type DashboardState, Refusal } from "./daemon.protocol.ts";
import { DAEMON_COMMAND_LISTENERS } from "./daemon-commands.client.ts";

// Where the listener opens when no one has named a port.
export const DEFAULT_DASHBOARD_PORT = 4848;

// The routes the socket answers that a browser never reaches: the
// dashboard's own controls, and the commands the daemon dispatches for the
// CLI and the TUI, but for the ones TCP may (BROWSER_COMMAND_ROUTES). A route
// only the person's own tools may call joins them here.
export const SOCKET_ONLY_ROUTES: ReadonlyArray<RegExp> = [
  /^\/dashboard(\/|$)/i,
  /^\/commands(\/|$)/i,
];

// The commands a browser may send, each as the socket's router routes it,
// spelled exactly so (DAEMON_COMMAND_LISTENERS.tcp): a repo's pause and a
// persona's settings. Enrolling, unenrolling and trusting stay the CLI's.
const BROWSER_COMMAND_ROUTES: ReadonlyArray<string> = DAEMON_COMMAND_LISTENERS.tcp.map(
  (tag) => `/commands/${tag}`,
);

const COOKIE = "chernabog_dashboard";

// What dashboard.json records: whether the person last asked for the
// listener to run, and the port they last asked for.
const DashboardRecord = Schema.Struct({ running: Schema.Boolean, port: Schema.Int });

type DashboardRecord = typeof DashboardRecord.Type;

const DashboardFile = Schema.fromJsonString(DashboardRecord);

const TOKEN = /^[0-9a-f]{64}$/;

// The page's own files, which Bun names after their hash beside it (/chunk-….js).
const PAGE_FILE = /^\/[\w.-]+\.[A-Za-z0-9]+$/;

// Kept well above the /events stream's ping, so an idle stream stays open.
const IDLE_TIMEOUT_SECONDS = 255;

// What the browser's request says about itself that the socket needn't hear,
// and what describes the connection rather than the answer.
const NOT_FORWARDED = ["host", "cookie", "origin", "referer", "connection"];
const NOT_RETURNED = ["connection", "transfer-encoding", "content-length"];

export class DashboardRefused extends Schema.TaggedError<
  DashboardRefused,
  { readonly brand: "DashboardRefused" }
>()("DashboardRefused", { message: Schema.String }) {}

// An open listener: the scope its server lives in, and its port.
type Listening = { readonly scope: Scope.Closeable; readonly port: number };

// A token as dashboard.token holds it: 32 random bytes, in hex.
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

// Compares every character, so how long it takes says nothing of the token.
const sameToken = (given: string, token: string) =>
  given.length === token.length &&
  Array.from(token).reduce(
    (differs, character, index) => differs | (character.charCodeAt(0) ^ given.charCodeAt(index)),
    0,
  ) === 0;

const urlFor = (port: number, token: Option.Option<string>) =>
  Option.match(token, {
    onNone: () => `http://127.0.0.1:${port}/`,
    onSome: (known) => `http://127.0.0.1:${port}/?token=${known}`,
  });

const refuse = (status: number, error: string) =>
  HttpServerResponse.schemaJson(Refusal)({ error }, { status }).pipe(Effect.orDie);

const reads = (method: string) => method === "GET" || method === "HEAD";

// Passes the request on to the daemon's socket, and its answer back, streamed.
// The browser going away, or the listener closing, interrupts the stream, and
// with it the request to the socket.
const forward = (socket: string, path: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const client = yield* HttpClient.HttpClient;

    // So what comes back is what the browser reads, as it is.
    const headers = Headers.set(
      Headers.removeMany(request.headers, NOT_FORWARDED),
      "accept-encoding",
      "identity",
    );

    let outgoing = HttpClientRequest.make(request.method)(`http://chernabog${path}`, { headers });

    if (!reads(request.method)) {
      const body = new Uint8Array(yield* request.arrayBuffer);

      outgoing = HttpClientRequest.bodyUint8Array(
        outgoing,
        body,
        Option.getOrElse(Headers.get(request.headers, "content-type"), () => "application/json"),
      );
    }

    const overSocket: BunFetchRequestInit = { unix: socket, timeout: false };

    const reply = yield* client
      .execute(outgoing)
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, overSocket));

    return HttpServerResponse.stream(reply.stream, {
      status: reply.status,
      headers: Headers.removeMany(reply.headers, NOT_RETURNED),
    });
  }).pipe(Effect.catch(() => refuse(502, "the daemon didn't answer on its socket")));

// Encoded, a separator or a NUL would split a path differently once the
// socket's router decodes it.
const ENCODED_SEPARATOR = /%(2f|5c|00)/i;

const decoded = Option.liftThrowable(decodeURIComponent);

// The route as the socket's router matches it, which decodes what it's sent:
// none when it doesn't decode, or holds an encoded separator or NUL.
const asRouted = (route: string) =>
  Option.liftPredicate(route, (raw) => !ENCODED_SEPARATOR.test(raw)).pipe(Option.flatMap(decoded));

// A decoded route a browser may reach: one path, none of the socket's own
// but the commands it may send.
const reachable = (route: string) =>
  !route.includes("//") &&
  (BROWSER_COMMAND_ROUTES.includes(route) || !SOCKET_ONLY_ROUTES.some((only) => only.test(route)));

// What the listener answers a request with: the checks, the token's
// landing, /api/ and the page.
const answer = (socket: string, port: number, tokenNow: Effect.Effect<string>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, "http://dashboard");
    const local = [`127.0.0.1:${port}`, `localhost:${port}`];
    const header = (name: string) => Headers.get(request.headers, name);

    if (!Option.exists(header("host"), (host) => local.includes(host))) {
      return yield* refuse(403, `the dashboard answers only as ${local.join(" or ")}`);
    }

    if (!reads(request.method)) {
      const origins = local.map((host) => `http://${host}`);

      if (!Option.exists(header("origin"), (origin) => origins.includes(origin))) {
        return yield* refuse(403, "the dashboard takes changes only from its own page");
      }

      const mediaType = Option.map(header("content-type"), (value) =>
        (value.split(";")[0] ?? "").trim().toLowerCase(),
      );

      if (!Option.contains(mediaType, "application/json")) {
        return yield* refuse(415, "the dashboard takes changes only as application/json");
      }
    }

    const token = yield* tokenNow;
    const given = Option.fromNullishOr(url.searchParams.get("token"));

    if (url.pathname === "/" && Option.isSome(given)) {
      if (!sameToken(given.value, token)) {
        return yield* refuse(
          401,
          "that token isn't this dashboard's; open the URL chernabog ui prints",
        );
      }

      return yield* HttpServerResponse.redirect("/", { status: 303 }).pipe(
        HttpServerResponse.setCookie(COOKIE, token, {
          path: "/",
          httpOnly: true,
          sameSite: "strict",
        }),
        Effect.orDie,
      );
    }

    if (url.pathname.startsWith("/api/")) {
      if (!Option.exists(Record.get(request.cookies, COOKIE), (held) => sameToken(held, token))) {
        return yield* refuse(401, "open the dashboard from the URL chernabog ui prints");
      }

      const route = url.pathname.slice("/api".length);

      if (!Option.exists(asRouted(route), reachable)) {
        return yield* refuse(404, `no route ${url.pathname}`);
      }

      return yield* forward(socket, `${route}${url.search}`);
    }

    if (reads(request.method) && (url.pathname === "/" || PAGE_FILE.test(url.pathname))) {
      return yield* forward(socket, url.pathname);
    }

    return yield* refuse(404, `no route ${url.pathname}`);
  });

// Why a port couldn't be listened on, from what Bun threw.
const whyNot = (port: number, cause: Cause.Cause<unknown>) => {
  const thrown = Cause.squash(cause);

  if (Predicate.hasProperty(thrown, "code") && thrown.code === "EADDRINUSE") {
    return `port ${port} is in use; name another with chernabog ui start --port`;
  }

  return `can't listen on 127.0.0.1:${port}: ${Cause.pretty(cause)}`;
};

// The listener, as the daemon's socket routes and its start drive it.
export const openDashboardListener = (root: string, log: (line: string) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = homePaths(root);
    const lock = yield* Semaphore.make(1);
    const open = yield* Ref.make(Option.none<Listening>());
    const services = yield* Effect.context<HttpClient.HttpClient>();
    const crypto = yield* Crypto.Crypto;
    const newToken = crypto.randomBytes(32).pipe(Effect.map(hex), Effect.orDie);

    // A dashboard.json that's missing or doesn't parse asks for nothing.
    const readRecord = fs
      .readFileString(paths.dashboard)
      .pipe(Effect.flatMap(Schema.decodeEffect(DashboardFile)), Effect.option);

    const writeRecord = (record: DashboardRecord) =>
      Schema.encodeEffect(DashboardFile)(record).pipe(
        Effect.flatMap((text) => writeFileAtomic(fs, paths.dashboard, `${text}\n`)),
        Effect.orDie,
      );

    const readToken = fs.readFileString(paths.dashboardToken).pipe(
      Effect.map((text) => Option.liftPredicate(text.trim(), (token) => TOKEN.test(token))),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

    const writeToken = (token: string) =>
      writeFileAtomic(fs, paths.dashboardToken, `${token}\n`, 0o600).pipe(
        Effect.andThen(fs.chmod(paths.dashboardToken, 0o600)),
        Effect.orDie,
        Effect.as(token),
      );

    // The token: the one in dashboard.token, or a new one, made the first time
    // the listener opens and kept, so a bookmark outlives a restart.
    const token = yield* Ref.make(Option.none<string>());

    const tokenNow = Effect.gen(function* () {
      const held = yield* Ref.get(token);

      if (Option.isSome(held)) {
        return held.value;
      }

      const known = yield* readToken;
      let made: string;

      if (Option.isSome(known)) {
        made = known.value;
      } else {
        made = yield* writeToken(yield* newToken);
      }

      yield* Ref.set(token, Option.some(made));

      return made;
    });

    // The token, if the listener has ever opened, without making one.
    const tokenKnown = Effect.gen(function* () {
      const held = yield* Ref.get(token);

      if (Option.isSome(held)) {
        return held;
      }

      return yield* readToken;
    });

    const close = (listening: Listening) => Scope.close(listening.scope, Exit.void);

    const listen = (port: number) =>
      Effect.gen(function* () {
        yield* tokenNow;
        const scope = yield* Scope.make();

        yield* BunHttpServer.make({
          hostname: "127.0.0.1",
          port,
          idleTimeout: IDLE_TIMEOUT_SECONDS,
          development: false,
          // Closing ends the streams it holds open, rather than waiting on them.
          disablePreemptiveShutdown: true,
        }).pipe(
          Effect.flatMap((server) =>
            server.serve(answer(paths.socket, port, tokenNow).pipe(Effect.provide(services))),
          ),
          Scope.provide(scope),
          Effect.catchCause((cause) =>
            Scope.close(scope, Exit.void).pipe(
              Effect.andThen(Effect.fail(new DashboardRefused({ message: whyNot(port, cause) }))),
            ),
          ),
        );

        return { scope, port } satisfies Listening;
      });

    const portNow = Effect.gen(function* () {
      const listening = yield* Ref.get(open);

      if (Option.isSome(listening)) {
        return listening.value.port;
      }

      return Option.match(yield* readRecord, {
        onNone: () => DEFAULT_DASHBOARD_PORT,
        onSome: (record) => record.port,
      });
    });

    const state = Effect.gen(function* () {
      const port = yield* portNow;

      return {
        running: Option.isSome(yield* Ref.get(open)),
        port,
        url: urlFor(port, yield* tokenKnown),
      } satisfies DashboardState;
    });

    // Opens the listener at the port asked for, else the last one, else
    // 4848; one open on another port moves there. A port in use is refused,
    // and the listener stays where it was.
    const start = (asked: Option.Option<number>) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          let port = yield* portNow;

          if (Option.isSome(asked)) {
            port = asked.value;
          }

          const listening = yield* Ref.get(open);

          if (!Option.exists(listening, (already) => already.port === port)) {
            const opened = yield* listen(port);

            yield* Effect.forEach(Option.toArray(listening), close, { discard: true });
            yield* Ref.set(open, Option.some(opened));
            yield* log(`dashboard listening on http://127.0.0.1:${port}/`);
          }

          yield* writeRecord({ running: true, port });

          return yield* state;
        }),
      );

    const stop = lock.withPermits(1)(
      Effect.gen(function* () {
        const port = yield* portNow;
        const listening = yield* Ref.getAndSet(open, Option.none());

        yield* Effect.forEach(Option.toArray(listening), close, { discard: true });
        yield* writeRecord({ running: false, port });

        if (Option.isSome(listening)) {
          yield* log(`dashboard stopped on http://127.0.0.1:${port}/`);
        }

        return yield* state;
      }),
    );

    // A new token; the cookie the old one set stops working.
    const rotate = lock.withPermits(1)(
      Effect.gen(function* () {
        const made = yield* newToken;

        yield* Ref.set(token, Option.some(yield* writeToken(made)));
        yield* log("dashboard: a new token; the old one no longer opens it");

        return yield* state;
      }),
    );

    // As the daemon starts: opens the listener again if a person last asked
    // for it, or says why it can't and carries on, socket-only.
    const restore = lock.withPermits(1)(
      Effect.gen(function* () {
        const record = yield* readRecord;

        if (Option.isNone(record) || !record.value.running) {
          return;
        }

        const { port } = record.value;

        yield* listen(port).pipe(
          Effect.flatMap((opened) => Ref.set(open, Option.some(opened))),
          Effect.andThen(log(`dashboard listening on http://127.0.0.1:${port}/`)),
          Effect.catch((refused) =>
            log(`dashboard: ${refused.message}; carrying on without it, socket-only`),
          ),
        );
      }),
    );

    // The daemon stopping closes it, and leaves dashboard.json as asked.
    yield* Effect.addFinalizer(() =>
      Ref.get(open).pipe(
        Effect.flatMap((listening) =>
          Effect.forEach(Option.toArray(listening), close, { discard: true }),
        ),
      ),
    );

    return { state, start, stop, rotate, restore };
  });
