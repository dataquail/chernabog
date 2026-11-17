# CI: two GitHub Apps, author and reviewer, tried for real

The five questions #477 asks before CI moves onto two GitHub Apps,
`chernabog-author` and `chernabog-review`. Everything here was observed on
`dataquail/chernabog-rehearsal` on 2026-11-17, with the Apps
[`chernabog ci apps`](github-apps-manifest.md) made there, unless marked
**not observed**.

## Verdict

**The design holds, with one change and three details for the build.**
An installation token's pull requests and pushes start the repo's CI. A run
job can take its environment, and so its one App key, from its matrix entry.
The reviewer environment's branch limit holds for runs on the default
branch. An App's approval counts. An App can be a ruleset's bypass actor,
scoped by the ruleset's refs.

The change: **a person can't ask for a re-review from the check.** GitHub
shows no Re-run button on a check made by an App without a webhook, which
ours have none of (`events: []`). A button the check carries itself sends
`check_run: requested_action`, and the App's own rerequest sends
`check_run: rerequested`, but neither starts a workflow: both go only to the
App's webhook. A new head SHA still asks for a re-review, through the CI
`workflow_run` the workflow already wakes on. A person who wants one without
a push adds the `chernabog:review` label.

The details are listed under [Changes to the design](#changes-to-the-design).

## Setup

- `dataquail/chernabog-rehearsal`, **public**, owned by the `dataquail`
  organization. Its `chernabog` workflow was disabled while the probes ran,
  so they couldn't start real flows, and enabled again afterwards.
- `chernabog-author` (App 5714322, installation 180921803) and
  `chernabog-review` (App 5714350, installation 180922055), each with its
  Environment holding `CHERNABOG_APP_ID` and the secret `CHERNABOG_APP_KEY`.
  `chernabog-review`'s Environment is limited to `main`.
- Each App's token was made from its key, narrowed to the rehearsal repo
  (#522).
- A temporary workflow on `main`, `probe-477.yml`, that logged every
  `check_run`, `check_suite`, `repository_dispatch`, `workflow_dispatch` and
  `schedule` event it got, and ran a two-entry matrix job,
  `environment: ${{ matrix.environment }}`, printing the App id and the key's
  length it could read.
- Branches under `probe-477/`, pull request #182 from the author App into
  `probe-477/base`, and three temporary rulesets on `probe-477/**` refs only,
  so `main` and the rehearsals were never in their way.

## Answers

### 1. Does `check_run: rerequested` start a workflow?

**No, and neither does any other way of asking from the check.**

- The reviewer App made `chernabog review` on #182's head, `queued`, then
  `in_progress`, then `completed` with `action_required` (and a
  `details_url`, which `action_required` asks for). Its `created` and
  `completed` events **did** start `probe-477`, as did the suite's
  `check_suite: completed`.
- `POST /check-runs/{id}/rerequest` with a person's token: **404**. The
  endpoint is an App's.
- The same call with the reviewer App's token: **201 `{}`**, and no
  workflow ran in the next three minutes. The check didn't change.
- In the UI, the maintainer found **no Re-run** on the check.
- The check was given a button of its own (`actions:
[{ label: "Review again", identifier: "rereview" }]`). The maintainer
  clicked it, and no `check_run: requested_action` run came. The one
  `check_suite: completed` run after it came from adding the button, which
  updated the suite at 15:42:29.

Also seen: those `check_run` and `check_suite` events name
**`chernabog-author[bot]` as their `sender`**, the head's pusher, not the App
that made the check. `check_run.app.slug` says `chernabog-review`.

### 2. Does an App's `APPROVE` count toward required approvals?

**Yes.** A ruleset on `probe-477/base` asked for one approval, with approval
from someone other than the last pusher (`require_last_push_approval`).
#182's `reviewDecision` was `REVIEW_REQUIRED`. After
`chernabog-review[bot]`'s `APPROVE`, it was `APPROVED`. The author App had
pushed last. `mergeStateStatus` went from `BLOCKED` to `UNSTABLE`, held only
by the `action_required` check. As #477 says, this is for the record: the
required check is the gate.

### 3. Can an App bypass a ruleset, limited to `chernabog/threads/*`?

**Yes.** An organization repo's ruleset takes an App as an `Integration`
bypass actor (`actor_id` is the App id), and the ruleset's
`conditions.ref_name` is what the bypass is limited to. Two rulesets,
standing in for the real ones under `probe-477/`:

- `probe-477-threads-write`: `creation` and `update` on
  `probe-477/threads/**`, the reviewer App bypassing.
- `probe-477-others`: `creation` and `update` on every other `probe-477/**`
  branch, the author App and the admin role bypassing.

| As       | Write                                              | Result            |
| -------- | -------------------------------------------------- | ----------------- |
| reviewer | create `probe-477/threads/by-review`               | made              |
| reviewer | commit to it                                       | made              |
| author   | create `probe-477/threads/by-author`               | **refused**, 422  |
| reviewer | create `probe-477/other-by-review`                 | **refused**, 422  |
| reviewer | commit to the author's pull request branch         | **refused**, rule |
| author   | create `probe-477/other-by-author`                 | made              |
| reviewer | create `refs/chernabog/claims/probe-477-by-review` | made: no ruleset  |

A ruleset only restricts, so "the reviewer may push only to
`chernabog/threads/*`" is the second ruleset: every other branch, which the
author App and people bypass and the reviewer doesn't. A thread ruleset with
the reviewer as a bypass actor lets it write records there, beside whoever
else writes them. Claim refs live outside `refs/heads/`, where branch
rulesets don't reach, so both Apps can claim.

### 4. Can `environment:` come from the matrix, and does its branch limit hold for default-branch runs?

**Yes, and yes.**

| Run                                                 | `chernabog-author`         | `chernabog-review`         |
| --------------------------------------------------- | -------------------------- | -------------------------- |
| `repository_dispatch` (44115091590), `main`         | App 5714322, 1674-byte key | App 5714350, 1678-byte key |
| `workflow_dispatch` (44115093688), `main`           | App 5714322, 1674-byte key | App 5714350, 1678-byte key |
| `workflow_dispatch` (44115100840), `probe-477/side` | App 5714322, 1674-byte key | **refused**                |
| `schedule`                                          | **not observed**           | **not observed**           |

Each matrix entry read only its own environment's id and key. The refusal:
`Branch "probe-477/side" is not allowed to deploy to chernabog-review due to
environment protection rules.` The job never started.

The `schedule` row is **not observed**: the probe's `*/5 * * * *` cron never
ran in the hour and three quarters it was on `main`, as GitHub often does
with a schedule a workflow has just been given. A scheduled run's ref is the
default branch, as the rehearsal's own `chernabog` schedule runs show
(44013647721: `head_branch` `main`), and the branch limit is checked against
that ref, as the dispatch runs show. Stage 1's full loop runs the real
workflow's schedule, which will show it.

### 5. Do the author App's push and pull request start the repo's `pull_request` CI?

**Yes.** With the author App's token, a commit through the contents API, then
#182 through `gh pr create`, started `ci` on `pull_request` (44115190329).
#182's author is `app/chernabog-author`, and the commit's is
`chernabog-author[bot]`. A `git push` over HTTPS with the token
(`x-access-token`) started `ci` again on `synchronize` (44115527092). This is
what decision 8 used a persona for, and an installation token does it too.

## Also found

- **Each App gets a check suite on every push.** An App with checks write has
  a `queued` suite made for it on each new head, with no runs in it, as the
  reviewer did on `main` and the thread branch. It shows nowhere until the
  App adds a run.
- **An installation reaches every repo it covers** unless its token is
  narrowed: the author App's un-narrowed token listed six `dataquail` repos,
  `dataquail/chernabog` among them. #522 narrows the daemon's tokens; the
  workflow's token step must pass `repositories:` too.

## Changes to the design

1. **A review is asked for by a new head SHA, or by the `chernabog:review`
   label.** This replaces "the check's Re-run button" in #477's decisions,
   as the maintainer decided on 2026-11-17:
   - The reviewer's trigger finds open pull requests with green CI whose
     head has no `chernabog review` check, or that carry `chernabog:review`.
     A new head comes to it through the CI `workflow_run` the workflow
     already wakes on.
   - A person asks by adding the label, which needs triage permission and
     shows on the timeline. The workflow adds `labeled` to its
     `pull_request` types, and the plan job ignores every other label. A
     `/review` comment was passed over: `issue_comment` fires on every
     comment and needs the commenter's permission checked. So was "Run
     workflow" with a pull request's number, which shows nothing on it.
   - The same label asks for a first review of a pull request the author App
     didn't open. It's #477's "asking for review in another agreed way".
   - On a head the reviewer has already reviewed, the label asks for a full
     review from scratch, whose verdict replaces the check's conclusion.
     Rechecking earlier findings is for a new head.
   - The reviewer takes the label off when it starts, which shows the ask was
     taken and lets a person ask again. The plan job's reservation keeps two
     plans from starting it twice.
   - `check_run` doesn't belong in the `on:` block: none of its events is a
     person's ask.
2. **The self-event guard reads the check's App, not the sender.** A
   `check_run` or `check_suite` event's `sender` is the head's pusher, so a
   reviewer's own check reads as the author's event. The guard and any
   trigger reading those events use `check_run.app.slug` (and
   `performed_via_github_app` elsewhere), as #477's guards chunk says.
3. **The reviewer's write limit is a ruleset over every other branch.** Stage
   1 and 2 set up two rulesets: the thread ruleset, with both Apps and the
   persona team as bypass actors, and an "everything else" ruleset with
   `creation` and `update`, which the author App and people bypass. `doctor`
   checks both.
4. **The workflow's token step narrows the token.** `actions/create-github-app-token`
   gets `repositories: ${{ github.event.repository.name }}` and the role's
   `permission-*` inputs, so a job's token reaches only its repo, with only
   what its role needs.

## Cleanup

After the probes: `probe-477.yml` was removed from `main`; the `probe-477/*`
branches, the claim ref and the three rulesets were deleted; #182 was closed;
the `chernabog` workflow was enabled again.
