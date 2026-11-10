---
title: Run on GitHub Actions
description: Run a repo's flows on GitHub-hosted runners rather than your machine. Covers setup, secrets, cost, security, and what to do when a run fails.
---

A daemon runs every enrolled repo's work on one machine. A repo can also run some or all of its flows on **GitHub Actions**, on GitHub-hosted runners, so its work stops competing for your laptop. Each repo has its own workflow, `.github/workflows/chernabog.yml`, and there's no central server: the workflow reads the repo's own config.

How it runs:

- **A plan job, then a run job per item.** The plan job, [`chernabog ci plan`](/chernabog/work/commands/#ci-plan), runs the CI flows' triggers and lists the items to start. Each item gets a run job, [`chernabog ci run`](/chernabog/work/commands/#ci-run), on a runner of its own, at most `ci.maxParallel` at once.
- **Events first, with a sweep behind them.** Whatever can change a flow's answer starts the plan job: a label, a review, a pull request closing, a CI run finishing, or a [phase](/chernabog/operate/progress/) advance (sent as `repository_dispatch` `chernabog-phase`). The plan job re-reads GitHub each time, so a duplicate event only costs one plan job. A slower scheduled sweep, `ci.schedule`, plans across every item and picks up anything a dropped event missed.
- **A job ends at a phase boundary.** Where a run on your laptop would wait (for CI, a review or a person), a run job records its phase and ends rather than waiting on a billed runner. The event that settles the wait starts the next job.
- **Claims keep two runs off one item**, whether both are in CI or one is a daemon on someone's machine. You can run a flow in CI and on a daemon at once. It's only wasteful.

## Set it up

You need `chernabog` on your own machine to write the workflow, admin access to the repo to add secrets and rulesets, and a Claude subscription.

### 1. Name the flows that run in CI

In the repo's `.chernabog/config.yaml`:

```yaml
ci:
  flows: [implement, review, re-review, address-review]
  maxParallel: 1 # the most run jobs at once, across every flow
  schedule: "17 */3 * * *" # the sweep, as cron in UTC
```

Only `flows` is required. Flows not listed keep running only on a daemon. Pick an odd minute for `schedule`: GitHub starts scheduled runs late or drops them under load, most often on the hour. See [the `ci:` keys](/chernabog/reference/configuration/#repo).

### 2. Write the workflow

```sh
chernabog init
```

`init` writes `.github/workflows/chernabog.yml` whenever `ci.flows` names a flow. To write only the workflow, use `chernabog ci workflow --write`. Commit it and merge it to the default branch, which is the only branch `repository_dispatch` and the schedule start workflows on.

Don't edit the workflow by hand. When you change `ci:` or a CI flow's events, or upgrade chernabog, write it again. `chernabog doctor` says when the workflow no longer matches its config, or when it pins a different chernabog from yours.

The workflow runs `dataquail/chernabog/action` at the tag of the chernabog that wrote it, and the action installs that release.

### 3. Add the secrets

The workflow reads two repository secrets:

| Secret                    | What it is                                                     |
| ------------------------- | -------------------------------------------------------------- |
| `CLAUDE_CODE_OAUTH_TOKEN` | Your Claude subscription's token, from `claude setup-token`    |
| `CHERNABOG_TOKEN`         | The GitHub token of the persona that CI runs as                |

```sh
claude setup-token                                 # prints a token valid for one year
gh secret set CLAUDE_CODE_OAUTH_TOKEN -R owner/repo  # paste it
gh secret set CHERNABOG_TOKEN -R owner/repo          # paste the persona's token
```

**The Claude token.** `claude setup-token` makes a long-lived token for your subscription, so runs are billed to your plan's quota. Claude on a runner is interactive under tmux, as it is on your machine, never `-p`. Don't add an `ANTHROPIC_API_KEY` secret or variable: it takes precedence and bills per token. `ci run` refuses to start while it's set, even empty. The usage gate can't run in CI: a `setup-token` token can't read your subscription's usage, so runners launch without it. A plan job still checks that Claude accepts the token. To keep CI from spending more than you want, use a low `ci.maxParallel`, and keep an eye on your usage on claude.ai.

**The persona's token.** CI acts as one GitHub login, the owner of `CHERNABOG_TOKEN`. Its token pushes branches, opens pull requests, labels, comments, records phases and sends phase events. Use a persona's token, not the workflow's own `GITHUB_TOKEN`. GitHub starts no workflow for pushes and pull requests made with `GITHUB_TOKEN`, so your own CI wouldn't run on the agent's work. The workflow's `GITHUB_TOKEN` only reads the checkout. On the runner, `ci run` sets git up as that login: a credential helper that answers github.com with `CHERNABOG_TOKEN`, and the login's own name and `users.noreply.github.com` address, so the agent's commits are credited to the persona.

A **fine-grained token** limited to this one repo is best. It needs these permissions:

| Permission      | Access         | For                                                                    |
| --------------- | -------------- | ---------------------------------------------------------------------- |
| Contents        | Read and write | pushing branches, recording phases on `chernabog/threads/*`, and `repository_dispatch` |
| Pull requests   | Read and write | opening pull requests, asking for and posting reviews, merging          |
| Issues          | Read and write | labels, comments and claims                                            |
| Workflows       | Read and write | pushing a change that touches `.github/workflows/`; see [Trust](/chernabog/operate/trust/) |
| Actions         | Read           | CI runs on a pull request's branch                                     |
| Checks, Commit statuses | Read   | whether a pull request's CI is green                                   |
| Metadata        | Read           | required by GitHub for every fine-grained token                        |

A classic token, or `gh auth token --user <login>` for a persona `gh` is logged in as, needs the `repo` and `workflow` scopes. It can reach every repo that login can, so prefer the fine-grained one.

The persona needs write access to the repo. On a repo with the thread rulesets (next step), it also needs to be in the write ruleset's bypass list.

### 4. Protect the phase records

Flows that read phases record them on `chernabog/threads/*` branches. Two branch rulesets keep anyone else from rewriting or deleting them. [Run progress](/chernabog/operate/progress/#protecting-it) has the rulesets and a script that creates them. Add the persona from step 3 to the write ruleset's bypass list.

**Private repos on GitHub Free can't have rulesets.** GitHub refuses them on a private repo without a paid plan (Pro for a personal repo, Team for an organization). Phase writes still work there, but they're unprotected: anyone who can push can rewrite or delete a record, and `doctor` warns once for the repo. Chernabog has no custom-refs fallback for this case yet. Until it does, choose one of these:

- upgrade the plan;
- make the repo public, which also makes its standard runners free;
- accept unprotected records. Only people with write access can change them, and the same people can already push to the repo.

### 5. Check it

```sh
chernabog doctor
```

For a repo with `ci.flows`, `doctor` checks three things:

- the workflow matches the config;
- the workflow pins the chernabog you run;
- both secrets exist, as the repo's own or as organization secrets it can read.

It also runs the thread rulesets' checks. Then start a sweep by hand:

```sh
gh workflow run chernabog.yml -R owner/repo
```

The plan job's summary lists what it started and why each other item wasn't started.

## Cost

Standard GitHub-hosted runners are **free on public repos**. On private repos, minutes are billed to the repo's owner. These are list prices as of November 2026:

| Runner           | Per minute | Per hour |
| ---------------- | ---------- | -------- |
| Linux, 2 cores   | $0.006     | $0.36    |

| Plan        | Actions credit included each month | About this many 2-core minutes |
| ----------- | ---------------------------------- | ------------------------------ |
| GitHub Free | $12                                | 2,000                          |
| GitHub Pro  | $18                                | 3,000                          |

Team and Enterprise plans include their own credit; check the billing page of your plan. Each job is billed for every minute it starts, rounded up.

A private repo's runner has 2 cores, and a public repo's has 4, so a private repo's jobs take longer. The repo's full test suite took 6 minutes on 4 cores and 12 on 2.

**What a job costs.** Setup before the agent starts takes about 10 seconds. A run job costs roughly $0.006 × (the agent's minutes + the test minutes + 1). A plan job is billed at least a minute each time any event starts it, even when it starts nothing.

**A worked example.** Three private repos, each running agents for 2 hours a day:

- run jobs: 3 × 2 hours × 30 days = 180 hours = 10,800 minutes, about $65;
- the sweep, every 3 hours: 3 repos × 8 a day × 30 days = 720 minutes, about $4;
- plan jobs from events, say 40 a day in each repo: 3 × 40 × 30 = 3,600 minutes, about $22.

That's about $91 a month gross, or $79 after GitHub Free's $12. The same repos made public would cost nothing in Actions. Your Claude subscription's quota is spent either way.

### Keep it in check

- **Set an Actions budget.** In your account's or organization's settings, open **Billing and licensing**, then **Budgets and alerts**, and add a budget for Actions. Turn on stopping usage when it's reached, so a runaway week can't spend past it.
- **Keep event filters tight.** Every event in the workflow's `on:` block costs at least a plan-job minute, so an event that fires often in a busy repo adds up. The workflow lists only the activity `types:` that the CI flows [declare](/chernabog/flows/documents/#the-github-events-that-wake-a-flow), and the plan job exits early, before it runs any trigger, for an event that a guard refuses or that concerns no CI flow. Name only the flows you want in `ci.flows`: each one adds its events.
- **Keep `maxParallel` low.** It caps how many runners bill at once, and how many sessions spend your Claude quota at once.
- **Sweep less often.** Each sweep is a plan job. Every 3 hours is the default; events do the fast work.

## Security

Running agents in Actions puts your secrets on a machine where an agent runs code. Here is what the workflow does about it, and what it can't do.

- **Who can start a run.** Anyone can comment on, or open an issue in, a public repo. Each declared event carries a guard: it starts nothing unless whoever caused it is the repo's `OWNER`, a `MEMBER` or a `COLLABORATOR` (by the payload's `author_association`). An event that only someone with triage or write access can cause, such as adding a label, needs no such check. An event the flow's own persona caused starts nothing either, so a flow can't wake itself in a loop; only a merge and a finished CI run are exempt. A refused event costs one plan-job minute and runs no trigger.
- **Never `pull_request_target`.** It runs with the base repo's secrets on a fork's pull request. `ci workflow` refuses to write a workflow that wakes on it, and no flow can declare it. Every job checks out the default branch, never a pull request's merge commit, and git doesn't keep the workflow's token.
- **What can read the secrets.** The workflow passes both tokens only to the steps that run chernabog, never to `checkout` or `upload-artifact`. But in a run job, the agent runs in that step, so **everything the agent runs can read them**: the agent, the repo's dependency install scripts, its tests, and anything a prompt injection in an issue or a pull request talks the agent into. Keep each secret per repo, never at the organization level for repos that don't need it. Give the persona's token only this repo, and rotate both tokens if you suspect a leak.
- **Logs are artifacts.** Each run job uploads its run log and the agent's transcripts, and keeps them 5 days. A transcript holds everything the agent read: its prompt, the code and anything it printed. On a public repo, anyone signed in to GitHub can download a run's artifacts.
- **The Claude token expires after one year.** `claude setup-token`'s token stops working a year after you make it, and every run job then fails to start Claude. Put the date in your calendar, then run `claude setup-token` and `gh secret set CLAUDE_CODE_OAUTH_TOKEN` again before it expires.

## When a run fails

**A failed CI run can't be resumed.** On your machine, a run that crashes resumes where it stopped. On a runner, the detailed run history is lost with the runner. The next job for the item repeats the current phase from its start. What the agent had done isn't lost: before a job exits, `ci run` commits what the agent left uncommitted and pushes it to the branch, so the next attempt starts from that work.

A job ends without finishing its phase when:

- **the run failed**: the job exits 1;
- **it ran out of time**: `ci run` stops itself after 5½ hours, inside a hosted job's 6, lets go of the claim and leaves the phase as it was;
- **the runner died**: the claim is a 15-minute lease the job renews, so the next job can take the item soon after.

The next event for the item, or the next sweep, starts that next attempt. To retry at once, run the workflow by hand (`gh workflow run chernabog.yml`).

**To find out what went wrong**, download the failed job's artifact, `chernabog-<flow>-<item>-<run id>-<attempt>`:

```sh
gh run download <run id> -R owner/repo
```

It holds the run's log, the same lines `chernabog logs` prints on a machine, and the agent's transcripts. They're for diagnosis only. You can't resume a session from them.

### What else you'll see

- **Cancelled runs.** Each item's run jobs share a concurrency group, `chernabog-<flow>-<item>`. A later event for the same item waits for the job at work. When a third event arrives, it replaces the one waiting, and GitHub shows the replaced run as **cancelled**. That's expected and costs nothing.
- **The plan job's summary** lists each item it started, and why it left the others: held, already claimed, waiting on someone, refused by the gate, or over the flow's concurrency.
- **A scheduled workflow that stops.** GitHub turns a public repo's scheduled workflows off after 60 days with no activity in the repo, and may do the same for a private one. Events still start the workflow, but nothing sweeps up what they miss. Turn the workflow back on from the repo's Actions tab.
