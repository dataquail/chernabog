// The hybrid path through the engine, on an in-memory GitHub, with the
// human-initiated recipe: the flow a person hands an issue to, the session it opens with them, the pull request
// it opens, and how review answers it with the person at the decisions.

import {
  claimMarker,
  DEFAULT_LABELS,
  Hybrid,
  Implement,
  PushRejected,
  reviewMarker,
  sessionMarker,
} from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import addressReview from "../packages/recipes/flows/address-review.ts";
import humanInitiated from "../packages/recipes/flows/human-initiated.ts";
import implement from "../packages/recipes/flows/implement.ts";
import review from "../packages/recipes/flows/review.ts";
import { sessionFilesIn } from "../src/modules/runs/infrastructure/runtime/agents/session-files.ts";
import { stopHook } from "../src/modules/runs/infrastructure/runtime/agents/stop-hook.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { Exec } from "../src/platform/exec.ts";
import { effect } from "./effect-test.ts";
import {
  HEAD,
  ISSUE,
  item,
  makeFake,
  onFake,
  PULL,
  repo,
  runToEnd,
  summaryOf,
  triggered,
} from "./sdk-fakes.ts";

const starting = flowHandle(repo, "human-initiated", humanInitiated);
const reviewing = flowHandle(repo, "review", review);
const addressing = flowHandle(repo, "address-review", addressReview);
const implementing = flowHandle(repo, "implement", implement);
const work = item(`issue-${ISSUE}`, { issue: ISSUE });
const POOL = { reviewers: ["zach", "data-quail"] };
const PERSON_SESSION = Implement.sessionIdFor(`dataquail/demo#${ISSUE}`, "human-initiated");

describe("human-initiated", () => {
  effect("finds no work on a schedule, and the issue a person names by its key", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      expect(yield* triggered(fake, Hybrid.trigger)).toEqual([]);

      const named = yield* onFake(fake, Hybrid.itemFor(`issue-${ISSUE}`));
      expect(Option.map(named, (found) => found.key)).toEqual(Option.some(`issue-${ISSUE}`));
      expect(yield* onFake(fake, Hybrid.itemFor(`pr-${PULL}`))).toEqual(Option.none());
    }),
  );

  effect(
    "works on the issue in a session with the person, then opens a hybrid pull request and asks the pool for a review",
    () =>
      Effect.gen(function* () {
        const fake = makeFake("approve", POOL);
        fake.setLabels(ISSUE, [DEFAULT_LABELS.eligible]);
        const finished = yield* runToEnd(starting, fake, work);
        expect(finished.status).toBe("done");
        expect(summaryOf(finished)).toBe(
          `#${ISSUE}: https://github.com/dataquail/demo/pull/${PULL} is ready for review; a person merges`,
        );

        // One session, per issue rather than per run, opened with the person.
        expect(fake.requests.map((request) => [request.sessionId, request.withPerson])).toEqual([
          [PERSON_SESSION, true],
        ]);
        expect(fake.requests[0]?.prompt).toContain("is here in this session with you");
        expect(fake.git.pushes).toBe(1);

        expect(fake.labelsOf(PULL)).toContain(DEFAULT_LABELS.hybrid);
        expect(fake.labelsOf(PULL)).not.toContain(DEFAULT_LABELS.ship);
        expect(fake.labelsOf(ISSUE)).toEqual([]);
        expect(fake.people.requested).toHaveLength(1);
        expect(finished.subjects).toEqual([`pr-${PULL}`]);

        const marker = Option.firstSomeOf(
          fake.comments.map((comment) => sessionMarker.read(comment.body)),
        );

        expect(marker).toEqual(
          Option.some({
            adapter: "claude",
            sessionId: PERSON_SESSION,
            issue: ISSUE,
            branch: `auto/issue-${ISSUE}`,
            withPerson: true,
          }),
        );
        expect(
          fake.comments.some((comment) =>
            Option.exists(claimMarker.read(comment.body), (claim) => claim.withPerson === true),
          ),
        ).toBe(true);
      }),
  );

  effect(
    "fails when the person closes the session first, keeping the issue in progress for the next start",
    () =>
      Effect.gen(function* () {
        const fake = makeFake("approve", POOL);
        fake.author.closes = true;
        const finished = yield* runToEnd(starting, fake, work);
        expect(finished.status).toBe("failed");
        expect(summaryOf(finished)).toContain("the person closed the session");
        expect(fake.labelsOf(ISSUE)).toEqual([DEFAULT_LABELS.inProgress]);
        expect(fake.git.pushes).toBe(0);
      }),
  );

  effect(
    "takes over the branch an earlier version's start left, but leaves an earlier unattended run's to it",
    () =>
      Effect.gen(function* () {
        const earlier = makeFake("approve", POOL);
        earlier.existing.branch = true;
        earlier.comment(
          claimMarker.write({
            runId: "an-earlier-start",
            claimedAt: "2026-10-20T00:00:00Z",
            branch: `auto/issue-${ISSUE}`,
            withPerson: true,
          }),
        );
        expect((yield* runToEnd(starting, earlier, work)).status).toBe("done");

        const unattended = makeFake("approve", POOL);
        unattended.existing.branch = true;
        unattended.comment(
          claimMarker.write({
            runId: "an-implement-run",
            claimedAt: "2026-10-20T00:00:00Z",
            branch: `auto/issue-${ISSUE}`,
          }),
        );
        const skipped = yield* runToEnd(starting, unattended, work);
        expect(skipped.status).toBe("skipped");
        expect(summaryOf(skipped)).toContain("already claimed by an unattended run");
        expect(unattended.requests).toEqual([]);
      }),
  );

  effect(
    "pushes a change to humanOnlyPaths made in front of the person, where an unattended run hands it to a person",
    () =>
      Effect.gen(function* () {
        const fake = makeFake("approve", POOL);
        fake.merge.files = ["src/a.ts", ".github/workflows/ci.yml"];
        const finished = yield* runToEnd(starting, fake, work);
        expect(finished.status).toBe("done");
        expect(fake.git.pushes).toBe(1);
        expect(fake.labelsOf(PULL)).toContain(DEFAULT_LABELS.hybrid);

        const unattended = makeFake("approve", POOL);
        unattended.merge.files = ["src/a.ts", ".github/workflows/ci.yml"];
        unattended.setLabels(ISSUE, [DEFAULT_LABELS.eligible]);
        const handed = yield* runToEnd(implementing, unattended, work);
        expect(handed.status).toBe("needs-human");
        expect(summaryOf(handed)).toContain(
          "the change touches paths a person must handle: `.github/workflows/ci.yml`",
        );
        expect(unattended.git.pushes).toBe(0);
        expect(unattended.labelsOf(ISSUE)).toContain(DEFAULT_LABELS.needsHuman);
      }),
  );

  effect("pushes the person's fixes for red CI to humanOnlyPaths too", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve", POOL);
      fake.merge.files = [".github/workflows/ci.yml"];
      fake.merge.ci = { state: "red", failedChecks: ["test"] };
      const finished = yield* runToEnd(starting, fake, work);
      expect(finished.status).toBe("needs-human");
      expect(summaryOf(finished)).toContain("CI is still red after 3 fix attempts");
      expect(fake.git.pushes).toBe(4);
    }),
  );

  effect(
    "hands the issue to a person, with the fix, when the token can't push a workflow change",
    () =>
      Effect.gen(function* () {
        const fake = makeFake("approve", POOL);

        const reason =
          "! [remote rejected] HEAD -> auto/issue-3 (refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)";

        fake.git.rejects = Option.some(
          new PushRejected({ branch: `auto/issue-${ISSUE}`, reason, missingScope: "workflow" }),
        );
        const finished = yield* runToEnd(starting, fake, work);
        expect(finished.status).toBe("needs-human");
        expect(summaryOf(finished)).toContain(`pushing auto/issue-${ISSUE} was rejected`);
        expect(summaryOf(finished)).toContain(
          "Fix: give the token it pushes with the `workflow` scope (`gh auth refresh --hostname github.com --scopes workflow`",
        );
        expect(fake.labelsOf(ISSUE)).toContain(DEFAULT_LABELS.needsHuman);
        expect(fake.comments.some((comment) => comment.body.includes("--scopes workflow"))).toBe(
          true,
        );
        expect(fake.git.opened).toBe(false);
      }),
  );

  effect(
    "hands the issue to a person when CI stays red, after fixes in the session with them",
    () =>
      Effect.gen(function* () {
        const fake = makeFake("approve", POOL);
        fake.merge.ci = { state: "red", failedChecks: ["test"] };
        const finished = yield* runToEnd(starting, fake, work);
        expect(finished.status).toBe("needs-human");
        expect(
          fake.requests
            .slice(1)
            .every(
              (request) => request.sessionId === PERSON_SESSION && request.withPerson === true,
            ),
        ).toBe(true);
        expect(fake.labelsOf(ISSUE)).toContain(DEFAULT_LABELS.needsHuman);
      }),
  );
});

describe("a hybrid pull request", () => {
  effect("is never merged by chernabog, whatever its labels but auto:ship", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.people.me = "data-quail";
      fake.people.requested = ["data-quail"];
      fake.setLabels(PULL, [
        DEFAULT_LABELS.hybrid,
        DEFAULT_LABELS.approved,
        DEFAULT_LABELS.needsReview,
        "ship",
        "auto:merge",
      ]);

      const finished = yield* runToEnd(
        reviewing,
        fake,
        item(`pr-${PULL}`, {
          pullRequest: PULL,
          headRef: `auto/issue-${ISSUE}`,
          agentWritten: true,
        }),
      );

      expect(summaryOf(finished)).toBe(`#${PULL} approved; a person merges`);
      expect(fake.merge.requests).toEqual([]);
    }),
  );

  effect("reopens the person's session to answer a review that asks for changes", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.submitted.push({ author: "data-quail", state: "CHANGES_REQUESTED", commitSha: HEAD });
      fake.comment(
        reviewMarker.write({
          sha: HEAD,
          round: 1,
          verdict: "request-changes",
          reviewer: "data-quail",
          sessionId: "review-session",
          adapter: "codex",
        }),
      );
      fake.comment(
        `Worked on by a person with claude for #${ISSUE}. ${sessionMarker.write({ adapter: "claude", sessionId: PERSON_SESSION, issue: ISSUE, branch: `auto/issue-${ISSUE}`, withPerson: true })}`,
      );
      fake.git.pushes = 1;

      // A fix to a human-only path pushes, since the person is in the session.
      fake.merge.files = [".github/workflows/ci.yml"];

      const answered = item(`pr-${PULL}-changes-1`, {
        pullRequest: PULL,
        headRef: `auto/issue-${ISSUE}`,
        agentWritten: true,
        reviewer: "data-quail",
        reviewedSha: HEAD,
      });

      const finished = yield* runToEnd(addressing, fake, answered);
      expect(finished.status).toBe("done");
      expect(fake.git.pushes).toBe(2);
      expect(fake.requests.map((request) => [request.sessionId, request.withPerson])).toEqual([
        [PERSON_SESSION, true],
        [PERSON_SESSION, true],
      ]);
      expect(fake.people.requested).toEqual(["data-quail"]);
    }),
  );
});

describe("a session's Stop hook", () => {
  effect("sends the agent back for its answer, unless a person is in the session", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-hook-" });
      expect(Option.isSome(yield* stopHook(dir))).toBe(true);

      expect(yield* stopHook(dir, true)).toEqual(Option.none());
      expect(yield* fs.exists(sessionFilesIn(dir).done)).toBe(false);

      yield* fs.writeFileString(sessionFilesIn(dir).answer, '"done"');
      expect(yield* stopHook(dir, true)).toEqual(Option.none());
      expect(yield* fs.exists(sessionFilesIn(dir).done)).toBe(true);
    }).pipe(Effect.provide(Exec.layer)),
  );
});
