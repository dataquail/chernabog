// Reviews again when the author asks: a pull request this persona reviewed
// requests its review once more. It resumes the session of its own review,
// says which findings are remediated, and approves, which merges an auto:ship
// pull request when that's safe, or requests changes again and hands the pull
// request to a person. limits.reviewRounds caps the re-reviews, and a pull
// request labelled auto:needs-human is left alone.

import { defineFlow, Review } from '@chernabog/sdk';

export default defineFlow({
  trigger: Review.reReviewTrigger,
  concurrency: 1,
  // Its trigger finds only pull requests that ask this persona for a review.
  ownWork: true,
  workflow: Review.reReviewWorkflow,
});
