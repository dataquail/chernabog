// This binary's version: what `--version` prints and what a repo's
// `engines.chernabog` is checked against. release-please moves it in
// package.json when a release PR merges.
import Package from "../../package.json" with { type: "json" };

export const VERSION = Package.version;
