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
  `chernabog ui start` opening a TCP listener for a browser is #323.
- A schema the dashboard needs and the protocol doesn't carry yet is added to
  the protocol, and its module's `<module>.contracts.ts`, not to the package.
- The bundle is built unminified, as the rest of the binary is.
