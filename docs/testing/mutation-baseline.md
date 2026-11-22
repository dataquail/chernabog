# Mutation baseline (#591)

Part of epic #574. Decision 3: no score threshold at first. This records each module's first full mutation run, after the gaps found in the spike were closed (#587–#590) and the equivalent mutants were marked ignored, so the nightly run (#592) starts from a known list. The last section answers decision 3's question: is a threshold worth having?

**In short:** 2,154 mutants across eight modules in about three minutes, cold. 90 are ignored, each with a reason. Of the rest, 90.4% are killed, and 94.1% of those a test covers. 118 survive and 80 have no coverage; claims accounts for 95 of those 198. No threshold yet: the scores say more about which modules have been worked on than about how good their tests are (see the last section).

## How it was run

Every module ran cold, `bun run mutation <module> --force` with no incremental file, one after another, at Stryker's default concurrency. The machine was an M2 Max (12 cores), and the tree was at `b36f4438`. Wall time is the whole command, dry run included. A module's HTML report shows every mutant: `reports/mutation/<module>/mutation.html` after a local run.

Scores:

- **Score** is detected / (detected + survived + no coverage), Stryker's mutation score.
- **Covered** leaves out the mutants no test reaches: detected / (detected + survived).
- **Detected** is killed + timeout.

Ignored mutants count in neither.

## Baseline

| module             | mutants | ignored | killed | timeout | survived | no coverage | score     | covered   | wall time |
| ------------------ | ------- | ------- | ------ | ------- | -------- | ----------- | --------- | --------- | --------- |
| ci-wake            | 586     | 32      | 509    | 0       | 34       | 11          | 91.9%     | 93.7%     | 23 s      |
| claims             | 346     | 6       | 245    | 0       | 41       | 54          | 72.1%     | 85.7%     | 57 s      |
| ledger             | 238     | 5       | 225    | 0       | 7        | 1           | 96.6%     | 97.0%     | 22 s      |
| phase              | 23      | 3       | 16     | 0       | 3        | 1           | 80.0%     | 84.2%     | 3 s       |
| phase-announcer    | 20      | 0       | 19     | 0       | 1        | 0           | 95.0%     | 95.0%     | 2 s       |
| phases             | 450     | 13      | 400    | 3       | 29       | 5           | 92.2%     | 93.3%     | 36 s      |
| progress           | 417     | 29      | 377    | 3       | 2        | 6           | 97.9%     | 99.5%     | 32 s      |
| progress-anomalies | 74      | 2       | 69     | 0       | 1        | 2           | 95.8%     | 98.6%     | 7 s       |
| **total**          | 2,154   | 90      | 1,860  | 6       | 118      | 80          | **90.4%** | **94.1%** | 182 s     |

`ignored` includes the message-text ignorer's mutants (`tools/stryker/ignore-messages.mjs`) as well as those marked in the code.

### The six timeouts are real kills

Each one turns a loop into one that never ends. They are not the load-induced timeouts the spike warned about:

- **progress `readAll`'s pagination** (`progress.ts`, `for (;;)` emptied, and `!page.hasNextPage || …` → `false`, twice). Both make the loop either never fetch the next page or never stop fetching.
- **phases `Phases.record`'s retry loop** (`phases.ts`, the `for (let tries = 1; ; tries++)` body emptied, and `if (Option.isSome(written))` → `false` or emptied). Rerun with `timeoutMS: 120000`, the `false` mutant still times out, at Stryker's hit limit (5,601 of 5,600): it loops forever.

## What is ignored, and why

Every mutant marked in the code carries `// Stryker disable next-line <mutator>: <reason>` on the line before. Where a comment can't sit on its own line before the mutant (inside a call's arguments, or a method chain), the code uses a `// Stryker disable <mutator>: <reason>` and `// Stryker restore <mutator>` pair around the statement instead. The marks fall into four groups.

**Equivalent: no caller can tell the difference.**

- **`progress.ts`'s record cache** (the spike's 216, 217, 222, 262). The `seen` lookup, and both `seen.set`s. `read` and `readAll` query GitHub on every call either way. The cache only saves re-parsing a tip's message, and a tip parsed again reads back as the record cached.
- **`{ ...undefined }` against `{ ...{} }`** (the spike's progress 234 and ledger-check 92). Also the same pattern in `phases.ts` (`carryingReview`, `again`), `events.ts` (`on`'s association) and `claims.ts` (`optional`).
- **`errors: []` on the success path** (the spike's progress 331). `nextOrMiss` reads `errors` only when nothing was written.
- **A `Context.Reference` key → `""`** (the spike's phases 307 and 437: `Phases/Checking` and `RecordedOn`). A key only has to be unique, only one mutant is active at a time, and no other reference uses `""`. The issue asked for 437, scored Timeout in the spike, to be rechecked with a long `timeoutMS`. It survives at `timeoutMS: 120000`, and in this run it survived at the default as well, since park's real-time engine tests left the selection in #589.
- **ci-plan's `MatrixText`: `Schema.Struct({ flow, persona, item })` → `{}`.** It only encodes entries this code builds with exactly those fields, and `Struct({})` encodes its input unchanged.

**Text for a person.** The message-text ignorer only sees text in the value of a `message`, `reason`, `fix` or `title` property. These are the same kind of text, built somewhere it can't see:

- a refusal's reason, passed as an argument (`progress.ts`);
- the `said` summary of GraphQL errors (`progress.ts`), which nothing decides on, since the decision reads `errors`;
- `recordNamed` and the anomaly text's `version.slice(0, 7)` (`ledger-check.ts`);
- a plan's notes: `describeConcerned`, `keysOf` and two note templates (`ci-plan.domain-service.ts`);
- `describeLoss`'s and `describeHolder`'s fallbacks (`claims.ts`);
- `handedBack`'s logged warning (`phases.ts`).

**A brand's name** (`phase.ts`: `Phase`, `PhaseWriter`, `PhaseData`). It types the value, and at run time only names it in a parse error.

**Malformed input only.** `Schema.Struct({ … }) → Schema.Struct({})` is malformed-only wherever the struct decodes one shape. Effect's `Struct({})` passes its input through unchanged, so valid input decodes exactly as before, and only input of the wrong shape is let through. Marked:

- `events.ts`'s `ItemFrom` members, `FlowEvents` and `RunPullRequests`;
- `phases.ts`'s `LabelEvents` (and its `label` and `actor`), `Permission` and `WithPersonLeft`;
- `claims.ts`'s `refMarker` arguments.

Two fallbacks that only a malformed GitHub response reaches are marked too:

- `removedBy`'s `() => []` for a page of events that doesn't decode;
- `ciRunAt`'s `() => []` for a `workflow_run` without `pull_requests`.

So is `removedBy`'s `found.label?.name` → `found.label.name`, since GitHub's `unlabeled` events always carry their label.

Two malformed-input patterns are _not_ marked, because they differ on valid input:

- **ledger-check's `IssueWork` and `PullRequestWork`** decide which kind of work an item's data is. `Struct({})` accepts an issue's data as a pull request's, so `itemsOf` names `pr-undefined`. This is the spike's "itemOfWork given the other kind's data" (416/417): a real gap, listed below.
- **`WithPersonLeft`'s fallback** `(): … => ({})` → `undefined` is reached by a with-person record with no data, which is valid. Listed below.

The spike's progress Schema mutants (17 malformed-only) were all killed by #587, so none of them needed a mark.

**Not ignored, as the issue asked:**

- **progress 378** ("moved and came back") is gone. `afterMiss` runs only once the branch has moved from the version the writer read, so `decide` could never return none there. `afterMiss` now gives the writer's own record or `PhaseMoved`, and the case can't be expressed in the types (commit `197354b9`).
- **phases 437** was rechecked: see above.

## Open gaps

These survive, or have no coverage, and are real unless noted. The nightly survivor issue (#593) carries them from here. They are grouped by the test that's missing. `file:line` is at `b36f4438`.

### progress (2 survived, 6 no coverage)

- **A ref error that isn't "Reference already exists"** (`progress.ts:603`, `ref.status === 422 && said.includes(…)` → `true`). No test fails a first phase's ref with a 422 of another kind, such as a rule, and checks that it isn't read as a lost race.
- **`ProgressLive`** (`:814` survived; `:817`, `:819` no coverage). No focused test builds the layer, and only the acceptance tests reach it.
- **Fallbacks for absent fields** (no coverage):
  - `const [owner = "", name = ""]` (`:377`), a slug without a slash;
  - `tip.message ?? ""` (`:399`);
  - `response.errors ?? []` (`:661`).

### ledger (7 survived, 1 no coverage)

- **Acknowledging a record with no data** (`ledger.ts:111`, `onNone: () => base` → `undefined`). The advance gets no transition.
- **Acknowledging loses a race** (`:117`, `catchTag("PhaseMoved")` → `""`, its handler → `undefined`, and `false` → `true` with no coverage). No test moves the item between the read and the advance.
- **Anomalies sorted by item** (`:56`). No test lists two anomalies out of order.
- **An anomaly whose record moved since it was listed** (`:91`, the version filter → `true`). Cost only: the advance's compare-and-set from the listed version still refuses, so the result is the same, with one extra request.
- **Work data of the other kind** (`ledger-check.ts:211`, `:212`, `IssueWork` and `PullRequestWork` → `{}`). See above.

### phases (29 survived, 5 no coverage)

Most of these are in `handedBack` (#606), which landed after the spike:

- **`openLabels`** (`:968`–`:981`):
  - an item with no number;
  - telling a pull request's item from an issue's (the `pr-` prefix);
  - a closed pull request or issue;
  - an item GitHub answers `NotFound` for.
- **`handedBack` itself:**
  - skips records that aren't with-person (`:995`);
  - the item's number (`:1008`);
  - a with-person record without data (`:1041`).
- **`removedBy`:**
  - the last page read (`:910`, `<=` → `<`);
  - only an `unlabeled` event of this label counts (`:925`).
- **`trusted`:**
  - a repo with two personas (`:944`, `some` → `every`);
  - the `maintain` and `write` permissions (`:878`).
- **`isWithPerson` and `withPerson`** (`:841`–`:846`). Only the acceptance tests reach them.

Elsewhere in `phases.ts`:

- **`PARKS`:** five sites whose entry can be emptied (`:221`, `:236`, `:241`, `:246`, `:251`). `test/park-sites.test.ts`, now in the selection, pins every site's phase, but not that these five are listed.
- **`NOTHING_CARRIED`** → `{}` (`:560`). No park without `carries` reads what it carried.
- **Equivalent, but not ignorable on its own:** `ROUND`'s `^` (`:127`). `exec` tries index 0 first, and there `(.*?)` always matches, for any phase (a phase has no newline). The line's five other regex mutants are killed, and a `Regex` mark would hide them too.

### ci-wake (34 survived, 11 no coverage)

- **The trusted-association routes** (`events.ts:140`–`:161`, `:223`). `reviewRequested`, `reviewRequestedAgain`, `readyForReview` and `commentCreated` can lose their `association`, and `pullRequestClosed` its `ownPersona`, and no test notices. That is who may wake a flow: the highest-value gap here.
- **`nameAt`** treats an empty string as no name (`:412`).
- **`ciRunAt`'s push-to-default check** (`:423`).
- **`routes`, `parkedOn`'s matching** (`:486`, `:511`–`:519`):
  - an event of another name;
  - a record whose data names only some pull requests;
  - a `pullRequest` key that isn't an integer.
- **`ItemFrom`'s `"branch"` literal** (`:64`) and the `repo` item (`:446`, no coverage).
- **`declare`'s `configurable`** (`:239`). Nothing declares a flow twice.
- **`phaseRoute`'s `trusted: false`** (`:318`).
- **ci-plan:**
  - `concerns`: the `repo` and `item` cases, and `branch`/`ci-run` (`ci-plan.domain-service.ts:130`–`:142`);
  - `ISSUE_BRANCH`'s anchors (`:146`);
  - `lookedAt` with several items named (`:200`);
  - the same item planned twice (`:279`, `:287`);
  - a target with no candidates after routing (`:302`).
- **Equivalent, but not ignorable on its own:** `of`'s `hasProperty` guard (`events.ts:245`). Decoding an absent `events` gives none as well. A `ConditionalExpression` mark would also hide its killed `true` mutant.

### claims (41 survived, 54 no coverage)

No one has triaged claims yet: the spike didn't run it, and no task pinned it. Grouped by function:

- **The claim marker's lease** (`renewedReport`, `checkedReport`, `ofThisRun`, `refMarker`'s `on`/`renew`/`check`; `:322`–`:390`). Mostly no coverage. No focused test renews or checks a claim through its marker.
- **`releasing`** (`:571`–`:578`):
  - an interrupted run keeps its claim;
  - the release activity's name `release-claim-<item>`;
  - the marker it drops.
- **Parsing a claim commit** (`:96`–`:121`):
  - the title check;
  - `TRAILER`'s anchors;
  - a trailer line with surrounding whitespace;
  - missing `Persona`, `Flow` and `Claimed-At` trailers.
- **Following a taken-over claim** (`:145`, `:159`): the hop limit and its count.
- **The lease commit** (`:217`, `:220`, `:432`, `:435`):
  - its parents;
  - `createRef`'s `already-exists` and `created` answers;
  - `EMPTY_TREE` (`:36`) and `leaseRefFor`'s shape (`:48`).

  The fake doesn't check what it's sent, as the spike found for progress.

- **`releaseFor`'s answer** (`:305`, `:310`).
- **The `Taken` check** (`:466`, `:467`): a claim handed back or lapsed.
- **`withPerson`'s default** (`:490`, `:541`).
- **`renew` on a released claim** (`:258`).

### phase (3 survived, 1 no coverage)

- **`PhaseData`'s size limit** (`phase.ts:44`, `:48`):
  - the body of `fitsARecord`;
  - its `<=` boundary at exactly `PHASE_DATA_MAX_BYTES`.

  No test in the selection writes data over, or at, 4,096 bytes.

### phase-announcer (1 survived)

- **`PHASE_EVENT`'s value** (`phase-announcer.ts:21`). The tests compare against the constant itself, so `""` passes. A test should name `"chernabog-phase"`, which is what a repo's workflow listens for.

### progress-anomalies (1 survived, 2 no coverage)

- **`progressAnomalies`** (`progress-anomalies.ts:157`–`:171`). The CLI entry that opens the repo and its ledger; only the acceptance tests reach it. `surveyAnomalies`, under it, is covered.

## Should there be a score threshold?

**Recommendation: not yet.** Revisit once the nightly survivor issues (#593) have run for a month.

- **One threshold doesn't fit eight modules.** Covered scores run from 84.2% (phase) to 99.5% (progress), and full scores from 72.1% (claims) to 97.9%:
  - a threshold that claims passes (≤ 72%) says nothing about progress, ledger or phases, which are all above 92%;
  - one that means something for them (≥ 90%) fails claims and phase on their first night.
- **The spread measures triage, not test quality.** The modules the spike and #587–#590 worked on are at 96–99.5% covered. Claims, which nobody has looked at, has 95 of the 198 open mutants (48%), and 54 of the 80 with no coverage. Its score would move by work being done, not by tests getting worse.
- **It would make survivors a red build,** which decision 4 rules out. A nightly failure on a score blocks no pull request, so it can only become a failure people learn to ignore. A survivor issue becomes work.
- **What a threshold would catch, the survivor issue already shows.** A change that drops a module's score adds survivors to that module's issue, named by line. That is more useful than a number crossing a line.

If a gate is wanted later, make it a ratchet per module, not an absolute floor. For example: no module's covered score below this baseline minus two points. Enforce it in the nightly run's issue, not in CI on pull requests. Base it on covered score, so adding code no focused test reaches yet doesn't trip it.
