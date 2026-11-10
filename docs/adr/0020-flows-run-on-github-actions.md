# 20. Flows run on GitHub-hosted runners, a workflow per repo, woken by events with a sweep behind them

Status: accepted, 2026-11-10. Epic #455 (#456 to #462). Builds on
[ADR 19](0019-run-progress-port.md) (an item's phase is a record behind a
port) and the claim refs of #133.

## Context

Every run happened on the machine running the daemon, so the work of every
enrolled repo competed for one laptop's compute. The epic (#455) moves flow
execution onto GitHub Actions, in each repo, as an alternative to the daemon
rather than a replacement for it.

The design was tested before anything was built. #456 ran it on a
GitHub-hosted runner in `dataquail/chernabog-rehearsal`
(`docs/ci/runner-test.md`). The maintainer answered the questions that needed
a real Claude token (#455's comments). This ADR records the decisions and
what that test found.

## Decisions

1. **GitHub-hosted runners, not Codespaces.** A hosted job's 6-hour limit is
   well above the longest run seen (about 2 hours). Hosted runners have what
   the tmux launcher needs: `ubuntu-latest` (now Ubuntu 26.04) ships tmux 3.6
   and Node, and installing `claude` takes 3 to 4 seconds. A runner has 4
   cores on a public repo and 2 on a private one.
2. **A workflow per repo, and no central repo.** Each repo's
   `.chernabog/config.yaml` names its CI flows (`ci.flows`, `ci.maxParallel`,
   `ci.schedule`). `chernabog init` or `chernabog ci workflow --write` writes
   `.github/workflows/chernabog.yml` from them, and `doctor` checks the two
   still match. The workflow runs `dataquail/chernabog/action` at the tag of
   the chernabog that wrote it. The action is glue: it installs that release
   and runs `chernabog ci plan` or `chernabog ci run`, where the logic lives.
3. **Events first, with a sweep behind them.** An event is only a signal to
   run the plan again. The planner stays level-triggered and re-reads
   GitHub each time, so a duplicate event costs one plan job, and a
   scheduled sweep (`ci.schedule`, `17 */3 * * *` by default) catches what a
   dropped event missed. Two kinds of event start a plan:
   - **a phase advance**, sent by its writer as `repository_dispatch`
     `chernabog-phase` (#458). A phase write can't start a workflow itself,
     because thread branches start from the empty tree, which has no
     workflows. The runner test found that a dispatch starts the default
     branch's workflow in about 7 seconds;
   - **intent and facts on GitHub**, such as a label, a review or a
     `workflow_run` completing. Each flow declares the events that can change
     its trigger's answer (#457), and the workflow's `on:` block is built
     from those declarations.
4. **A plan job, then a job per item.** The plan job runs the triggers by a
   daemon tick's rules and outputs a matrix of `{flow, persona, item}`. The
   run job fans it out with `strategy.matrix.include` and `max-parallel`.
   Within a flow, the trigger's order is the priority; across flows, the
   limit is `max-parallel`, not a ranking. The runner test found that an
   empty matrix fails the whole workflow, so the plan job writes exactly `[]`
   when it starts nothing, and the run job is guarded by
   `needs.plan.outputs.items != '[]'`.
5. **A job ends at a phase boundary.** A run that would park records its
   phase and ends its job, rather than waiting on a billed runner. The event
   that settles the wait starts the next job. A runner keeps no history, so
   **a failed CI run can't be resumed**: the next job repeats the current
   phase from its start. Before a job exits, `ci run` commits and pushes
   what the agent left, so the work survives even though the session
   doesn't. The run log and the transcripts are uploaded as an artifact,
   kept 5 days, for diagnosis only.
6. **Claims and phases for correctness, not Actions.** Claim refs and the
   phase store's compare-and-advance keep two runs off one item, including a
   CI run and a daemon on someone's machine at once. A run job's claim is a
   short lease it renews, so a killed job's claim runs out soon. The
   per-item `concurrency` group (`chernabog-<flow>-<item>`, never cancelling
   the job at work) only saves minutes. The runner test found that the run
   it replaces concludes `cancelled`, which fires `workflow_run`, so the
   workflow's `workflow_run` filter never names chernabog's own workflow.
7. **Agent sessions stay interactive.** Even on a runner, `claude` runs under
   tmux and ends on the Stop hook, never with `-p`. It authenticates with a
   subscription token from `claude setup-token`, in `CLAUDE_CODE_OAUTH_TOKEN`.
   The runner test found that a fresh home stops at the first-run theme
   picker even with the token set, so `ci run` writes a `~/.claude.json`
   with onboarding done and the checkout trusted. `ci run` refuses to start
   while `ANTHROPIC_API_KEY` is set, since it would bill per token.
8. **The workflow acts as a persona, with least access.** The workflow's own
   token only reads the checkout. Chernabog acts as the persona whose token
   is the `CHERNABOG_TOKEN` secret, because events made with `GITHUB_TOKEN`
   start no other workflow, so the repo's own CI wouldn't run on the agent's
   work. Both tokens go only to the steps that run chernabog. Every job
   checks out the default branch, and `pull_request_target` is refused
   outright.
9. **Guards against outsiders, in the plan job.** A declared event wakes a
   flow only if whoever caused it is the repo's `OWNER`, a `MEMBER` or a
   `COLLABORATOR`, by the payload's `author_association`, or if only someone
   with triage or write access could cause it (a label). An event the flow's
   own persona caused wakes nothing, except a merge and a finished CI run. A
   refused event exits before any trigger runs.

## Rejected

- **Codespaces as the run host.** A stopped codespace keeps its disk for 30
  days, so a failed run could be resumed with `claude --resume`. But it costs
  more lifecycle work (create, stop, delete, retention), it has to be kept
  awake (its idle timeout resets only on typing or terminal output), and it
  has a 12-hour hard limit. It is cheaper per hour on private repos ($0.18
  against $0.36 for 2 cores), so it is worth revisiting for private repos
  with long or delicate runs.
- **The daemon itself in a codespace.** The 12-hour limit stops it twice a
  day, and a codespace's token covers only one repo.
- **One central repo that starts work in every other repo.** Each repo's own
  workflow can do it. What's lost is coordination of Claude usage across
  repos, which the usage gate, staggered cron minutes and a low
  `max-parallel` cover.
- **Cron only.** Simpler, but a parked run would wait for the next tick
  instead of seconds.
- **A job that waits through a park.** It would bill a runner for the time a
  review or a person takes, and could outlive the 6-hour limit.
- **`check_suite` to wake runs waiting on CI.** GitHub starts no workflow for
  a check suite that Actions created. `workflow_run: completed` does the job.
- **Thread branches started from `main`, so phase writes trigger `push`.**
  #361 chose the empty root on purpose: no stray CI runs, cheap fetches, and
  threads never fall behind `main`.
- **Caching Bun's store on the runner.** A cold `bun install` took 2 to 3
  seconds, and saving the 248 MB cache took 2 to 4.

## Consequences

- A repo can run some flows in CI and others on a daemon, or the same flow
  in both. Claims keep them off each other's items.
- Cost moves from a laptop's compute to Actions minutes on private repos.
  Standard runners are free on public repos. A run job costs roughly $0.006 ×
  (agent minutes + test minutes + 1) on a private repo. Every plan job is
  billed at least a minute, so tight event `types:` and an early exit matter.
  The guide, `website/src/content/docs/operate/github-actions.md`, has a
  worked example and the guardrails.
- A run's history doesn't survive its job. A crash costs the phase's agent
  time again, though the code is kept on the branch.
- Everything in a run job can read both secrets, including dependency
  install scripts and whatever a prompt injection talks the agent into. On a
  public repo, anyone signed in to GitHub can download a run's logs. The
  Claude token expires after a year.
- Private repos on GitHub Free have no rulesets, so their phase records are
  unprotected. The custom-refs fallback that #361 named isn't built.
- Scheduled workflows are best-effort: they can start late or be dropped, and
  GitHub turns them off after 60 days without repo activity on public repos.
  `GITHUB_TOKEN` is limited to 1,000 API requests an hour per repo; a
  persona's token has its own, higher limit.
- What a real phase costs on a private repo is still to be measured on the
  first one a person runs (`docs/ci/runner-test.md`, question 6).
