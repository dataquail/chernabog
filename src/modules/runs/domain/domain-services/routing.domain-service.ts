// Whose work a persona's flow starts on this machine: a domain service, since
// it splits a trigger's items before any run exists, so no aggregate owns it
// (docs/adr/0009-the-hexagons-remaining-stereotypes.md). Routing is the flow's:
// its trigger leaves an item for another persona or machine by giving the
// reason (`elsewhere`), as it holds one with `held`, and the engine starts
// none of those unless a person names one. The claim, its lease and fencing
// keep two runs off one item; routing only says who would rather start it.

import * as Option from "effect/Option";

// A work item, as far as routing reads it.
export type Routable = {
  readonly key: string;
  readonly elsewhere?: string;
};

const leftElsewhere = (item: Routable) => Option.isSome(Option.fromUndefinedOr(item.elsewhere));

// Splits a trigger's items into those this machine may start and those its flow left for others.
const split = <Item extends Routable>(items: ReadonlyArray<Item>) => ({
  mine: items.filter((item) => !leftElsewhere(item)),
  elsewhere: items.filter(leftElsewhere),
});

// An item left for others, with why, as its flow gave it: "issue-4 (assignee: alice)".
const describeElsewhere = (item: Routable) =>
  Option.match(Option.fromUndefinedOr(item.elsewhere), {
    onNone: () => item.key,
    onSome: (why) => `${item.key} (${why})`,
  });

export const Routing = { split, describeElsewhere } as const;
