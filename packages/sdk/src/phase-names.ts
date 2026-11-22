// The phases an item reaches between runs, by kind of item, as the SDK names
// them: apart from Phases, so the status-label projector (StatusLabels) can
// read them without the module that records them. Phases re-exports them.

export const PHASES = {
  issue: {
    handedOff: "handed-off",
    askedQuestions: "asked-questions",
    awaitingReady: "awaiting-ready",
    readyTimedOut: "ready-timed-out",
    // implement's wait for CI on the pull request its run opened, which parked.
    awaitingCi: "awaiting-ci",
    // implement's wait for CI on a pull request it adopted, which parked: not
    // awaiting-ci, so the phase alone says the run that takes it up hands the
    // pull request off as an adopted one. Its data keeps the pull request,
    // which isn't on the issue's branch.
    awaitingAdoptedCi: "awaiting-adopted-ci",
    proposed: "proposed",
    planHandedBack: "plan-handed-back",
    becameEpic: "became-epic",
    // With a person (ADR 21, decision 1): handed to one, or a plan's task
    // for one; auto:needs-human is this record's projection.
    withPerson: "with-person",
    // A trusted person removed auto:needs-human from an item with-person: their
    // intent, which observer:handed-back records.
    handedBack: "handed-back",
  },
  pullRequest: {
    reviewAsked: "review-asked",
    changesAsked: "changes-asked",
    reviewAskedAgain: "review-asked-again",
    approved: "approved",
    mergeHeld: "merge-held",
    readyForPerson: "ready-for-person",
    draft: "draft",
    watched: "watched",
    // address-review's wait for CI on the fix it pushed, which parked: not
    // the issue's awaiting-ci, which is implement's.
    awaitingFixCi: "awaiting-fix-ci",
    // A watch of a merge commit's push CI that parked: post-merge's, not the
    // pull request's own CI, which awaiting-fix-ci is.
    awaitingMergeCi: "awaiting-merge-ci",
    // resolve-conflicts' wait for CI on the merge it pushed, which parked: not
    // awaiting-fix-ci, which is address-review's wait on its own fix. Its data
    // keeps the review phase it parked over, which the run that takes it up
    // records again (Conflict.waitForCi).
    awaitingConflictCi: "awaiting-conflict-ci",
    withPerson: "with-person",
    handedBack: "handed-back",
  },
  epic: {
    waiting: "waiting",
    finished: "finished",
    withPerson: "with-person",
    handedBack: "handed-back",
  },
} as const;
