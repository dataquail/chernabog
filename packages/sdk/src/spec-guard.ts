// Changing an approved behavior spec needs a person (ADR 22, decision 3). A
// pull request whose diff against its base touches a feature file goes to a
// person before any persona reviews, addresses or merges it, unless a person
// approved a head whose feature files are the same as its head's now.
//
// A person is a trusted login (an owner, member or collaborator of the repo)
// that is none of the repo's personas, as its committed config lists them
// (Repo.personas), and no bot. Their review is intent, read from GitHub:
// nothing chernabog writes, a comment, marker or label, clears the check.

import { GitHub, pathsMatching, Repo, type SubmittedReview, type TreeFile } from "@chernabog/core";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

// Where the behavior specs live, and which files there are specs.
export const FEATURES_DIRECTORY = "test/features";
export const FEATURE_FILES: ReadonlyArray<string> = [`${FEATURES_DIRECTORY}/**/*.feature`];

// The feature files among a pull request's changed paths.
export const featureFilesIn = (paths: ReadonlyArray<string>) => pathsMatching(paths, FEATURE_FILES);

const sameLogin = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

// Whether a login is a person's: not one of `personas`, and not a bot's.
export const isPerson = (login: string, personas: ReadonlyArray<string>) =>
  login.length > 0 &&
  !login.toLowerCase().endsWith("[bot]") &&
  !personas.some((persona) => sameLogin(persona, login));

// The heads people approved, newest first: each person's latest review that
// decides (approves, requests changes or was dismissed), when it approves. A
// dismissed review, which GitHub lists as DISMISSED, approves nothing and
// leaves none of that person's earlier approvals standing, as GitHub's own
// review decision does, until they approve again; an untrusted login's
// review, or a persona's, never counts.
export const approvedHeads = (
  reviews: ReadonlyArray<SubmittedReview>,
  personas: ReadonlyArray<string>,
) => {
  const latest = new Map<string, SubmittedReview>();

  for (const review of reviews) {
    if (
      review.trusted === true &&
      isPerson(review.author, personas) &&
      (review.state === "APPROVED" ||
        review.state === "CHANGES_REQUESTED" ||
        review.state === "DISMISSED")
    ) {
      latest.delete(review.author.toLowerCase());
      latest.set(review.author.toLowerCase(), review);
    }
  }

  return [
    ...new Set(
      [...latest.values()]
        .flatMap((review) =>
          Option.toArray(
            Option.liftPredicate(
              review.commitSha,
              (sha) => review.state === "APPROVED" && sha.length > 0,
            ),
          ),
        )
        .toReversed(),
    ),
  ];
};

// The feature files in a commit's tree, by path, as a key two commits with
// the same feature files share.
const featuresKey = (files: ReadonlyArray<TreeFile>) => {
  const features = new Set(featureFilesIn(files.map((file) => file.path)));

  return files
    .flatMap((file) =>
      Option.toArray(
        Option.liftPredicate(`${file.path}\t${file.sha}`, () => features.has(file.path)),
      ),
    )
    .toSorted()
    .join("\n");
};

const featuresAt = (sha: string) =>
  GitHub.use((github) => github.treeFiles(sha, FEATURES_DIRECTORY)).pipe(Effect.map(featuresKey));

const listed = (paths: ReadonlyArray<string>) => paths.map((path) => `\`${path}\``).join(", ");

// Why the pull request must go to a person before a persona works on it: none
// when it is no longer open, touches no feature file, or a person approved a
// head with the same feature files as its head.
export const unapproved = (pullRequest: number) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const pull = yield* github.pullRequest(pullRequest);

    if (pull.state !== "open") {
      return Option.none<string>();
    }

    const touched = featureFilesIn(yield* github.pullRequestFiles(pullRequest));

    if (touched.length === 0) {
      return Option.none<string>();
    }

    const repo = yield* Repo;
    const personas = [...repo.personas, ...Option.toArray(Option.fromUndefinedOr(repo.persona))];
    const heads = approvedHeads(yield* github.reviews(pullRequest), personas);
    const changes = `it changes behavior specs (${listed(touched)}), which only a person approves`;

    if (heads.length === 0) {
      return Option.some(
        `${changes}. An approving review by a person, not one of the repo's personas, clears it.`,
      );
    }

    if (heads.includes(pull.headSha)) {
      return Option.none<string>();
    }

    const current = yield* featuresAt(pull.headSha);

    for (const head of heads) {
      if ((yield* featuresAt(head)) === current) {
        return Option.none<string>();
      }
    }

    return Option.some(
      `${changes}, and they changed since a person last approved them. An approving review of this head by a person, not one of the repo's personas, clears it.`,
    );
  });
