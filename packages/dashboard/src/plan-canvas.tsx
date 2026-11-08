// A flow's plan drawn on a canvas: a sequence as a chain left to right; a
// block's outcomes as a fork, each branch a row below it behind a label of its
// outcome; a repeat as a frame with an arrow back to its start; a forEach as a
// frame holding its template lane; an if as a frame over its step; and an end
// as a terminal node, done or needs-human. The boxes lay themselves out as
// the plan's tree nests, and plan-graph.ts says which arrows join them.
//
// The arrows are drawn over the boxes once they're laid out, from where each
// box sits, and again whenever a box changes size, as run-graph-view.tsx does.
//
// It is view-only: clicking a node chooses it, for the page to show its
// detail. A run's node states (RunOnPlan, by nodeStates) mark the nodes when
// given, so a run's page draws the run on its plan with this same canvas.

import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import { type ReactNode, useId, useLayoutEffect, useMemo, useState } from "react";

import type { FlowPlan, NodeState, PlanNode } from "#daemon/protocol";

import {
  inputsOf,
  nodeById,
  type NodeStates,
  outcomeNode,
  type PlanEdge,
  planEdges,
  type PlanInput,
} from "./plan-graph.ts";
import { either, present, shownIf } from "./show.tsx";

const MARK = {
  ok: "✓",
  failed: "✗",
  running: "●",
  waiting: "◷",
  "not-taken": "–",
  "not-reached": "○",
} satisfies { readonly [S in NodeState]: string };

const SAID = {
  ok: "succeeded",
  failed: "failed",
  running: "running",
  waiting: "waiting",
  "not-taken": "not taken",
  "not-reached": "not reached",
} satisfies { readonly [S in NodeState]: string };

// What every node on the canvas reads: the run's states, if any, the node
// chosen, and where a click goes.
type Canvas = {
  readonly states: Option.Option<NodeStates>;
  readonly chosen: Option.Option<string>;
  readonly onChoose: (id: string) => void;
};

const stateOf = (canvas: Canvas, id: string) =>
  Option.flatMap(canvas.states, (states) => Option.fromUndefinedOr(states.get(id)));

const stateClass = (canvas: Canvas, id: string) =>
  Option.getOrElse(
    Option.map(stateOf(canvas, id), (state) => ` state-${state}`),
    () => "",
  );

const Mark = ({ canvas, id }: { readonly canvas: Canvas; readonly id: string }) =>
  present(stateOf(canvas, id), (state) => (
    <span className={`mark ${state}`} aria-label={SAID[state]}>
      {MARK[state]}{" "}
    </span>
  ));

// A node's box: a button that chooses it.
const NodeBox = ({
  canvas,
  children,
  className,
  end,
  id,
}: {
  readonly canvas: Canvas;
  readonly children: ReactNode;
  readonly className: string;
  readonly end?: string;
  readonly id: string;
}) => (
  <button
    type="button"
    className={`plan-node ${className}${stateClass(canvas, id)}`}
    data-node={id}
    data-end={end}
    aria-pressed={Option.contains(canvas.chosen, id)}
    onClick={() => {
      canvas.onChoose(id);
    }}
  >
    <span>
      <Mark canvas={canvas} id={id} />
      {children}
    </span>
  </button>
);

// A frame's header, which chooses the frame.
const FrameHeader = ({
  canvas,
  children,
  id,
}: {
  readonly canvas: Canvas;
  readonly children: ReactNode;
  readonly id: string;
}) => (
  <header>
    <button
      type="button"
      className="plan-frame-name"
      aria-pressed={Option.contains(canvas.chosen, id)}
      onClick={() => {
        canvas.onChoose(id);
      }}
    >
      <Mark canvas={canvas} id={id} />
      {children}
    </button>
  </header>
);

const Named = ({ id, what }: { readonly id: string; readonly what: string }) => (
  <>
    <strong>{id}</strong> <span className="muted">{what}</span>
  </>
);

type Item = (props: { readonly canvas: Canvas; readonly node: PlanNode }) => ReactNode;

// A chain of steps, left to right.
const chainOf =
  (Step: Item) =>
  ({ canvas, steps }: { readonly canvas: Canvas; readonly steps: ReadonlyArray<PlanNode> }) => (
    <div className="plan-seq">
      {steps.map((node) => (
        <Step key={node.id} canvas={canvas} node={node} />
      ))}
    </div>
  );

type CallNode = Extract<PlanNode, { readonly kind: "use" | "stage" }>;

// The block a step uses, or the stage it runs.
const whatCalls = (node: CallNode) => {
  if (node.kind === "use") {
    return node.block;
  }

  return `stage ${node.stage}`;
};

// A block or a stage, and the fork of its outcome branches, if it has any.
const Call = ({
  Chain,
  canvas,
  node,
}: {
  readonly canvas: Canvas;
  readonly Chain: ReturnType<typeof chainOf>;
  readonly node: CallNode;
}) => (
  <>
    <NodeBox canvas={canvas} className={node.kind} id={node.id}>
      <Named id={node.id} what={whatCalls(node)} />
    </NodeBox>
    {shownIf(node.branches.length > 0, () => (
      <div className="plan-fork">
        {node.branches.map((branch) => (
          <div className="plan-branch" key={branch.outcome}>
            <span className="plan-outcome" data-node={outcomeNode(node.id, branch.outcome)}>
              {branch.outcome}
            </span>
            <Chain canvas={canvas} steps={branch.steps} />
          </div>
        ))}
      </div>
    ))}
  </>
);

const Step: Item = ({ canvas, node }) => {
  const Chain = chainOf(Step);

  switch (node.kind) {
    case "use":
    case "stage":
      return <Call canvas={canvas} Chain={Chain} node={node} />;
    case "end":
      return (
        <NodeBox canvas={canvas} className={`end ${node.end}`} end={node.end} id={node.id}>
          {node.end}
        </NodeBox>
      );
    case "next":
      return (
        <NodeBox canvas={canvas} className="next" id={node.id}>
          ↺ next round
        </NodeBox>
      );
    case "first":
      return (
        <NodeBox canvas={canvas} className="first" id={node.id}>
          <Named id={node.id} what={`first of ${node.first.join(", ")}`} />
        </NodeBox>
      );
    case "if":
      return (
        <section className={`plan-frame if${stateClass(canvas, node.id)}`} data-node={node.id}>
          <FrameHeader canvas={canvas} id={node.id}>
            if <code>{node.condition}</code>
          </FrameHeader>
          <Chain canvas={canvas} steps={node.steps} />
        </section>
      );
    case "repeat":
      return (
        <section className={`plan-frame repeat${stateClass(canvas, node.id)}`} data-node={node.id}>
          <FrameHeader canvas={canvas} id={node.id}>
            <Named id={node.id} what="repeat" />{" "}
            <span className="plan-loop" aria-label={`back to the start of ${node.id}`}>
              ↺
            </span>
          </FrameHeader>
          <Chain canvas={canvas} steps={node.steps} />
        </section>
      );
    case "forEach":
      return (
        <section className={`plan-frame forEach${stateClass(canvas, node.id)}`} data-node={node.id}>
          <FrameHeader canvas={canvas} id={node.id}>
            <Named id={node.id} what={`for each ${node.as} in ${node.forEach}`} />
          </FrameHeader>
          <div className="plan-lane" aria-label="template lane">
            <Chain canvas={canvas} steps={node.steps} />
          </div>
        </section>
      );
  }
};

const Steps = chainOf(Step);

type Drawn = { readonly key: string; readonly path: string; readonly kind: PlanEdge["kind"] };

type Box = {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly anchor: number;
};

// How far down a box its arrows meet it: beside its first line.
const LINE_MIDDLE = 18;

// How high a loop rises over the frame it goes back to.
const LOOP_RISE = 28;

// Where a node's box sits in the canvas.
const placed = (canvas: HTMLElement, id: string) =>
  Option.map(
    Option.fromNullishOr(canvas.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"]`)),
    (box): Box => {
      const outer = canvas.getBoundingClientRect();
      const inner = box.getBoundingClientRect();
      const top = inner.top - outer.top + canvas.scrollTop;

      return {
        left: inner.left - outer.left + canvas.scrollLeft,
        right: inner.right - outer.left + canvas.scrollLeft,
        top,
        anchor: top + Math.min(LINE_MIDDLE, inner.height / 2),
      };
    },
  );

const loopStart = (edge: PlanEdge, from: Box) => {
  if (edge.from === edge.to) {
    return from.right - 16;
  }

  return (from.left + from.right) / 2;
};

const curve = (edge: PlanEdge, from: Box, to: Box) => {
  if (edge.kind === "loop") {
    // Up from the top of the node, and down into the top of the repeat's frame,
    // at its start; a frame's own loop leaves from its end.
    const startX = loopStart(edge, from);
    const endX = to.left + 16;
    const rise = Math.min(from.top, to.top) - LOOP_RISE;

    return `M ${startX} ${from.top} C ${startX} ${rise}, ${endX} ${rise}, ${endX} ${to.top}`;
  }

  const bend = Math.max(16, (to.left - from.right) / 2);

  return `M ${from.right} ${from.anchor} C ${from.right + bend} ${from.anchor}, ${to.left - bend} ${to.anchor}, ${to.left} ${to.anchor}`;
};

const drawn = (canvas: HTMLElement, edges: ReadonlyArray<PlanEdge>): ReadonlyArray<Drawn> =>
  edges.flatMap((edge) =>
    Option.toArray(
      Option.map(
        Option.all([placed(canvas, edge.from), placed(canvas, edge.to)]),
        ([from, to]) => ({
          key: `${edge.kind}:${edge.from}->${edge.to}`,
          kind: edge.kind,
          path: curve(edge, from, to),
        }),
      ),
    ),
  );

export const PlanCanvas = ({
  chosen,
  onChoose,
  plan,
  states,
}: {
  readonly plan: FlowPlan;
  // A run's node states; none draws the plan alone.
  readonly states: Option.Option<NodeStates>;
  readonly chosen: Option.Option<string>;
  readonly onChoose: (id: string) => void;
}) => {
  const id = useId();
  const edges = useMemo(() => planEdges(plan.steps), [plan]);
  const [lines, setLines] = useState<ReadonlyArray<Drawn>>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const found = Option.fromNullishOr(document.getElementById(id));

    const draw = () => {
      for (const element of Option.toArray(found)) {
        setLines(drawn(element, edges));
        setSize({ width: element.scrollWidth, height: element.scrollHeight });
      }
    };

    draw();

    const watching = new ResizeObserver(draw);

    for (const element of Option.toArray(found)) {
      watching.observe(element);

      for (const box of element.querySelectorAll("[data-node]")) {
        watching.observe(box);
      }
    }

    return () => {
      watching.disconnect();
    };
  }, [id, edges]);

  return (
    <div className="plan-canvas" id={id}>
      <svg
        className="edges"
        width={size.width}
        height={size.height}
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <marker
            id="plan-arrow"
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
        {lines.map((line) => (
          <path key={line.key} className={line.kind} d={line.path} markerEnd="url(#plan-arrow)" />
        ))}
      </svg>
      <Steps canvas={{ states, chosen, onChoose }} steps={plan.steps} />
    </div>
  );
};

const Inputs = ({ inputs }: { readonly inputs: ReadonlyArray<PlanInput> }) =>
  either(
    inputs.length === 0,
    () => <p className="muted">No inputs.</p>,
    () => (
      <table className="plan-inputs">
        <thead>
          <tr>
            <th>Input</th>
            <th>From</th>
            <th>Wire or value</th>
          </tr>
        </thead>
        <tbody>
          {inputs.map((input) => (
            <tr key={`${input.under}:${input.name}`}>
              <th>{input.name}</th>
              <td>{input.under}</td>
              <td>
                <code>{input.from}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    ),
  );

const Line = ({ label, text }: { readonly label: string; readonly text: string }) => (
  <p>
    <span className="muted">{label}:</span> <code>{text}</code>
  </p>
);

const Wires = ({ wiring }: { readonly wiring: { readonly [name: string]: Schema.Json } }) => (
  <ul>
    {Object.keys(wiring).map((name) => (
      <li key={name}>
        <code>{name}</code>
      </li>
    ))}
  </ul>
);

// What an end says: its summary, or why it needs a person.
const EndSaid = ({ node }: { readonly node: Extract<PlanNode, { readonly kind: "end" }> }) => {
  if (node.end === "needs-human") {
    return <Line label="reason" text={node.reason} />;
  }

  return present(Option.fromUndefinedOr(node.summary), (summary) => (
    <Line label="summary" text={summary} />
  ));
};

const Said = ({ node }: { readonly node: PlanNode }) => {
  switch (node.kind) {
    case "use":
      return (
        <>
          <Line label="block" text={node.block} />
          {present(Option.fromUndefinedOr(node.about), (about) => (
            <p>{about}</p>
          ))}
          <Inputs inputs={inputsOf(node)} />
        </>
      );
    case "stage":
      return (
        <>
          <Line label="stage" text={node.stage} />
          <Inputs inputs={inputsOf(node)} />
        </>
      );
    case "end":
      return (
        <>
          <Line label="ends the run" text={node.end} />
          <EndSaid node={node} />
        </>
      );
    case "next":
      return (
        <>
          <p>Goes back to the start of its repeat, carrying:</p>
          <Wires wiring={node.next} />
        </>
      );
    case "first":
      return <p>The first of {node.first.join(", ")} that ran.</p>;
    case "if":
      return <Line label="runs its step when" text={node.condition} />;
    case "repeat":
      return (
        <>
          <p>Runs its steps round after round, until one ends the run, carrying:</p>
          <Wires wiring={node.state} />
        </>
      );
    case "forEach":
      return (
        <>
          <Line label="for each" text={`${node.as} in ${node.forEach}`} />
          <Line label="scope" text={node.scope} />
          <Line label="at once" text={node.atOnce} />
        </>
      );
  }
};

// What a node is: its block or stage, what the block does and where each
// input comes from; how an end ends; what a frame repeats over.
export const PlanNodeDetail = ({ node }: { readonly node: PlanNode }) => (
  <aside className="plan-detail" aria-label={`node ${node.id}`}>
    <h3>{node.id}</h3>
    <Said node={node} />
  </aside>
);

// A plan on its canvas, and the detail of the node clicked on it.
export const PlanView = ({
  plan,
  states,
}: {
  readonly plan: FlowPlan;
  readonly states: Option.Option<NodeStates>;
}) => {
  const [chosen, setChosen] = useState<Option.Option<string>>(Option.none());

  return (
    <div className="plan-view">
      <PlanCanvas
        plan={plan}
        states={states}
        chosen={chosen}
        onChoose={(id) => {
          setChosen(Option.some(id));
        }}
      />
      {Option.match(
        Option.flatMap(chosen, (id) => nodeById(plan.steps, id)),
        {
          onNone: () => <p className="plan-detail muted">Click a node to see what it does.</p>,
          onSome: (node) => <PlanNodeDetail node={node} />,
        },
      )}
    </div>
  );
};
