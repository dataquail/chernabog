import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { it } from "effect-bun-test";
import { renderToStaticMarkup } from "react-dom/server";

import { DaemonStatus } from "#daemon/protocol";

import { DaemonStatusView } from "./daemon-status.tsx";
import { loadStatus } from "./status.ts";

// /status as a daemon with two repos sends it: the protocol's own encoding.
const canned = Schema.encodeSync(DaemonStatus)({
  pid: 4242,
  startedAt: "2026-10-31T09:00:00.000Z",
  busy: 0,
  reloadPending: false,
  repos: ["api", "web"].map((name) => ({
    name,
    slug: `acme/${name}`,
    status: "ready",
    message: Option.none(),
    paused: false,
    enabled: true,
    tree: Option.none(),
    launcher: Option.none(),
    flows: [],
  })),
  active: [],
  recent: [],
  skips: [],
});

// The status, as the page asks a daemon that answers every request with
// `reply`, and the URLs it asked for.
const loadFrom = (reply: Response) => {
  const asked: Array<string> = [];

  const daemon = HttpClient.make((request, url) =>
    Effect.sync(() => {
      asked.push(url.href);

      return HttpClientResponse.fromWeb(request, reply);
    }),
  );

  return loadStatus("http://daemon").pipe(
    Effect.map((status) => ({ asked, status })),
    Effect.provideService(HttpClient.HttpClient, daemon),
  );
};

describe("the daemon's status on the dashboard", () => {
  it.live(
    "asks the daemon that served the page for /api/status, and decodes it with the protocol",
    () =>
      Effect.gen(function* () {
        const { asked, status } = yield* loadFrom(Response.json(canned));

        expect(asked).toEqual(["http://daemon/api/status"]);
        expect(status.pid).toBe(4242);
        expect(status.repos.map((repo) => repo.slug)).toEqual(["acme/api", "acme/web"]);
      }),
  );

  it.live("refuses a reply that isn't a DaemonStatus", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(loadFrom(Response.json({ ...canned, pid: "4242" })));

      expect(error._tag).toBe("StatusUnavailable");
    }),
  );

  it.live("refuses a daemon that answers with an error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        loadFrom(Response.json({ error: "draining" }, { status: 503 })),
      );

      expect(error._tag).toBe("StatusUnavailable");
    }),
  );

  it.live("renders the daemon's pid, start time and repo count", () =>
    Effect.gen(function* () {
      const { status } = yield* loadFrom(Response.json(canned));

      const page = renderToStaticMarkup(<DaemonStatusView status={status} />);

      expect(page).toContain("<dt>pid</dt><dd>4242</dd>");
      expect(page).toContain('<time dateTime="2026-10-31T09:00:00.000Z">');
      expect(page).toContain("<dt>repos</dt><dd>2</dd>");
    }),
  );
});
