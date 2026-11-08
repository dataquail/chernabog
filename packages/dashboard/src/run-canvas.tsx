// A run drawn on the plan it started with, as a run's page shows it in place
// of its history graph: the plan's canvas (plan-canvas.tsx), each box a link
// to its node's page, marked with its state (RunOnPlan) and its time: how
// long it took, how long it has been running, or how long it has been
// parked. A branch the run didn't take is greyed, a node it hasn't reached
// outlined. Set up and wrap up sit at each end. A repeat shows one round,
// with a picker of its rounds; a forEach holds its lanes in columns by what
// each waited on, or its template lane until its items are known.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";

import type { BranchOnPlan, NodeOnPlan, NodeState, OffPlan, RunOnPlan } from "#daemon/protocol";

import { Arrows, MARK, Named, SAID, useArrows, whatCalls } from "./plan-canvas.tsx";
import { outcomeNode } from "./plan-graph.ts";
import { nodeHref, type NodePlace } from "./routes.ts";
import {
  bodyOf,
  laneKey,
  lanePlace,
  nodeKey,
  placeKey,
  placeOf,
  type Rounds,
  roundsFor,
  runEdges,
  shownRound,
  timeOf,
} from "./run-plan.ts";
import { present, shownIf } from "./show.tsx";

// What every box on the canvas reads.
type Canvas = {
  readonly runId: string;
  readonly now: number;
  readonly parked: Option.Option<string>;
  // The key of the place whose page this is, if any.
  readonly at: Option.Option<string>;
  readonly rounds: Rounds;
  readonly pick: (repeat: string, round: number) => void;
  // How a chain of steps is drawn, which each frame draws its steps with.
  readonly Chain: ChainView;
};

type ChainView = (props: {
  readonly canvas: Canvas;
  readonly steps: ReadonlyArray<NodeOnPlan>;
}) => ReactNode;

type Timed = {
  readonly state: NodeState;
  readonly startedAt: Option.Option<string>;
  readonly endedAt: Option.Option<string>;
};

const Mark = ({ state }: { readonly state: NodeState }) => (
  <span className={`mark ${state}`} aria-label={SAID[state]}>
    {MARK[state]}{" "}
  </span>
);

const Time = ({ canvas, timed }: { readonly canvas: Canvas; readonly timed: Timed }) =>
  present(timeOf(timed, canvas.now, canvas.parked), (said) => <span className="took">{said}</span>);

// A box: a link to its place's page, marked with its state and time.
const Box = ({
  canvas,
  children,
  className,
  keyed,
  place,
  timed,
}: {
  readonly canvas: Canvas;
  readonly children: ReactNode;
  readonly className: string;
  readonly keyed: string;
  readonly place: NodePlace;
  readonly timed: Timed;
}) => (
  <a
    className={`plan-node ${className} state-${timed.state}`}
    data-node={keyed}
    href={nodeHref(canvas.runId, place)}
    aria-current={Option.getOrUndefined(
      Option.liftPredicate("page" as const, () => Option.contains(canvas.at, keyed)),
    )}
    title={SAID[timed.state]}
  >
    <Mark state={timed.state} />
    {children} <Time canvas={canvas} timed={timed} />
  </a>
);

// A frame's header: a link to the frame's page.
const FrameName = ({
  canvas,
  children,
  node,
}: {
  readonly canvas: Canvas;
  readonly children: ReactNode;
  readonly node: NodeOnPlan;
}) => (
  <a
    className="plan-frame-name"
    href={nodeHref(canvas.runId, placeOf(node))}
    aria-current={Option.getOrUndefined(
      Option.liftPredicate("page" as const, () => Option.contains(canvas.at, nodeKey(node))),
    )}
  >
    <Mark state={node.state} />
    {children} <Time canvas={canvas} timed={node} />
  </a>
);

// Whether a branch was taken, wasn't, or isn't decided yet.
const branchClass = (branch: BranchOnPlan) => {
  if (branch.taken) {
    return "taken";
  }

  return Option.getOrElse(
    Option.map(
      Option.filter(Arr.head(branch.steps), (first) => first.state === "not-taken"),
      () => "not-taken",
    ),
    () => "open",
  );
};

const Fork = ({ canvas, node }: { readonly canvas: Canvas; readonly node: NodeOnPlan }) =>
  shownIf(node.branches.length > 0, () => (
    <div className="plan-fork">
      {node.branches.map((branch) => (
        <div className="plan-branch" key={branch.outcome}>
          <span
            className={`plan-outcome ${branchClass(branch)}`}
            data-node={outcomeNode(nodeKey(node), branch.outcome)}
          >
            {branch.outcome}
          </span>
          <canvas.Chain canvas={canvas} steps={branch.steps} />
        </div>
      ))}
    </div>
  ));

const frameClass = (kind: string, node: NodeOnPlan) => `plan-frame ${kind} state-${node.state}`;

// A repeat's rounds, the one shown pressed.
const RoundPicker = ({ canvas, node }: { readonly canvas: Canvas; readonly node: NodeOnPlan }) => {
  const shown = Option.map(shownRound(node, canvas.rounds), (round) => round.round);

  return shownIf(node.rounds.length > 0, () => (
    <nav className="plan-rounds" aria-label={`rounds of ${node.node.id}`}>
      {node.rounds.map((round) => (
        <button
          key={round.round}
          type="button"
          className={`state-${round.state}`}
          aria-pressed={Option.contains(shown, round.round)}
          onClick={() => {
            canvas.pick(nodeKey(node), round.round);
          }}
        >
          round {round.round}
        </button>
      ))}
    </nav>
  ));
};

// A forEach's lanes, a column for each depth, each lane a card.
const Lanes = ({ canvas, node }: { readonly canvas: Canvas; readonly node: NodeOnPlan }) => (
  <div className="plan-columns">
    {node.columns.map((column) => (
      <div className="plan-column" key={column.join(",")}>
        {node.lanes
          .filter((lane) => column.includes(lane.lane))
          .map((lane) => (
            <div className="plan-lane" aria-label={`lane ${lane.lane}`} key={lane.lane}>
              <Box
                canvas={canvas}
                className="lane-name"
                keyed={laneKey(node, lane.lane)}
                place={lanePlace(node, lane.lane)}
                timed={lane}
              >
                {lane.lane}
              </Box>
              <canvas.Chain canvas={canvas} steps={lane.body} />
            </div>
          ))}
      </div>
    ))}
  </div>
);

const Step = ({
  canvas,
  node,
}: {
  readonly canvas: Canvas;
  readonly node: NodeOnPlan;
}): ReactNode => {
  const plan = node.node;
  const keyed = nodeKey(node);
  const box = { canvas, keyed, place: placeOf(node), timed: node };

  switch (plan.kind) {
    case "use":
    case "stage":
      return (
        <>
          <Box {...box} className={plan.kind}>
            <Named id={plan.id} what={whatCalls(plan)} />
          </Box>
          <Fork canvas={canvas} node={node} />
        </>
      );
    case "end":
      return (
        <Box {...box} className={`end ${plan.end}`}>
          {plan.end}
        </Box>
      );
    case "next":
      return (
        <Box {...box} className="next">
          ↺ next round
        </Box>
      );
    case "first":
      return (
        <Box {...box} className="first">
          <Named id={plan.id} what={`first of ${plan.first.join(", ")}`} />
        </Box>
      );
    case "if":
      return (
        <section className={frameClass("if", node)} data-node={keyed}>
          <header>
            <FrameName canvas={canvas} node={node}>
              if <code>{plan.condition}</code>
            </FrameName>
          </header>
          <canvas.Chain canvas={canvas} steps={node.body} />
        </section>
      );
    case "repeat":
      return (
        <section className={frameClass("repeat", node)} data-node={keyed}>
          <header>
            <FrameName canvas={canvas} node={node}>
              <Named id={plan.id} what="repeat" />{" "}
              <span className="plan-loop" aria-label={`back to the start of ${plan.id}`}>
                ↺
              </span>
            </FrameName>
            <RoundPicker canvas={canvas} node={node} />
          </header>
          <canvas.Chain canvas={canvas} steps={bodyOf(node, canvas.rounds)} />
        </section>
      );
    case "forEach":
      return (
        <section className={frameClass("forEach", node)} data-node={keyed}>
          <header>
            <FrameName canvas={canvas} node={node}>
              <Named id={plan.id} what={`for each ${plan.as} in ${plan.forEach}`} />
            </FrameName>
          </header>
          {Option.match(Arr.head(node.lanes), {
            onNone: () => (
              <div className="plan-lane" aria-label="template lane">
                <canvas.Chain canvas={canvas} steps={node.body} />
              </div>
            ),
            onSome: () => <Lanes canvas={canvas} node={node} />,
          })}
        </section>
      );
  }
};

const Chain: ChainView = ({ canvas, steps }) => (
  <div className="plan-seq">
    {steps.map((node) => (
      <Step key={nodeKey(node)} canvas={canvas} node={node} />
    ))}
  </div>
);

const OffBox = ({
  canvas,
  name,
  off,
  place,
}: {
  readonly canvas: Canvas;
  readonly name: string;
  readonly off: OffPlan;
  readonly place: NodePlace;
}) => (
  <Box canvas={canvas} className="off-plan" keyed={placeKey(place)} place={place} timed={off}>
    {name}
  </Box>
);

export const RunCanvas = ({
  at,
  now,
  parked,
  run,
  runId,
}: {
  readonly run: RunOnPlan;
  readonly runId: string;
  readonly now: number;
  // When the run parked, if it waits on a signal.
  readonly parked: Option.Option<string>;
  // The place whose page this is, if any: its round is the one shown.
  readonly at: Option.Option<NodePlace>;
}) => {
  const id = useId();
  const atKey = Option.map(at, placeKey);
  const atLine = Option.getOrElse(atKey, () => "");
  const [picked, setPicked] = useState<Rounds>(new Map());

  // A link to another place shows its round again.
  useEffect(() => {
    setPicked(new Map());
  }, [atLine]);

  const rounds = useMemo(
    (): Rounds =>
      new Map([
        ...roundsFor(
          run,
          Option.liftPredicate(atLine, (key) => key !== ""),
        ),
        ...picked,
      ]),
    [run, atLine, picked],
  );

  const edges = useMemo(() => runEdges(run, rounds), [run, rounds]);
  const arrows = useArrows(id, edges);

  const canvas: Canvas = {
    runId,
    now,
    parked,
    at: atKey,
    rounds,
    pick: (repeat, round) => {
      setPicked((held) => new Map([...held, [repeat, round]]));
    },
    Chain,
  };

  return (
    <div className="plan-canvas run-canvas" id={id}>
      <Arrows arrows={arrows} />
      <div className="plan-seq">
        <OffBox canvas={canvas} name="set up" off={run.setUp} place={{ kind: "set-up" }} />
        <canvas.Chain canvas={canvas} steps={run.steps} />
        <OffBox canvas={canvas} name="wrap up" off={run.wrapUp} place={{ kind: "wrap-up" }} />
      </div>
    </div>
  );
};
