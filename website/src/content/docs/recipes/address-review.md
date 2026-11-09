---
title: address-review
description: The address-review recipe, which answers a review that requests changes in the session that wrote the code.
---

```bash
chernabog recipes add address-review
```

Bakes `.chernabog/flows/address-review.ts`. Its prompts, `consider` and `address`, are the SDK's own unless the repo adds `.chernabog/prompts/consider.md` or `address.md`.

**Picks up** an open pull request the persona wrote whose [phase](/chernabog/operate/progress/) is `changes-asked`, by a review that requests changes on the current head, so nothing has been pushed since (`Review.changesToAddress`). The work is keyed by the record, `pr-<n>-changes-asked-<version>`, so a label, an assignee or a review count that changes neither starts nor ends it. A review a person leaves asking for changes on the head moves the pull request to `changes-asked` first, since no run was there to record it. It leaves alone a pull request labelled `auto:needs-human` or owned by another flow's run. One whose record says `changes-asked` while GitHub says otherwise, such as a head pushed to since without asking the reviewer again, is held, and `chernabog status` says why. The trigger checks the persona's own login, and the flow sets `ownWork: true`.

A pull request with no record yet, one handed off before chernabog recorded phases, is read as before, from its latest decisive review, an approval or a request for changes (comments don't count), keyed `pr-<n>-changes-<count>`. That fallback goes in a later release.

**Owns** the pull request while it runs, by its claim ref (`PullRequest.owning`), and lets it go however the run ends. [`resolve-conflicts`](/chernabog/recipes/resolve-conflicts/) owns it the same way, so it doesn't merge the base into the branch while the review is being answered; it picks the pull request up once this run has finished.

**Ends with** a green push and the reviewer asked again, which starts their [`re-review`](/chernabog/recipes/re-review/), or the pull request handed to a person with `auto:needs-human`.

## Its steps

1. `Review.changesAsked` and `Review.authorSession` — the review, and the session that implemented the pull request, from the session marker `implement` left.
2. `Review.prepareAuthorWorktree` — the author's worktree, brought up to date.
3. `Implement.considerFindings` — resumes that session and asks whether to address the findings:
   - **Disagree.** It posts "Not addressing review N:" with its reasons and hands the pull request to a person. It doesn't push, and doesn't ask the reviewer again.
   - **Agree.** `Implement.addressFindings` makes and commits the changes.
4. `Review.checkChanged`, `Implement.localGate`, `Implement.push` and `Implement.waitForCi` — checks something was committed and nothing was left uncommitted, runs the local gate, pushes, and waits for CI, fixing red up to `ciRounds`.
5. `Review.askAgain` — comments "Addressed review N:" with what changed, asks the reviewer who requested the changes to review again, and records `review-asked-again`.

On a pull request from the [hybrid path](/chernabog/recipes/human-initiated/), the session marker says a person worked in the session, so `address-review` reopens it in front of them: the person and the agent weigh the review, make the changes, and fix the local gate and CI there, together. Its push passes `{ withPerson: session.withPerson }`, so a fix that touches `humanOnlyPaths` pushes on that pull request, and goes to a person on one an unattended run opened. See [Trust](/chernabog/operate/trust/).

Anything else that stops it, such as CI still red, a failing local gate, the agent needing an answer, or a failed step, hands the pull request to a person with `auto:needs-human`. A person settles a dispute, removes the label, and asks the reviewer again if it should look again.
