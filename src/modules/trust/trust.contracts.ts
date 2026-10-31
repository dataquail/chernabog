// The contracts surface: the value objects and events the daemon's protocol
// carries over JSON (src/interface/daemon/daemon.protocol.ts), re-exported
// from the domain alone. The dashboard decodes with the protocol in a
// browser, so nothing reached from here may name an adapter, the platform or
// Bun's runtime; trust.platform.ts, which publishes the engine, would.

export { RepoTrusted } from "./domain/trust-record/trust-record.events.ts";
