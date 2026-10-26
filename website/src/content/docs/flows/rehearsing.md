---
title: Rehearsing a flow
description: Run a flow end to end on a seeded repo, with stand-ins where the agent would be, before a real run pays for an agent session.
---

A flow's unit tests run on in-memory fakes. They skip what most often goes wrong in a real run: the daemon's routing, your machine config's personas and their `flows`, the reviewer pool, real labels, real CI and real review requests. `chernabog rehearse` runs **the flow file itself** down that real path, with your own machine config and real GitHub, but on a repo you seed for it, and with a **stand-in** wherever the agent would be. No agent session starts, so a rehearsal spends no tokens.

```sh
chernabog rehearse implement --repo my-app --scenario .chernabog/rehearsals/implement.yaml
```

It seeds the scenario's issues and pull requests, runs the flow in the foreground as `chernabog run` would, prints where the run ended and why, checks what the scenario expected, and then removes what it seeded.

A rehearsal covers a flow's wiring: triggers, gates, routing, personas, labels, error paths, hand-offs and resume. It does not tell you whether the agent does good work. That's prompt quality, a separate question.

## A scenario

A scenario is a YAML file, such as `.chernabog/rehearsals/implement.yaml`. `chernabog init` writes `rehearsal.schema.json` beside `config.schema.json`, for your editor's completion:

```yaml
# yaml-language-server: $schema=../rehearsal.schema.json
repo: you/chernabog-rehearsal # the repo to seed and run on
flow: implement
install: null # nor install what the team's repo does
localGate: ["true"] # this scratch repo can't pass the team's gate

given:
  issues:
    - name: bug
      title: The button does nothing
      labels: [auto:eligible]

agent:
  implement:
    script: $CHERNABOG_STAND_INS/implement.sh
  fix-ci-*:
    fixture: { status: done, title: "fix: CI", body: Fixes CI., summary: Fixed CI. }

expect:
  ends: done
  summary: is ready for review
```

| Key         | What it is                                                                                                                                                                                                                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repo`      | The `owner/name` to rehearse on. A rehearsal adds labels, comments, requests reviews and may merge there.                                                                                                                                                                                                                                       |
| `flow`      | The flow it rehearses. `chernabog rehearse <flow>` must name the same one.                                                                                                                                                                                                                                                                      |
| `persona`   | The persona to rehearse as, for a repo that runs as several. `--as` overrides it.                                                                                                                                                                                                                                                               |
| `enrolled`  | `true` to rehearse on a repo this machine is enrolled in. [See below](#on-your-own-repo).                                                                                                                                                                                                                                                       |
| `install`, `localGate` | The install step and local gate to run in place of the team's, for a repo that can't pass them. `install: null` runs none.                                                                                                                                                                                                                                                                    |
| `given`     | The GitHub state to seed. `issues` take a `title`, and optionally a `body`, `labels` and `assignees`. `pullRequests` take a `branch`, a `title` and `commits`, each a `message` and its `files` by path, and optionally a `body`, a `base`, `labels` and `reviewers` to request. Every item has a `name`. `as` seeds as another persona under `github:`. |
| `agent`     | The stand-ins, by step name. [See below](#stand-ins).                                                                                                                                                                                                                                                                                           |
| `expect`    | Where the run should end: `ends` (`done`, `needs-human`, `skipped`, `failed`, `cancelled`, or `running` for a run still waiting when the rehearsal stops following it), a phrase its `summary` carries, and every one of the `labels` its item should carry afterwards. Without `ends`, a rehearsal expects `done`.                                         |

The repo needs a CI workflow that finishes in seconds, since a rehearsal waits for real CI. On a scratch repo, one job that runs `true` is enough. There's deliberately no way to skip CI, so that the flow's CI waits get rehearsed too.

Seeding by hand is the tedious part, and an agent is good at it: have one write the scenario once. After that the rehearsal is deterministic and repeatable.

## Stand-ins

A stand-in answers for the agent at one step. Steps are named as the flow's activities are: `implement`, `review-1`, `fix-ci-2`, `consider-review-1`. A key may be a pattern, where `*` matches anything, so `fix-ci-*` covers every round. A step's own name wins over a pattern, and among patterns the first one listed wins.

- **`script`** is a shell command run in the step's worktree, which may commit. Its answer is the last JSON object it prints. It gets the prompt on stdin, and `CHERNABOG_STEP`, `CHERNABOG_SESSION_ID`, and `CHERNABOG_STAND_INS` (the scenario's directory) in its environment.
- **`fixture`** is the answer itself. `commits` (a list of messages) makes one placeholder commit for each, under `.rehearsal/`, before answering, for a step whose work must commit something.

The step's own block checks the answer against its schema, as it does a real agent's, so an answer of the wrong shape fails the same way. **A step with no stand-in fails the rehearsal and names the step.** It never falls through to a real agent: in a rehearsal, every agent call goes to the stand-ins, including a flow's Codex reviewer.

The rehearsal agent works outside `rehearse` too. Give it stand-ins in machine config, and choose it as a repo's `agent:`:

```yaml
# ~/.config/chernabog/config.yaml
agents:
  rehearsal:
    standIns:
      implement: { script: ./implement.sh } # $CHERNABOG_STAND_INS is this file's directory
```

## Your own machine config

A rehearsal runs as your machine config sets things up: your personas, each persona's `flows`, the team's reviewer pool and routing. That's the point. When `implement` asks a reviewer whom no persona here reviews as, the rehearsal says so:

```
! #41 asks bob to review it, and no persona here reviews as bob: a real run would wait for another machine to review it
```

`chernabog doctor` warns about the same gap without a rehearsal.

The flow, its prompts and its stages come from your working copy's `.chernabog/`, so you can rehearse a change before you merge it. `--trusted` rehearses the trusted copy on the base branch instead. Each rehearsal keeps its own journal, so it never meets a real run, and it can run beside the daemon.

## On your own repo

Rehearse **refuses a scenario whose `repo:` is enrolled** on this machine, unless the scenario says `enrolled: true` (or you pass `--on-enrolled`). Rehearsing on your own repo with a stub issue is the low-effort check. A scratch repo keeps your issue history clean.

On an enrolled repo, chernabog pauses the scenario's repo on this machine for the rehearsal, clones it from its own checkout's origin, and resumes it afterwards. That needn't be the `--repo` repo: the flow file comes from `--repo`, so you can rehearse one repo's flow on a stub issue in another repo you're enrolled in. **Another machine's daemon may still pick up what is seeded.** The rehearsal itself only ever runs on what it seeded, never on real work queued in the repo.

## Cleanup

Afterwards, chernabog removes what the rehearsal made: the seeded issues (deleted, or closed where your persona can't delete them), the seeded pull requests and their branches, and the pull requests and branches the flow opened for the seeded issues. `--keep` leaves all of it, and the rehearsal's clone and journal, for a look.

## Replaying a run

```sh
chernabog rehearse implement --repo my-app --scenario .chernabog/rehearsals/implement.yaml --replay 1a2b3c4d
```

`--replay <run>` stands in with a finished run's own answers, step by step, with a placeholder commit for each commit the step made (so give the scenario a `localGate` that takes them). The fixtures then come from real runs instead of being invented. After you change a flow, replay recent runs against it as a regression check. A stand-in from the scenario's `agent:` replaces the replayed one for its step.

A step the replayed run had and the flow no longer has is reported:

```
! no step asked for the stand-in consider-review-1; the flow may no longer have it
```

Only runs made since chernabog started recording agents' answers can be replayed.

## A recipe package you're writing

A flow [imported](/chernabog/recipes/#copy-or-import) from a recipe package rehearses like any other. To rehearse a package before you publish it, pass its checkout with `--package`, and the rehearsal loads the flow, its prompts and its steps from there, in place of the version installed in `.chernabog/`:

```sh
chernabog rehearse deploy --repo scratch --scenario .chernabog/rehearsals/deploy.yaml --package ~/code/acme-chernabog-recipes
```

See [Writing a recipe package](/chernabog/recipes/packages/#rehearsing).

## Flags

| Flag            | What it does                                                         |
| --------------- | -------------------------------------------------------------------- |
| `--scenario`    | The scenario file                                                    |
| `--as`          | The persona to rehearse as                                           |
| `--item`        | A seeded work item to run on, by the flow's key, such as `issue-12`  |
| `--replay`      | A finished run whose answers stand in                                |
| `--keep`        | Leave what was seeded                                                |
| `--on-enrolled` | Allow a scenario whose repo is enrolled here                         |
| `--trusted`     | Rehearse the trusted `.chernabog/` rather than the working copy's    |
| `--timeout`     | Minutes to follow the run before reporting where it waits (default 30) |
| `--package`     | A recipe package's checkout to load imported flows from; repeat it for several |

`rehearse` exits non-zero when the run doesn't end as the scenario expects, or when a step had no stand-in.
