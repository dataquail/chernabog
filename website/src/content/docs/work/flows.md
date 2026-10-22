---
title: The review loop
description: implement, review, re-review and address-review, how they hand pull requests to each other through GitHub's review requests, and the hybrid path.
---

Four [recipes](/chernabog/recipes/) make the review loop. A repo bakes the ones it wants into `.chernabog/flows/` when it's set up, or later with `chernabog recipes add`; none is installed unless chosen. Once baked, they're the repo's code to edit; see [Writing flows](/chernabog/flows/flows/).

| Flow        | Picks up                                                | Ends with                                     |
| ----------- | ------------------------------------------------------- | --------------------------------------------- |
| [`implement`](/chernabog/recipes/implement/) | the oldest `auto:eligible` or `auto:ship` issue         | a green pull request, and a review requested of one reviewer from the pool |
| [`review`](/chernabog/recipes/review/)    | an open pull request whose review is requested of this persona, which it hasn't reviewed | an approval, which merges an `auto:ship` pull request, or changes requested |
| [`re-review`](/chernabog/recipes/re-review/) | a pull request that asks this persona again after it reviewed | an approval, or `auto:needs-human`     |
| [`address-review`](/chernabog/recipes/address-review/) | a pull request this persona wrote whose latest review requests changes, with nothing pushed since | a green push and the reviewer asked again, or `auto:needs-human` |

The flows hand work to each other through GitHub's own review requests and reviews. With [personas](/chernabog/reference/configuration/#github-personas), one machine can be both the author and the reviewer.

## The reviewer pool

`reviewers:` in the team's `.chernabog/config.yaml` names who reviews:

```yaml
reviewers: [alice, data-quail]
```

Once a pull request's CI is green, `implement` asks one of them, at random, to review it, never the pull request's author. The choice is made once, so a resumed run asks the same person. Without a pool, or with only the author in it, the pull request is labelled `auto:needs-review` for a person to review. Every login in `reviewers:` needs write access to the repo, since the reviewer merges on the automated path; [`chernabog doctor`](/chernabog/work/commands/) checks it for each reviewer this machine acts as.

## The automated path

An issue labelled `auto:ship` instead of `auto:eligible` is implemented the same way, and its pull request carries `auto:ship` too. Chernabog merges a pull request only when it carries `auto:ship`: the reviewer that approves it calls `PullRequest.merge`, which merges only when that is safe and otherwise hands it to a person. Any other pull request, including one whose label is missing or misspelt, is left for a person to merge.

## The hybrid path

Some work needs a person through planning and implementation. `chernabog start <issue>` hands the issue to the repo's `human-initiated` flow, which opens an interactive session where the person and the agent work on it together. When they're done, `chernabog open-pr`, run from that session, hands the work back, and chernabog opens the pull request and asks a reviewer from the pool. From there `review`, `address-review` and `re-review` run as usual, with the person at the decisions: a request for changes reopens their session, and a person merges, since the pull request never carries `auto:ship`.

The pull request is labelled `hybrid` so the path shows on GitHub. No flow decides anything from it, so a missing or wrong label changes nothing.

The hybrid path is the [`human-initiated` recipe](/chernabog/recipes/human-initiated/), which a repo bakes like any other: `chernabog recipes add human-initiated`. Without it, `chernabog start` fails and says so.

## Labels

Labels are the public record people see, and some flows trigger on them. Rename any of them under [`labels`](/chernabog/reference/configuration/#repo); `chernabog labels` creates or corrects them.

| Label                      | Key                  | Set by             | Means                                                   |
| -------------------------- | -------------------- | ------------------ | ------------------------------------------------------- |
| `auto:eligible`            | `eligible`           | a person           | Queued; `implement` claims the oldest                   |
| `auto:ship`                | `ship`               | a person, `implement` | Queued on the automated path; on a pull request, chernabog merges it once approved |
| `auto:in-progress`         | `inProgress`         | `implement`, `Hybrid.claim` | A run owns the issue                                    |
| `auto:needs-review`        | `needsReview`        | `implement`        | Open and green, with no reviewer in the pool; a person reviews |
| `auto:needs-human`         | `needsHuman`         | any flow           | A loop cap or rule stopped it; no flow picks it up again |
| `auto:needs-clarification` | `needsClarification` | `implement`        | Questions are on the issue; answer and requeue          |
| `hybrid`                   | `hybrid`             | `Hybrid.openPullRequest` | On a pull request: a person worked on it with an agent; a person merges. No flow reads it |
| `auto:approved`            | `approved`           | no default flow    | Kept in the label set for flows of your own             |
| `auto:stale`               | `stale`              | no default flow    | Kept in the label set for flows of your own             |
| `auto:changes-requested`   | `changesRequested`   | no default flow    | Kept in the label set for flows of your own             |

With a `board`, an issue is queued only when it is labelled **and** its Status is `readyStatus`.
