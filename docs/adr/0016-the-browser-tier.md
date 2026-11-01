# 16. The browser tier: a React dashboard Bun bundles into the binary

Status: accepted, 2026-10-31. Issue #322, the first task of the dashboard epic
(#321). Follows `dataquail/functional-domain-driven-hexagon`'s `packages/web`:
a workspace package with its own tsconfig and resolve scope, which reaches the
server only through what the server says on the wire.

## Context

The dashboard epic puts the TUI's views in a browser, served by the daemon.
Until now every line of chernabog ran in Bun: `tsconfig.json` types `src/`
against Bun and no DOM, and the binary is one `bun build --compile` of the
CLI. A page needs DOM types, JSX and a bundle for a browser, and it has to
ship inside that same binary, so a person installs nothing more than they do
today.

The page decodes what the daemon says with the daemon's own schemas
(`src/interface/daemon/daemon.protocol.ts`). That file named the runs
module's `runs.platform.ts`, which also publishes the workflow engine; a
browser bundle of it failed on `bun:sqlite`.

## Decisions

1. **A browser tier, `packages/dashboard`.** It is a private workspace
   package: `react` and `react-dom` pinned exactly, as everything here is, and
   its own `tsconfig.json` (`lib: ["dom", "esnext"]`, `jsx: "react-jsx"`), so
   DOM types never reach `src/`, whose tsconfig never includes it.
   `bun run check` type-checks both. It is private and has no release-please
   entry: it ships only inside the binary.
2. **React, bundled by Bun through an HTML import.** `packages/dashboard/index.html`
   loads `src/main.tsx`. The daemon imports the HTML and serves it at `/` on
   its socket through `Bun.serve`'s `routes`, which also serve the scripts the
   page loads; `bun build --compile` bundles the page and embeds it, so the
   binary serves it with no files beside it. No Vite: Bun is already the
   bundler, the test runner and the runtime, and a second toolchain would
   build the page apart from the binary that serves it. React because the
   epic's plan chose it and Bun transpiles its JSX itself, where a framework
   with its own compiler (Svelte, Vue's single-file components) would need a
   bundler plugin to build at all.
3. **A workspace package, not a folder of `src/`.** The package boundary is
   what keeps the DOM out of the daemon's types and the daemon's runtime out
   of the page: its own tsconfig, its own dependencies, its own resolve scope
   in `architecture.yaml`, and its own node there.
4. **What it may import: effect, React, its own files, and the daemon's
   protocol.** It names the protocol as `#daemon/protocol`, a path in its
   tsconfig, and decodes every answer with the protocol's schemas; it never
   redeclares a shape the daemon owns. Nothing else under `src/`: the
   `dashboard-reaches-no-server` reach rule holds every route from the
   package to the protocol, the modules' contracts, their domains and the
   kernel.
5. **A module publishes what the protocol carries on `<module>.contracts.ts`.**
   It re-exports value objects and events from the module's domain alone, and
   only the protocol names it. The protocol names `effect` and the modules'
   contracts, never a `<module>.platform.ts`, so what the browser bundles
   reaches no adapter, no platform and nothing of Bun's runtime. The runs
   module's is the first (`runs.contracts.ts`).

## Consequences

- `GET /` on the daemon's socket answers the page, and the daemon's
  acceptance test fetches the page and its bundle, against the source and,
  in CI's job for the binary, against the compiled binary.
  `chernabog ui start` opens a 127.0.0.1 listener for a browser (#323),
  which serves the page and the socket's routes under `/api/`.
- A schema the dashboard needs and the protocol doesn't carry yet is added to
  the protocol, and its module's `<module>.contracts.ts`, not to the package.
- The bundle is built unminified, as the rest of the binary is.

## What the epic changed

The rest of the epic (#321) built on this as follows. Each piece is its
issue's to explain; this section is the map.

- **On demand, never by default** (#323). The daemon opens no TCP port until
  a person asks: `chernabog ui start` sends `POST /dashboard/start` on the
  socket, `ui stop` sends `/dashboard/stop`, and `ui status` asks
  `GET /dashboard`. The listener is `Bun.serve` on `127.0.0.1` at the port
  asked for, else the last one, else `4848`, and a port in use is refused,
  never swapped for another. The daemon restarts on every reload and
  upgrade, so what was asked is runtime state in the home's `dashboard.json`
  (`{ running, port }`), not machine config: a daemon that starts with
  `running: true` opens the listener again, and logs and carries on
  socket-only when the port is taken. Closing the listener ends its open
  streams.
- **The socket's router, under `/api/`** (#323,
  `src/interface/daemon/dashboard.server.ts`). The TCP listener serves the
  page at `/` and passes `/api/<route>` on to the socket, so a route is
  written once and answers on both, and the page's client is the socket's
  routes with a prefix. `SOCKET_ONLY_ROUTES` keeps `/dashboard` and
  `/commands` off TCP, matched against the path as the socket's router
  decodes it, so an encoded spelling can't reach them. The guard in front of
  `/api/` is a 32-byte token in `dashboard.token` (mode 0600, stable across
  restarts, `ui --rotate-token` to replace it), which `/?token=…` trades for
  an `HttpOnly`, `SameSite=Strict` cookie; a `Host` that isn't
  `127.0.0.1:<port>` or `localhost:<port>` is refused (DNS rebinding), and so
  is a non-`GET` from another `Origin` or not `application/json` (a form
  post from a page the person visits).
- **`/events`, not polling** (#324,
  `src/interface/daemon/events-stream.event-adapter.ts`). Server-sent
  events: one `snapshot` holding what `/status` answers, then each bus event
  as `event: <_tag>`, `id: <eventId>` and the encoded event, and a ping every
  15 seconds. The client subscribes before the snapshot is computed, clients
  that connect within a second share one computation, and a reconnect gets a
  fresh snapshot with no `Last-Event-ID` replay. `DaemonEvent` grew
  enrollment's and trust's events, `RunMarkersReleased`, and three the
  daemon dispatches itself: `DaemonReloading`, `TickRan` and
  **`StatusChanged`**. `StatusChanged` covers what the bus can't hear: the
  daemon watches machine config, `paused.json`, `trust.json` and `state.db`,
  and a change from another process (a hand edit, a foreground
  `run --from-checkout` or `rehearse`) is told once a second at most as
  "ask `/status` again". A change the daemon made itself is on the bus
  already and doesn't echo. The page refetches `/api/status` once per burst
  of events, and backs off and reconnects when the stream drops.
- **`POST /commands/:tag` and its two allowlists** (#326, #330;
  [ADR 17](0017-state-changing-commands-go-through-the-daemon.md)). The
  CLI's state-changing commands go through the daemon so their events reach
  this bus. `DAEMON_COMMAND_LISTENERS`
  (`src/interface/daemon/daemon-commands.client.ts`) says which tags each
  listener dispatches: the socket, enrollment's seven and trust's
  `TrustRepoCommand`; TCP, at `/api/commands/:tag`, only `PauseRepoCommand`,
  `ResumeRepoCommand`, `SetPersonaFlowCommand`, `SetFlowScheduleCommand` and
  `SetPersonaAccountCommand`. Enrolling and unenrolling name paths on disk,
  and trusting grants a repo's code the right to run, so a browser holding
  the cookie still can't. TCP lets through exactly those five
  `/commands/<tag>` paths, and `SOCKET_ONLY_ROUTES` keeps the rest of
  `/commands` off it.
- **The routes the page added** (#328, #329). `GET /runs/:id` takes a unique
  prefix of the id; `GET /runs/:id/log` streams a run's log over SSE until
  the run ends; `POST /run` and `/cancel` (`by: "dashboard"`) are the CLI's
  own; `POST /runs/:id/attach` has the daemon bring a run's session up in
  its launcher on its own machine, because a browser can't take over a
  terminal. Every refusal is the daemon's `Refusal`, shown beside the
  control that asked and never retried.
