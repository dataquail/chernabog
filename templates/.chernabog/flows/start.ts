// The hybrid path: `chernabog start <issue>` hands an issue to an agent and
// opens a session where a person plans and implements it with the agent.
// `chernabog open-pr`, run from that session, ends it; this flow then runs the
// local gate, pushes, opens the pull request (labelled hybrid), waits for CI
// and asks a reviewer from the pool. A person merges it. Nothing starts it on
// a schedule.

import { defineFlow, Hybrid } from '@chernabog/sdk';

export default defineFlow({
  trigger: Hybrid.trigger,
  item: Hybrid.itemFor,
  // No trigger finds work for several personas to share: each run is a person's.
  ownWork: true,
  workflow: Hybrid.workflow,
});
