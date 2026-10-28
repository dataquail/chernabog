# @chernabog/core

The contract between the `chernabog` binary and every repo's flows: the flow shape and the hooks the daemon calls (`defineFlow`, `trigger`, `item`, `gate`, `stillValid`), the durable primitives a run in flight resumes by (`activity`, `step`, `sleep`, `awaitSignal`, `gone`), the typed errors, the service ports (`GitHub`, `Git`, `Worktree`, `Agent`, `Usage`, `Run`, `Repo`, `FlowPackage`), and what the daemon itself acts on whatever the flow: `Claims` and `Markers`.

Flows don't import this package directly: [`@chernabog/sdk`](https://www.npmjs.com/package/@chernabog/sdk), the blocks they're written from, re-exports all of it. The binary bundles core and supplies its own copy to every flow it runs, so a repo pins it only as a dev dependency, for types.

## Compatibility

Within a major, core only grows ([ADR 0004](https://github.com/dataquail/chernabog/blob/main/docs/adr/0004-core-abi.md)):

- a port gains methods, and never changes an existing one's signature or errors;
- the durable primitives, the hooks the daemon calls, and the names and arguments of claims and markers never change;
- anything else is a new major, and a binary keeps providing an older major through adapters for as long as it lists it.

So an SDK whose peer range is `^1.2.0` runs on every binary that provides core 1.2 or later in 1.x. [`API.md`](./API.md) is what this package declares, module by module; it changes only by adding within a major.
