// A run's steps drawn as its graph (run-graph.ts): a column per depth, a card
// per lane with its steps left to right, and an arrow from each lane to the
// lanes that waited on it. Each step links to its own page, and the step that
// page shows is marked.
//
// The arrows are drawn over the cards once they're laid out, from where each
// card sits, and again whenever the cards change size.

import * as Option from "effect/Option";
import { useLayoutEffect, useState } from "react";

import { stepHref } from "./routes.ts";
import { type Lane, type NodeState, type RunGraph, type StepNode, took } from "./run-graph.ts";
import { present } from "./show.tsx";
import { span } from "./time.tsx";

const MARK = {
  ok: "✓",
  failed: "✗",
  running: "●",
  ended: "○",
} satisfies { readonly [S in NodeState]: string };

const SAID = {
  ok: "succeeded",
  failed: "failed",
  running: "running",
  ended: "ended",
} satisfies { readonly [S in NodeState]: string };

const Mark = ({ state }: { readonly state: NodeState }) => (
  <span className={`mark ${state}`} aria-label={SAID[state]}>
    {MARK[state]}
  </span>
);

// How long it took, where that's known.
const Took = ({
  node,
  now,
}: {
  readonly node: {
    readonly startedAt: number;
    readonly endedAt: Option.Option<number>;
    readonly state: NodeState;
  };
  readonly now: number;
}) =>
  present(took(node.startedAt, node.endedAt, node.state, now), (millis) => (
    <span className="took">{span(millis)}</span>
  ));

const Step = ({
  chosen,
  now,
  runId,
  step,
}: {
  readonly chosen: boolean;
  readonly now: number;
  readonly runId: string;
  readonly step: StepNode;
}) => (
  <li>
    <a
      className={`chip ${step.state}`}
      href={stepHref(runId, step.step)}
      aria-current={Option.getOrUndefined(Option.liftPredicate("step" as const, () => chosen))}
      title={`${step.step}: ${SAID[step.state]}`}
    >
      <Mark state={step.state} /> {step.label} <Took node={step} now={now} />
    </a>
  </li>
);

const LaneCard = ({
  chosen,
  lane,
  now,
  runId,
}: {
  readonly chosen: Option.Option<string>;
  readonly lane: Lane;
  readonly now: number;
  readonly runId: string;
}) => (
  <article className={`lane ${lane.state}`} data-lane={lane.id} aria-label={`lane ${lane.label}`}>
    <header>
      <Mark state={lane.state} /> <strong>{lane.label}</strong> <Took node={lane} now={now} />
    </header>
    <ol className="chips">
      {lane.steps.map((step) => (
        <Step
          key={step.step}
          chosen={Option.contains(chosen, step.step)}
          now={now}
          runId={runId}
          step={step}
        />
      ))}
    </ol>
  </article>
);

// The id of the graph's box, which the arrows are drawn over.
const GRAPH_ID = "run-graph";

type Drawn = { readonly key: string; readonly path: string };

// Where a card sits in the graph's box.
const placed = (box: HTMLElement, lane: string) =>
  Option.map(
    Option.fromNullishOr(box.querySelector<HTMLElement>(`[data-lane="${CSS.escape(lane)}"]`)),
    (card) => {
      const outer = box.getBoundingClientRect();
      const inner = card.getBoundingClientRect();

      return {
        left: inner.left - outer.left + box.scrollLeft,
        right: inner.right - outer.left + box.scrollLeft,
        top: inner.top - outer.top + box.scrollTop,
      };
    },
  );

// How far down a card its arrows meet it: beside its header.
const HEADER_MIDDLE = 18;

const drawn = (box: HTMLElement, graph: RunGraph): ReadonlyArray<Drawn> =>
  graph.edges.flatMap((edge) =>
    Option.toArray(
      Option.map(Option.all([placed(box, edge.from), placed(box, edge.to)]), ([from, to]) => {
        const startX = from.right;
        const startY = from.top + HEADER_MIDDLE;
        const endX = to.left;
        const endY = to.top + HEADER_MIDDLE;
        const bend = Math.max(24, (endX - startX) / 2);

        return {
          key: `${edge.from}->${edge.to}`,
          path: `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`,
        };
      }),
    ),
  );

export const RunGraphView = ({
  chosen,
  graph,
  now,
  runId,
}: {
  // The step whose page this is, if it's one.
  readonly chosen: Option.Option<string>;
  readonly graph: RunGraph;
  readonly now: number;
  readonly runId: string;
}) => {
  const [edges, setEdges] = useState<ReadonlyArray<Drawn>>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const found = Option.fromNullishOr(document.getElementById(GRAPH_ID));

    const draw = () => {
      for (const element of Option.toArray(found)) {
        setEdges(drawn(element, graph));
        setSize({ width: element.scrollWidth, height: element.scrollHeight });
      }
    };

    draw();

    const watching = new ResizeObserver(draw);

    for (const element of Option.toArray(found)) {
      watching.observe(element);

      for (const card of element.querySelectorAll(".lane")) {
        watching.observe(card);
      }
    }

    return () => {
      watching.disconnect();
    };
  }, [graph]);

  return (
    <div className="graph" id={GRAPH_ID}>
      <svg
        className="edges"
        width={size.width}
        height={size.height}
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" />
          </marker>
        </defs>
        {edges.map((edge) => (
          <path key={edge.key} d={edge.path} markerEnd="url(#arrow)" />
        ))}
      </svg>
      {graph.columns.map((column, index) => (
        <div className="column" key={index}>
          {column.map((lane) => (
            <LaneCard key={lane.id} chosen={chosen} lane={lane} now={now} runId={runId} />
          ))}
        </div>
      ))}
    </div>
  );
};
