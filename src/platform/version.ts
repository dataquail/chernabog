// This binary's version: what `--version` prints, and what machine config and
// state.db are stamped with when it migrates them. release-please moves it in
// package.json when a release PR merges.
import Package from "../../package.json" with { type: "json" };

export const VERSION = Package.version;
