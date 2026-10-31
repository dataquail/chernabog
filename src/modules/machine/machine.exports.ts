// The machine module's PEER surface: what another module may ask of it, each
// grant named for its kind. A peer reaches it only from its own
// <module>.imports.ts, and dispatches it only from an ACL adapter or an inbound
// adapter of its own (docs/adr/0009-modules-import-and-export.md,
// docs/adr/0013-inbound-adapters-live-in-their-module.md). Publish nothing here
// without a consumer.

import { Query } from "@effect-server-utils/cqrs";

import { machineQueryGroup } from "./machine.query-handlers.ts";

// The personas and accounts this machine offers, which `enroll` chooses among.
export const machineAccessQueries = Query.subsetOf(machineQueryGroup, "ReadMachineSetupQuery");
