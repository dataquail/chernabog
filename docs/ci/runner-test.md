# CI: the design tested on a real GitHub-hosted runner

The runner test for the CI epic (#455), from #456. It checks what the epic
assumes about GitHub-hosted runners before anything is built. Everything here
was observed on `dataquail/chernabog-rehearsal` on 2026-11-09, unless marked
**not observed**.

## Verdict

**The design holds, with five changes.** Hosted runners have what the tmux
launcher needs. `repository_dispatch` starts the default branch's workflow in
about 7 seconds. Concurrency groups and the dynamic matrix work as the epic
expects, apart from two details the plan and run jobs have to handle. The
setup before an agent can start takes about 10 seconds.

The questions that need a real Claude subscription token couldn't be finished.
The rehearsal repo has no `CLAUDE_CODE_OAUTH_TOKEN` secret, and creating one
(`claude setup-token`, then storing it as a secret) is a credentials decision
for a person. What could be run without the token was run: an invalid token
showed that interactive `claude` takes its login from the variable, skips the
login screen, and calls the API with it. Whether a **valid** token gets a
working session, the usage endpoint's answer, the Stop hook ending the job and a
real phase's cost are still open. The workflow that answers them is in the
rehearsal repo, and runs as soon as the secret exists
([what a person runs](#what-a-person-runs-to-finish-questions-1-2-6-and-7)).

The changes are listed under [Changes to the design](#changes-to-the-design).

## Setup

- `dataquail/chernabog-rehearsal`, **public**, so its standard runners are free
  and have 4 vCPUs (private repos get 2).
- Four temporary workflows on its `main`, all under `runner-test-*`, triggered
  only by `workflow_dispatch` or `repository_dispatch`, so rehearsals never
  start them:
  - `runner-test-claude.yml`: the runner's tools, interactive `claude` under
    tmux, the usage endpoint, and the transcript upload.
  - `runner-test-dispatch.yml`: `repository_dispatch` with a per-item
    `concurrency` group.
  - `runner-test-matrix.yml`: a plan job's list fanned out with
    `fromJSON` and `max-parallel`.
  - `runner-test-cost.yml`: this repo's checkout, Bun install and
    `bun run test`, on all cores and pinned to 2.
- The sending token was the maintainer's OAuth token from `gh auth` (`gho_`,
  with `repo` and `workflow`). No persona was signed in to `gh`, and no
  fine-grained token was made.
- The runner image: `ubuntu-latest` is now **Ubuntu 26.04** (image
  `20261101.186.1`). GitHub's annotation on every run says the label moved to
  Ubuntu 26 on 2026-10-19.

## Answers

### 1. Interactive Claude on a runner

**Partly observed.** What a runner gives the tmux launcher, from
`runner-test-claude`:

```
nproc → 4; free → 15.9 GB RAM, 3 GB swap; 88 GB free disk
tmux 3.6 at /usr/bin/tmux, preinstalled
node v24.22.2, npm 11.19.1
TERM=dumb, LANG=C.UTF-8
ANTHROPIC_API_KEY: unset
npm install -g @anthropic-ai/claude-code → 3–4 s, claude 2.1.321
```

So tmux needs no install. `tmux new-session -d -x 200 -y 50` gives `claude` a
terminal of its own even though the job's `TERM` is `dumb`.

**A fresh home stops at onboarding, token or not.** With no `~/.claude.json`,
`claude` under tmux showed the first-run theme picker ("Let's get started.
Choose the text style that looks best with your terminal") at 5, 15 and 30
seconds, and waited. It did the same with `CLAUDE_CODE_OAUTH_TOKEN` set. So
the token alone is not enough: the run job has to write a `~/.claude.json`
first.

**Seeding `~/.claude.json` gets past every screen.** With

```json
{
  "hasCompletedOnboarding": true,
  "theme": "dark",
  "projects": { "/tmp/w3": { "hasTrustDialogAccepted": true } }
}
```

and no token, `claude` started straight at its prompt, with no theme picker,
trust dialog or login screen (it showed a one-time notice about auto mode). The
key under `projects` is the session's working directory, so the run job writes
the checkout's path there.

**The token is read in interactive mode, with no login prompt.** With the
seeded file and `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-not-a-real-token`,
started as `claude 'Reply with OK.'`, the pane at 20 seconds showed:

```
⚠ Remote managed settings failed to load (authentication rejected (401)) · no remote policy applied
❯ Reply with OK.
● Please run /login · API Error: 401 OAuth access token is invalid.
```

So `claude` took the variable as its login, skipped the login screen, sent the
prompt, and the API rejected the fake token. It also wrote a transcript, under
`~/.claude/projects/-tmp-w3/<session>.jsonl`. With a valid token, the same
request is the first turn of a working session. That is **inferred, not
observed**.

**The Stop hook: not observed.** It needs a turn that completes. The workflow's
last Claude step puts a Stop hook in the project's `.claude/settings.json` that
touches a file and kills the tmux session, and waits up to 2 minutes for it.
The step runs only when the secret exists.

What the tmux launcher needs on `ubuntu-latest`, as far as observed:

1. no install: tmux 3.6 is there;
2. a `~/.claude.json` with `hasCompletedOnboarding: true` and the checkout's
   path trusted, written before the first launch;
3. `CLAUDE_CODE_OAUTH_TOKEN` passed into the tmux session with
   `new-session -e`, since a detached session takes its environment from the
   tmux server, not from the step;
4. an explicit size (`-x`, `-y`), since there's no client to take it from.

### 2. Usage gate

**Not observed with a token.** `usage-gate.ts` calls
`GET https://api.anthropic.com/api/oauth/usage` with
`anthropic-beta: oauth-2025-04-20` and the account's bearer token. Without a
token, the runner got:

```
401 {"type":"error","error":{"type":"authentication_error","message":"x-api-key header is required"}}
```

So the endpoint is reachable from a runner and fails cleanly without
credentials. Whether it answers for a `setup-token` token with no Claude home
is the question still open. The code already allows it: for an account with
`oauthTokenEnv`, `readStoredOAuth` reads only the variable and never looks for
a keychain item or `.credentials.json`. The workflow's "usage endpoint with
the token" step answers it.

### 3. `repository_dispatch` from a persona token

**It starts the default branch's workflow.** Each dispatch's run reported
`ref=refs/heads/main`, with the sha of `main`'s tip.

**About 7 seconds from send to the first step.** Three dispatches, sent 2 to 3
seconds apart (send times to the second):

| Sent     | Run created | Job started | First step ran |
| -------- | ----------- | ----------- | -------------- |
| 23:37:16 | 23:37:19    | 23:37:21    | 23:37:23.4     |
| 23:37:18 | 23:37:22    | 23:37:24    | 23:37:25.6     |
| 23:37:21 | 23:37:24    | 23:37:25    | 23:37:26.2     |

The API answers `204 No Content` and returns no run id, so the sender can't
tell which run its event started.

**Payload limits, observed:**

| Sent                                      | Result                                                          |
| ----------------------------------------- | --------------------------------------------------------------- |
| 10 top-level `client_payload` properties  | 204                                                             |
| 11 top-level properties                   | 422 `No more than 10 properties are allowed; 11 were supplied.` |
| 1 property holding an object with 20 keys | 204: the limit counts top-level keys only                       |
| `client_payload` of about 65,500 bytes    | 204                                                             |
| `client_payload` about 10 bytes larger    | 422 `client_payload is too large.`                              |
| `event_type` of 101 characters            | 422 `Only 100 characters are allowed; 101 were supplied.`       |

So the limit is 64 KiB of `client_payload` and 10 top-level keys. `{item,
phase}` is far inside both.

**Smallest permission on a fine-grained token: not observed.** No persona was
signed in and no fine-grained token was made. GitHub's REST reference for
"Create a repository dispatch event" lists **Contents: write** as the
fine-grained permission. A classic or OAuth token needs `repo` (the
maintainer's `gho_` token, with `repo`, worked). Write access to the repo is
required either way, as the epic says.

### 4. Concurrency groups

**Confirmed.** `runner-test-dispatch.yml` has

```yaml
concurrency:
  group: runner-test-${{ github.event.client_payload.item }}
  cancel-in-progress: false
```

Three events for the same item, each sleeping 90 seconds, sent 4 to 5 seconds
apart:

| Event | Created  | Outcome                                                    |
| ----- | -------- | ---------------------------------------------------------- |
| 1     | 23:37:34 | ran 23:37:37–23:39:10, `success`                           |
| 2     | 23:37:39 | `pending`, then **`cancelled`** at 23:37:43 when 3 arrived |
| 3     | 23:37:42 | `pending` until 1 finished; ran from 23:39:13              |

So the second waits, the third replaces it, and the waiting run starts 3
seconds after the running one ends. Events for other items ran at once.

The replaced run ends with conclusion `cancelled`, not `skipped`. It shows as
a cancelled run in the Actions list, and it fires `workflow_run: completed`
for any workflow that names this one in its `workflows:` list. The epic uses
`workflow_run` to wake runs waiting on CI, so chernabog's workflow must not
name itself there.

### 5. Dynamic matrix

**An empty list fails the run, unless the run job is guarded.** The plan job
wrote `items=<input>` to `$GITHUB_OUTPUT`, and the run job used
`matrix: { item: ${{ fromJSON(needs.plan.outputs.items) }} }` with
`max-parallel: 2`.

| Plan output | Run job's `if`                     | Result                                                                                                                       |
| ----------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `[]`        | none                               | **Workflow `failure`**: `Error when evaluating 'strategy' for job 'run'. … Matrix vector 'item' does not contain any values` |
| `[]`        | `needs.plan.outputs.items != '[]'` | `success`, run job `skipped`                                                                                                 |
| 5 items     | same guard                         | `success`; at most 2 ran at once: two from 23:37:22, the next two from 23:37:47, the fifth from 23:38:12                     |

Matrix entries can be objects: `{"flow":"review","item":1}` showed in the job
name as `run (review, 1)`. So the plan job's `{flow, persona, item}` works as
the matrix entry, and needs the guard on the run job.

### 6. Cost of one run

**A real phase: observed in #465**, on 2026-11-10 with v0.16.3. A label
started the chain on `dataquail/chernabog-rehearsal`, with no daemon in any CI
step
([run 42867256974](https://github.com/dataquail/chernabog-rehearsal/actions/runs/42867256974)):

| Job                                                                    | Time   | Billed on a private repo |
| ---------------------------------------------------------------------- | ------ | ------------------------ |
| Plan, for `issues: labeled`                                            | 18 s   | 1 min                    |
| Run, implement: claim, agent, push, open the PR, wait for CI, hand off | 2m 13s | 3 min                    |
| Plan, for `chernabog-phase` `review-asked`                             | 13 s   | 1 min                    |
| Plan, for `chernabog-phase` `handed-off`                               | 11 s   | 1 min                    |

About 1 minute 10 seconds of the run job was waiting on the pull request's
CI. The repo is public, so nothing was billed; on a private repo this chain
would bill 6 minutes, about $0.04. Each phase advance started its workflow
run about 4 seconds later, against question 3's 7.

Before that, #456 couldn't run a phase without the token, and #460, which
built `chernabog ci run`, was implemented by an unattended agent with no
runner, secret or workflow to run it on. What #456 measured is everything
around the agent.

Setup before an agent can start (from `runner-test-cost` and
`runner-test-claude`):

| Step                                                       | Time      |
| ---------------------------------------------------------- | --------- |
| Job queued to started                                      | 1–3 s     |
| Set up job                                                 | 1 s       |
| `actions/checkout` of `dataquail/chernabog`, depth 1       | 2 s       |
| `oven-sh/setup-bun`                                        | 1 s       |
| `actions/cache` restore of `~/.bun/install/cache` (a miss) | under 1 s |
| `bun install --frozen-lockfile`, cold                      | 2–3 s     |
| `actions/cache` save afterwards (248 MB)                   | 2–4 s     |
| `npm install -g @anthropic-ai/claude-code`                 | 3–4 s     |

So setup is about 10 seconds. It barely matters to billing, which rounds each
job up to the next whole minute. A phase's cost is the agent's time plus the
test suite's.

`bun run test` (the local gate's full suite):

| Cores                                   | Result                     | `bun run test` | Whole job  |
| --------------------------------------- | -------------------------- | -------------- | ---------- |
| 4 (the public runner)                   | 2,341 pass, 1 skip, 0 fail | 370 s          | 6 min 26 s |
| 2 (`taskset -c 0,1` on the same runner) | 2,341 pass, 1 skip, 0 fail | 715 s          | 12 min 6 s |

**2 cores is enough.** Every test passed within the suite's 15-second
per-test timeout, at about twice the 4-core time: 12 minutes. That's a real
share of a phase that runs the gate, but it isn't a failure. Pinning to 2
cores kept the 4-core runner's 16 GB of memory, and a private runner has less,
so it may be slower still. For comparison, this repo's own CI on `main`
splits the suite across runners: `unit` took 3 min 7 s.

**Caching Bun's store isn't worth it here.** A cold `bun install` took 2 to
3 seconds, and saving the 248 MB cache took 2 to 4. The run job can skip
`actions/cache`.

**Billed minutes.** The rehearsal repo is public, so nothing was billed
(`/actions/runs/{id}/timing` reported `billable.UBUNTU.total_ms: 0` for the 12-minute run). On a private repo, a
job is billed per started minute at $0.006 a minute for 2 cores, so a phase
costs about $0.006 × (agent minutes + test minutes + 1). The plan job is at
least a minute each time it runs, as the epic says.

### 7. Saving a failed run

**The upload works; resuming on a laptop: not observed.** The workflow's last
step is

```yaml
- if: always()
  uses: actions/upload-artifact@v4
  with:
    name: claude-home
    path: |
      /tmp/saved
      ~/.claude/projects
    include-hidden-files: true
```

The session with the invalid token left a 28-line transcript,
`f7543ded-….jsonl`. The artifact downloaded with `gh run download` and holds it
whole: user and assistant records, each carrying `sessionId`, `cwd`
(`/tmp/w3`), `version` and `gitBranch`. The token appears nowhere in it.

What wasn't tried is `claude --resume f7543ded-…` on a laptop. A transcript
lives under a directory named after the session's working directory, and on a
runner that is `/home/runner/work/<repo>/<repo>`, which no laptop has. So
resuming needs the file copied into the laptop's directory for the same
checkout (`~/.claude/projects/<path with / turned to ->`) and the WIP branch
checked out there, and then `claude --resume <session>` run from that
checkout. Whether Claude accepts a transcript whose records carry another
`cwd` is the open part.

Two things found on the way:

- **The transcript has to be saved before anything cleans up `~/.claude`.**
  The first try uploaded nothing, because a later step removed the directory.
  The run job should upload from a path it doesn't touch, as the second try
  did.
- **On a public repo, anyone signed in to GitHub can download a run's
  artifacts.** A transcript holds everything the agent read, including the
  system prompt, the code and anything it printed. The run job should set a
  short `retention-days`, and the guide (#462) should say that artifacts on a
  public repo are public.

## Changes to the design

1. **The run job writes `~/.claude.json` before launching Claude.** A fresh
   home stops at the first-run theme picker even with the token set. The file
   needs `hasCompletedOnboarding: true` and the checkout's path under
   `projects` with `hasTrustDialogAccepted: true`. This belongs in
   `chernabog ci run` (#460).
2. **The run job is guarded against an empty list.** `fromJSON('[]')` in a
   matrix fails the whole workflow. The workflow #461 generates must have
   `if: needs.plan.outputs.items != '[]'` on the run job, and the plan job must
   write exactly `[]` when there's nothing to do, so the comparison holds.
3. **A replaced run concludes `cancelled`.** The `workflow_run: completed`
   declarations (#457) must never list chernabog's own workflow, or every
   superseded event wakes another plan. Every superseded event also shows as a
   cancelled run in the Actions list. #462's guide should say that
   cancelled runs from the per-item group are expected.
4. **Transcripts are saved from a path of their own, with short retention.**
   #460 copies `~/.claude/projects/<session>` aside when the session ends and
   uploads it with `if: always()` and a `retention-days` of a few days. On a
   public repo the artifact is readable by anyone signed in, which #462's
   security section should state.
5. **`ubuntu-latest` is Ubuntu 26.04, and a public repo's runner has 4 cores.**
   The cost figures in #455 assume 2, which is right for private repos, where
   the full test suite takes about 12 minutes rather than 6. Any measurement
   taken on a public repo overstates the speed of a private one. The run job
   doesn't need `actions/cache` for Bun: a cold install is 2 to 3 seconds. The workflow should name
   `ubuntu-latest` and nothing more specific, since tmux and Node come with
   the image.

Nothing observed changes the decision to use GitHub-hosted runners,
`repository_dispatch` for phase advances, or interactive sessions under tmux.

## What a person runs to finish questions 1, 2, 6 and 7

`runner-test-claude.yml` stays on the rehearsal repo's `main` for this. Its
token steps run only when the secret exists.

```sh
R=dataquail/chernabog-rehearsal
claude setup-token                                 # a subscription token, valid a year
gh secret set CLAUDE_CODE_OAUTH_TOKEN -R $R        # paste it
gh workflow run runner-test-claude.yml -R $R
gh run watch -R $R "$(gh run list -R $R -w runner-test-claude -L 1 --json databaseId -q '.[0].databaseId')"
```

Read from its log:

- **Question 2:** the "usage endpoint with the token" step prints the status
  and `five_hour` and `seven_day`. A 200 with both answers it.
- **Question 1:** the "token only, Stop hook" step starts `claude 'Reply with
the word OK and nothing else.'` with only the token and a seeded
  `~/.claude.json`, and prints "Stop hook ran after N s" if the hook ended the
  session. If it prints "still running", the pane shows what it stopped at.
- **Question 7:** download the `claude-home` artifact, copy the session's
  `.jsonl` into `~/.claude/projects/<encoded checkout path>/` on a laptop, and
  run `claude --resume <session id>` from that checkout.
- **Question 6:** a real phase needs `chernabog` itself on the runner:
  `chernabog ci run --flow <flow> --persona <login> --item <item>` (#460), with
  `CHERNABOG_HOME=$RUNNER_TEMP/chernabog` and `CLAUDE_CODE_OAUTH_TOKEN` from the
  secret. Its first run on a private repo gives the billed minutes from
  `gh api repos/<repo>/actions/runs/<id>/timing`, and the setup time from the
  job's steps up to the one running `ci run`.

Afterwards, delete the secret (`gh secret delete CLAUDE_CODE_OAUTH_TOKEN -R
$R`) and the workflow, and revoke the token if it won't be reused.

## Cleanup

`runner-test-dispatch.yml`, `runner-test-matrix.yml` and `runner-test-cost.yml`
were removed from the rehearsal repo when the test finished.
`runner-test-claude.yml` was left for the steps above.
