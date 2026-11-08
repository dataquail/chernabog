import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Where in its plan a run did something: the plan node, by its id in the
// plan (FlowPlan), the round of the `repeat` it ran in, and the lane of the
// `forEach`, each absent outside one. Core's CurrentNode, as a run's history
// keeps it.
export class NodeRef extends Schema.Class<NodeRef, { readonly brand: "NodeRef" }>("NodeRef")({
  id: Schema.String,
  round: Schema.optionalKey(Schema.Int),
  lane: Schema.optionalKey(Schema.String),
}) {}

// A node in a round and a lane, each none outside one, as a NodeRef.
const of = (node: {
  readonly id: string;
  readonly round: Option.Option<number>;
  readonly lane: Option.Option<string>;
}) =>
  NodeRef.make({
    id: node.id,
    ...Option.match(node.round, { onNone: () => ({}), onSome: (round) => ({ round }) }),
    ...Option.match(node.lane, { onNone: () => ({}), onSome: (lane) => ({ lane }) }),
  });

// The round and the lane of a NodeRef, each none outside one.
const roundOf = (node: NodeRef) => Option.fromUndefinedOr(node.round);

const laneOf = (node: NodeRef) => Option.fromUndefinedOr(node.lane);

// Whether two name one node in one round of one lane.
const same = (left: NodeRef, right: NodeRef) =>
  left.id === right.id && left.round === right.round && left.lane === right.lane;

// A node in a round and a lane, as one line, for an event's id: `ci@2#task-10`.
const keyOf = (node: NodeRef) =>
  [
    node.id,
    ...Option.toArray(Option.map(roundOf(node), (round) => `@${round}`)),
    ...Option.toArray(Option.map(laneOf(node), (lane) => `#${lane}`)),
  ].join("");

export const NodeRefs = { of, roundOf, laneOf, same, keyOf } as const;
