# Architecture decision records

The decisions that shape chernabog, numbered in the order they were made.
Each record says what it builds on, and which later record amends or
supersedes it.

- [1. Use-cases over a domain, behind ports](0001-ddd-use-cases-and-ports.md)
- [2. Sweeping the rest of src/ into modules, and what's left](0002-the-sweep-into-modules.md)
- [3. Use-cases don't compose each other, and recovery over clean stops](0003-use-cases-dont-compose-and-recovery-over-clean-stops.md)
- [4. @chernabog/core is the binary's contract with every repo's flows](0004-core-abi.md)
- [5. The engine runs flows; it knows no workflow](0005-the-engine-knows-no-workflow.md)
- [6. Use-cases become commands and queries](0006-use-cases-become-commands-and-queries.md)
- [7. Each module publishes one platform surface](0007-module-gateways.md)
- [8. Repositories speak the persistence vocabulary, and every read takes a specification](0008-repository-vocabulary-and-specifications.md)
- [9. The hexagon's remaining stereotypes](0009-the-hexagons-remaining-stereotypes.md)
- [10. Commands declare their unit of work](0010-commands-declare-their-unit-of-work.md)
- [11. Queries read their storage directly and never reach the domain](0011-queries-read-their-storage.md)
- [12. Each module wires itself in a `<module>.module.ts`](0012-modules-wire-themselves.md)
- [13. Side effects outside a command's boundary become event handlers](0013-event-handlers.md)
- [13. Modules import and export, and ask each other through ACL ports](0013-modules-import-and-export.md)
- [14. A module's inbound adapters live in the module](0014-inbound-adapters-live-in-their-module.md)
- [15. Lives and bus factories are named only at the composition roots](0015-composition-roots.md)
- [16. The browser tier: a React dashboard Bun bundles into the binary](0016-the-browser-tier.md)
- [17. State-changing CLI commands go through the daemon first](0017-state-changing-commands-go-through-the-daemon.md)
- [18. Token usage is the adapter's to read and the daemon's to record](0018-token-usage-and-compute-time.md)
- [19. An item's phase is a record behind a port in core, with no workflow in it](0019-run-progress-port.md)
- [20. Flows run on GitHub-hosted runners, a workflow per repo, woken by events with a sweep behind them](0020-flows-run-on-github-actions.md)
- [21. One ledger per repo holds an item's progress; the forge is input and projection](0021-one-ledger-the-forge-is-input.md)
- [22. Behavior specs in Gherkin, owned by a person, run through drivers](0022-behavior-specs-in-gherkin.md)
- [23. Runs execute in spokes, and the daemon is a hub that can end one](0023-runs-execute-in-spokes.md)
- [24. Local agent sessions run in a Docker or Podman sandbox, and reach the hub through a session API](0024-local-sessions-run-in-a-sandbox.md)
