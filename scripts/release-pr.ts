// What merging the release PR would release, read from its body as
// release-please reads it, against the versions the PR moves in the manifest.
// release-please parses the body as HTML to find each part's section, so text
// such as `chernabog cancel <run>` in a release note reads as an unclosed tag,
// and a part whose section it swallows isn't released: sdk-v0.7.0 wasn't.

import * as Arr from "effect/Array";
import * as Bool from "effect/Boolean";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import { PullRequestBody } from "release-please/build/src/util/pull-request-body.js";

export type ReleaseConfig = {
  readonly packages: Readonly<
    Record<string, { readonly component?: string; readonly "include-component-in-tag"?: boolean }>
  >;
};

export type Manifest = Readonly<Record<string, string>>;

// What HTML reads as a tag, apart from the details and summary release-please writes.
const TAG_LIKE = /<(?!\/?(?:details|summary)>)\/?[a-z][^\s<>]*>/gi;

// The component release-please looks for a part's section under: none for a
// part whose tags leave it out, as the binary's do.
const componentOf = (config: ReleaseConfig, path: string) =>
  Option.match(Record.get(config.packages, path), {
    onNone: () => "",
    onSome: (found) =>
      Bool.match(found["include-component-in-tag"] === false, {
        onTrue: () => "",
        onFalse: () => found.component ?? "",
      }),
  });

// Each version the PR moves that the body has no section for, said so a
// person can fix the body before merging.
export const unreleased = (
  body: string,
  config: ReleaseConfig,
  before: Manifest,
  after: Manifest,
): ReadonlyArray<string> => {
  const sections = PullRequestBody.parse(body)?.releaseData ?? [];
  const tags = Arr.dedupe(body.match(TAG_LIKE) ?? []);

  const hint = Arr.match(tags, {
    onEmpty: () => "",
    onNonEmpty: (found) =>
      ` The body has text HTML reads as a tag (${found.join(", ")}): write it as &lt;…&gt; in the body, then check again.`,
  });

  return Record.toEntries(after)
    .filter(([path, version]) => !Option.contains(Record.get(before, path), version))
    .filter(([path, version]) => {
      const component = componentOf(config, path);

      return !sections.some(
        (section) =>
          (section.component ?? "") === component && section.version?.toString() === version,
      );
    })
    .map(([path, version]) => {
      const name = Option.getOrElse(
        Option.liftPredicate(componentOf(config, path), (component) => component !== ""),
        () => path,
      );

      return `${name} ${version}: release-please finds no section for it in the release PR's body, so merging it would release no ${name} ${version}.${hint}`;
    });
};
