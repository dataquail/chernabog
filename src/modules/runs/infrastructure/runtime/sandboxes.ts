// Where a repo's agent sessions run (ADR 24): on the host, or in a Docker or
// Podman container. A sandbox that can't start refuses the session, saying
// why, and nothing ever falls back to running it on the host (decision 2).

import type { ResolvedSandbox, SandboxName } from "@chernabog/core";
import * as Option from "effect/Option";

// Why a session in this sandbox can't start; none when it can. No container
// runtime is supported yet (#717 adds them), so docker and podman refuse.
export const sandboxRefusal = (sandbox: ResolvedSandbox): Option.Option<string> => {
  if (sandbox.name === "none") {
    return Option.none();
  }

  return Option.some(
    `sandbox ${sandbox.name} (from ${sandbox.from}) isn't supported yet: this chernabog can't run an agent session in a container yet, and never runs a sandboxed repo's session on the host instead; set sandbox: none to run on the host, where the repo's allowedSandboxes allows it`,
  );
};

// The launch spec carries only the provider's name; which layer chose it is
// the run's to say.
export const launchSandboxRefusal = (name: SandboxName) =>
  sandboxRefusal({ name, from: "the launch spec" });
