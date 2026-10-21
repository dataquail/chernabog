// Reviews pull requests whose review is requested of the persona this runs
// as, and that it hasn't reviewed yet. Each review runs in a fresh session of
// the reviewer role (flows.review.agents, or the persona's roles pick: a
// different agent from the one that wrote the code avoids a model approving
// its own work) and is posted as a real GitHub review. An approval of an
// auto:ship pull request merges it, when that's safe; changes requested go
// back to the author.

import { defineFlow, Review } from '@chernabog/sdk';

export default defineFlow({
  trigger: Review.trigger,
  concurrency: 1,
  // Its trigger finds only pull requests that ask this persona for a review.
  ownWork: true,
  workflow: Review.workflow,
});
