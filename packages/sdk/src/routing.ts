// Whose work a persona's flow starts: a trigger routes each item it reports
// by the people on it, as GitHub's assignee: and review-requested: qualifiers
// do, and leaves the others for another persona or machine, saying why. The
// engine starts nothing it leaves, and `chernabog status` lists it with the
// reason. A flow can route by anything else, a label or a path, by setting
// the item's `elsewhere` itself.
//
// A repo sets the filters in .chernabog/config.yaml under
// `flows.<name>.settings`, and a person per persona in machine config:
// `assignee: ["@me", none]`, `reviewRequested: "@me"`. Until core's next major
// (ADR 0005), the binary also gives a flow the old `flows.<name>.assignee`
// and `reviewRequested` keys as these settings.

import { GitHub, type GitHubError, Settings as CoreSettings, type WorkItem } from "@chernabog/core";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Who an item must be for: @me (the persona's GitHub login), a login, or none for nobody.
const Who = Schema.Union([Schema.String, Schema.Array(Schema.String)]);

const whoFor = (qualifier: string) =>
  Schema.optionalKey(
    Schema.OptionFromNullOr(Who).annotate({
      description: `Start only work items whose ${qualifier} include one of these: @me for the persona's GitHub login, a login, or none for nobody. null clears the team's.`,
    }),
  );

export const Settings = Schema.Struct({
  assignee: whoFor("assignees"),
  reviewRequested: whoFor("requested reviewers"),
});

// The people on an item, as routing reads them: its assignees, and who is asked to review it.
export type People = {
  readonly assignees?: ReadonlyArray<string>;
  readonly reviewers?: ReadonlyArray<string>;
};

// A filter the flow's settings set; none when they leave it out, or clear it with null.
const listOf = (who: (typeof Settings.Type)["assignee"]) =>
  Option.map(Option.flatten(Option.fromUndefinedOr(who)), (found): ReadonlyArray<string> =>
    [found].flat(),
  );

const lower = (login: string) => login.toLowerCase();

// Whether people match a filter: none for nobody, @me for the persona, or a
// login. Case-insensitive, as on GitHub.
const matches = (filter: ReadonlyArray<string>, people: ReadonlyArray<string>, me: string) =>
  filter.some((who) => {
    const wanted = lower(who);

    if (wanted === "none") {
      return people.length === 0;
    }

    if (wanted === "@me") {
      return people.some((person) => lower(person) === lower(me));
    }

    return people.some((person) => lower(person) === wanted);
  });

const named = (people: ReadonlyArray<string>) =>
  Option.getOrElse(
    Option.liftPredicate(people.join(", "), (text) => text.length > 0),
    () => "none",
  );

// Why the flow's routing leaves an item with these people for others, such as
// "assignee: alice"; none when it's this persona's. The persona's login is
// asked of GitHub only when a filter names @me.
export const leftFor = (
  people: People,
): Effect.Effect<Option.Option<string>, GitHubError, GitHub> =>
  Effect.gen(function* () {
    const own = yield* CoreSettings.read(Settings);

    const filters = [
      { label: "assignee", filter: listOf(own.assignee), people: people.assignees ?? [] },
      {
        label: "review requested",
        filter: listOf(own.reviewRequested),
        people: people.reviewers ?? [],
      },
    ].flatMap((one) => Option.toArray(Option.map(one.filter, (filter) => ({ ...one, filter }))));

    if (filters.length === 0) {
      return Option.none();
    }

    let me = "";

    if (filters.some((one) => one.filter.some((who) => lower(who) === "@me"))) {
      me = yield* GitHub.use((github) => github.login);
    }

    if (filters.every((one) => matches(one.filter, one.people, me))) {
      return Option.none();
    }

    return Option.some(filters.map((one) => `${one.label}: ${named(one.people)}`).join("; "));
  });

// The item, left for others when the flow's routing says it isn't this persona's.
export const route = (item: WorkItem, people: People) =>
  Effect.map(leftFor(people), (why) =>
    Option.match(why, {
      onNone: () => item,
      onSome: (elsewhere): WorkItem => ({ ...item, elsewhere }),
    }),
  );
