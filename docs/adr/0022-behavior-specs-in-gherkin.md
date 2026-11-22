# 22. Behavior specs in Gherkin, owned by a person, run through drivers

Status: accepted, 2026-11-21. Epic [#576](https://github.com/dataquail/chernabog/issues/576)
(#578 to #584). Builds on [ADR 20](0020-flows-run-on-github-actions.md) (the
ci driver runs flows the GitHub Actions way) and
[ADR 21](0021-one-ledger-the-forge-is-input.md) (a hand-off to a person is
the `with-person` phase).

## Context

What chernabog should do is written in three places that drift apart: test
names, the rules in AGENTS.md, and the website docs. The acceptance tests
(`test/acceptance/`) run the real CLI and daemon against a fake GitHub, but
a test's name and its assertions can change independently.

Agents write most of the code. A likely failure is that an agent's change
breaks an acceptance test, and the agent "fixes" the test by loosening an
assertion. The name still describes the old behavior, the diff looks
routine, and the spec has quietly got weaker. Nothing separates "the
behavior changed" from "the test plumbing changed".

This ADR adds behavior specs in Gherkin (`.feature` files). A person owns
them. They run through **drivers**, so one scenario runs the same way
against more than one way of running chernabog. The decisions are #576's,
recorded here so an agent reads them while it works.

## Decisions

1. **A `.feature` file is the spec, and a person approves it.** An agent
   may draft one, but it is a spec only once a person has proofread, edited
   and approved it.
2. **The spec comes before the code.** A feature lands as the bottom layer
   of a `gh stack`, with no step definitions or implementation yet. The
   layers above implement it. An agent drafts a feature from the issue,
   never from code that already exists.
3. **Changing an approved spec always needs a person.** A check flags any
   pull request that touches the feature files and labels it
   `auto:needs-human`. An agent may propose a spec change but never approve
   one. Agents acting as the human on a stack don't resolve this hand-off
   themselves.

   The check hands the pull request to a person through
   `PullRequest.handToPerson`, never by writing the label itself. Since #559
   landed (#595), that records `with-person` (ADR 21, decision 1), and the
   label is that record's projection. The check didn't change.

   Only a person's approving review clears it: a trusted login that is not
   one of the repo's personas, approving a head whose feature files are
   identical to the current head's. That review is world input, intent, not
   chernabog reading back its own output. Without one, the check hands off
   again on the next run, so a label removed by anyone, an agent included,
   comes back. A later push that changes the feature files needs a new
   approval.

4. **Features describe behavior, not mechanism.** Steps say what a person
   would say ("bob's review run stays parked"), never how it happens ("the
   daemon polls `/runs`"). A scenario a person can't follow in about 30
   seconds is too big or too low-level.
5. **Step definitions are agent-owned plumbing.** They are written against
   a small domain layer (sandbox, personas, items, runs), not against a
   driver's internals.
6. **The runner is `bun test`.** Feature files are parsed with the
   standalone Gherkin parser and become `describe` and `test` blocks, so
   `--parallel`, the timings split in `test/acceptance/timings.json` and the
   sandbox all keep working. The parser is `@cucumber/gherkin@42.0.1`, with
   `@cucumber/messages@34.2.1` for its types and ids. There is no
   cucumber-js runtime.
7. **Drivers are interchangeable behind the domain layer.** In order of
   cost:
   - **in-process:** use-cases and SDK flows with the fakes in
     `test/sdk-fakes.ts`;
   - **sandbox:** the real CLI and daemon in `openSandbox`
     (`test/acceptance/sandbox.ts`) against `fake-github.ts`;
   - **ci:** flows through `ci plan` and `ci run`, the GitHub Actions path
     (ADR 20);
   - **live:** a real scratch repo, like `progress-live.test.ts`, run only
     when configured.

   Each scenario says which drivers it supports. Running one scenario
   through both the daemon and CI drivers is how we show those two paths
   behave the same.

8. **The TypeScript scenario tables stay.** Combinatorial coverage
   (`test/compose-scenarios.ts`, `compose-sabotage.test.ts`) is better as
   code. Gherkin is for behaviors a person would describe out loud. There is
   no wholesale port of `test/acceptance/`.

### Details

- **Where the files live.** Feature files are `test/features/*.feature`.
- **Driver tags.** A scenario names the drivers that run it with tags on
  the Feature or the Scenario: `@driver:in-process`, `@driver:sandbox`,
  `@driver:ci` and `@driver:live` (#622). A Scenario's tags add to its
  Feature's.
- **Fail, don't skip.** A scenario with no driver tag, a driver tag that no
  driver answers, or a step with no definition fails the run. None of them
  is skipped, because a skipped spec looks like a passing one.
- **One small entry file per driver.** Each feature has one `.test.ts` per
  driver that runs it. The in-process entry sits under `test/features/`,
  beside the feature. The sandbox and ci entries sit under
  `test/acceptance/`, so `test/acceptance/timings.json` shards them like any
  other acceptance file, and `bun run test:unit` leaves them out.
- **A live entry that isn't configured.** Without the scratch repo it
  needs, a live entry registers one visibly skipped test that names what to
  set, as `progress-live.test.ts` does, and none of the feature's scenarios.
  That is a whole driver that can't run on this machine, not a scenario
  skipped where its driver runs, so "fail, don't skip" still holds. The
  runner knows `ci` and `live` (its `DRIVERS`) before either has an entry,
  so a spec can be tagged for them.
- **One order of events.** Each history in the domain's world (reviews,
  replies, pushes, review requests, hand-offs, agent sessions, merges)
  gives each event a sequence, in the order things happened, the same way
  on every driver. A step that says "again", "since" or "the fix" compares
  sequences, never a world seen at an earlier step. In-process, the SDK
  fake numbers its acts with one counter. On the sandbox, the fake GitHub,
  the bare repo's push hook and the fake agents each append a line to one
  event log as the event happens, and a line's place is its sequence.

## Rejected

- **The cucumber-js runtime.** It brings its own runner, so `bun test`'s
  `--parallel`, the timings split and the sandbox's lifecycle would each
  need a second setup. The standalone parser gives the scenarios, and
  `bun test` runs them.
- **Skipping a scenario that can't run.** A missing driver tag, an unknown
  driver or an undefined step would report as a pass that tested nothing.
- **Porting `test/acceptance/` wholesale.** Most of it is plumbing a person
  wouldn't describe out loud, and the combinatorial tables read better as
  code (decision 8).
- **Agents approving a spec change when they act as the human on a stack.**
  The point of the spec is a check that agents can't loosen. An agent that
  clears the hand-off is that loosening.
- **Writing `auto:needs-human` directly from the check.** ADR 21 makes the
  label a projection of the `with-person` record. A check that writes it
  would be a second writer that the record doesn't know about.

## Consequences

- A behavior change shows up as a diff to a `.feature` file, which a person
  must approve. A plumbing change shows up as a diff to step definitions, a
  driver or the domain layer, which an agent may make.
- Every scenario costs step definitions. Whether the separation is worth
  that cost is decided after the pilot (#584), and the epic records the
  answer. The ci and live drivers wait on that decision.
- A pull request that touches a feature file waits for a person, even one
  labelled `auto:ship`. Spec changes are slower on purpose.
- A sandbox entry file is an acceptance file. It needs a line in
  `test/acceptance/timings.json` (`bun run test:acceptance --update-timings`).
