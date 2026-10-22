// Answers a review that asks for changes on a pull request this persona
// wrote, in the session that wrote the code. It considers the findings first:
// when it disagrees, it replies with its reasons and hands the pull request to
// a person, without pushing. Otherwise it makes the changes, runs the local
// gate, pushes, waits for CI and asks the reviewer again, whose re-review
// takes it from there.

import { defineFlow, Implement, Review } from '@chernabog/sdk';

export default defineFlow({
  trigger: Review.addressTrigger,
  gate: Implement.gate,
  concurrency: 1,
  // Its trigger finds only pull requests this persona wrote.
  ownWork: true,
  workflow: Review.addressWorkflow,
});
