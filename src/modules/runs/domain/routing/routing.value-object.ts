// Whose work a persona's flow starts on this machine: the work items whose
// assignees and requested reviewers pass the filters the flow sets, as
// GitHub's assignee: and review-requested: qualifiers do.

import * as Option from "effect/Option";

// Whose work items a flow starts as a persona; anyone's without a filter.
export type Routing = {
  readonly assignee: Option.Option<ReadonlyArray<string>>;
  readonly reviewRequested: Option.Option<ReadonlyArray<string>>;
};

// A work item, as far as routing reads it.
export type Routable = {
  readonly key: string;
  readonly assignees?: ReadonlyArray<string>;
  readonly reviewers?: ReadonlyArray<string>;
};

// Whether people match a filter, as GitHub's assignee: and review-requested:
// do: none for nobody, @me for this machine's GitHub login, or a login. @me
// matches no one when the login is unknown. Case-insensitive, as on GitHub.
const matches = (
  filter: ReadonlyArray<string>,
  people: ReadonlyArray<string>,
  login: Option.Option<string>,
) =>
  filter.some((who) => {
    const wanted = who.toLowerCase();

    if (wanted === "none") {
      return people.length === 0;
    }

    let resolved = Option.some(wanted);

    if (wanted === "@me") {
      resolved = Option.map(login, (self) => self.toLowerCase());
    }

    return Option.exists(resolved, (one) => people.some((person) => person.toLowerCase() === one));
  });

// A filter the flow doesn't set passes everyone.
const passes = (
  filter: Option.Option<ReadonlyArray<string>>,
  people: ReadonlyArray<string>,
  login: Option.Option<string>,
) => Option.match(filter, { onNone: () => true, onSome: (who) => matches(who, people, login) });

// Whether this machine may start an item: it passes every filter the flow sets.
const startsHere = (item: Routable, routing: Routing, login: Option.Option<string>) =>
  passes(routing.assignee, item.assignees ?? [], login) &&
  passes(routing.reviewRequested, item.reviewers ?? [], login);

// Splits a trigger's items into those this machine may start and those for others.
export const routeItems = <Item extends Routable>(
  items: ReadonlyArray<Item>,
  routing: Routing,
  login: Option.Option<string>,
) => ({
  mine: items.filter((item) => startsHere(item, routing, login)),
  elsewhere: items.filter((item) => !startsHere(item, routing, login)),
});

const people = (who: ReadonlyArray<string>) =>
  Option.getOrElse(
    Option.liftPredicate(who.join(", "), (text) => text.length > 0),
    () => "none",
  );

// An item left for others, with whom it is for by the filters the flow sets.
export const describeElsewhere = (routing: Routing) => (item: Routable) => {
  const assignee = Option.map(routing.assignee, () => `assignee: ${people(item.assignees ?? [])}`);

  const reviewers = Option.map(
    routing.reviewRequested,
    () => `review requested: ${people(item.reviewers ?? [])}`,
  );

  return `${item.key} (${[...Option.toArray(assignee), ...Option.toArray(reviewers)].join("; ")})`;
};

// Whether a filter names this machine's login, as @me.
export const namesMe = (filter: Option.Option<ReadonlyArray<string>>) =>
  Option.exists(filter, (who) => who.some((one) => one.toLowerCase() === "@me"));
