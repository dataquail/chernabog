// Serves the dashboard's page from this checkout with Bun's hot reload, and
// passes /api/ on to the dashboard the installed daemon already runs, with the
// cookie its token sets. A change under packages/dashboard shows in the
// browser on save, over the machine's own runs and repos. It runs none of
// chernabog's code, so the chernabog home stays as the installed daemon left
// it; what the page changes (a pause, a persona's settings, a run) it changes
// on that daemon, as the real dashboard would.
//
// Like the daemon's own listener it answers only as 127.0.0.1:<port> or
// localhost:<port>, and takes changes only from its own origin as JSON. It
// holds the token itself, so any program on the machine can read the API
// through it while it runs: stop it when you're done.
//
// Run: chernabog ui start, then bun run dev:dashboard
// (DASHBOARD_DEV_PORT moves it off 4849; CHERNABOG_HOME names another home).

import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Headers from "effect/http/Headers";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import page from "../packages/dashboard/index.html";

class DevDashboardError extends Schema.TaggedError<
  DevDashboardError,
  { readonly brand: "DevDashboardError" }
>()("DevDashboardError", { message: Schema.String }) {}

const DashboardFile = Schema.fromJsonString(
  Schema.Struct({ running: Schema.Boolean, port: Schema.Int }),
);

// Kept above the /events stream's ping, so an idle stream stays open.
const IDLE_TIMEOUT_SECONDS = 255;

// What describes this connection rather than the request, and what the
// daemon's listener checks, which the proxy sets for it.
const NOT_FORWARDED = ["host", "cookie", "origin", "referer", "connection"];
const NOT_RETURNED = ["connection", "transfer-encoding", "content-length", "content-encoding"];

const refuse = (status: number, error: string) =>
  HttpServerResponse.json({ error }, { status }).pipe(Effect.orDie);

const reads = (method: string) => method === "GET" || method === "HEAD";

const answer = (port: number, upstream: string, token: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const client = yield* HttpClient.HttpClient;
    const url = new URL(request.url, "http://dashboard");
    const local = [`127.0.0.1:${port}`, `localhost:${port}`];
    const header = (name: string) => Headers.get(request.headers, name);

    if (!Option.exists(header("host"), (host) => local.includes(host))) {
      return yield* refuse(403, `the dev dashboard answers only as ${local.join(" or ")}`);
    }

    if (!url.pathname.startsWith("/api/")) {
      return yield* refuse(404, `no route ${url.pathname}`);
    }

    // Mirrors what the daemon's listener checks of a change, before passing it on.
    if (!reads(request.method)) {
      const origins = local.map((host) => `http://${host}`);

      if (!Option.exists(header("origin"), (origin) => origins.includes(origin))) {
        return yield* refuse(403, "the dev dashboard takes changes only from its own page");
      }

      const mediaType = Option.map(header("content-type"), (value) =>
        (value.split(";")[0] ?? "").trim().toLowerCase(),
      );

      if (!Option.contains(mediaType, "application/json")) {
        return yield* refuse(415, "the dev dashboard takes changes only as application/json");
      }
    }

    const headers = Headers.setAll(Headers.removeMany(request.headers, NOT_FORWARDED), {
      host: upstream,
      origin: `http://${upstream}`,
      cookie: `chernabog_dashboard=${token}`,
      "accept-encoding": "identity",
    });

    const outgoing = HttpClientRequest.make(request.method)(
      `http://${upstream}${url.pathname}${url.search}`,
      { headers },
    );

    let sent = outgoing;

    if (!reads(request.method)) {
      sent = HttpClientRequest.bodyUint8Array(
        outgoing,
        new Uint8Array(yield* request.arrayBuffer),
        "application/json",
      );
    }

    const reply = yield* client.execute(sent);

    return HttpServerResponse.stream(reply.stream, {
      status: reply.status,
      headers: Headers.removeMany(reply.headers, NOT_RETURNED),
    });
  }).pipe(Effect.catch(() => refuse(502, `the daemon's dashboard didn't answer on ${upstream}`)));

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const user = yield* Config.String("HOME");

  const home = yield* Config.String("CHERNABOG_HOME").pipe(
    Config.withDefault(`${user}/.config/chernabog`),
  );

  const port = yield* Config.Int("DASHBOARD_DEV_PORT").pipe(Config.withDefault(4849));

  const record = yield* fs.readFileString(`${home}/dashboard.json`).pipe(
    Effect.flatMap(Schema.decodeEffect(DashboardFile)),
    Effect.mapError(
      () =>
        new DevDashboardError({ message: `no dashboard.json in ${home}: run chernabog ui start` }),
    ),
  );

  if (!record.running) {
    return yield* new DevDashboardError({
      message: "the installed daemon's dashboard is stopped: run chernabog ui start",
    });
  }

  const token = (yield* fs.readFileString(`${home}/dashboard.token`)).trim();
  const upstream = `127.0.0.1:${record.port}`;

  const server = yield* BunHttpServer.make({
    hostname: "127.0.0.1",
    port,
    idleTimeout: IDLE_TIMEOUT_SECONDS,
    // The page at /, which Bun bundles and reloads on save; the rest is /api/.
    routes: { "/": page },
    development: { hmr: true, console: true },
    disablePreemptiveShutdown: true,
  });

  yield* server.serve(answer(port, upstream, token));

  yield* Console.log(
    `dev dashboard at http://127.0.0.1:${port}/, over the daemon's at ${upstream}; edits under packages/dashboard reload on save`,
  );

  return yield* Effect.never;
});

program.pipe(
  Effect.scoped,
  Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
  BunRuntime.runMain,
);
