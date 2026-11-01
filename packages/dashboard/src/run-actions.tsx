// The buttons that act on runs: a flow's run now, cancel on a run in flight
// (after a confirmation in the page, never the browser's confirm()), and
// attach (copy the command, or open the session in its launcher). Each shows
// what the daemon did, or its refusal, beside it, and never retries.

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Option from "effect/Option";
import { useState } from "react";

import type { RepoStatus } from "#daemon/protocol";

import { type Action, attachLine, type Outcome, perform } from "./actions.ts";
import { either, present, shownIf } from "./show.tsx";

// What a person has filled in of a flow's run now.
export type Draft = {
  readonly flow: string;
  readonly persona: Option.Option<string>;
  readonly item: string;
};

type FlowStatus = RepoStatus["flows"][number];

// What the daemon did, or why it wouldn't, beside the button that asked.
const OutcomeView = ({ outcome }: { readonly outcome: Option.Option<Outcome> }) =>
  present(outcome, (shown) =>
    either(
      shown.kind === "refused",
      () => (
        <span className="outcome refused" role="alert">
          {shown.message}
        </span>
      ),
      () => (
        <span className="outcome" role="status">
          {shown.message}
        </span>
      ),
    ),
  );

const enabledFlows = (repo: RepoStatus) => repo.flows.filter((flow) => flow.enabled);

// The flow a draft names, else the repo's first that's on.
const chosenFlow = (flows: ReadonlyArray<FlowStatus>, draft: Draft) =>
  Option.orElse(
    Arr.findFirst(flows, (flow) => flow.name === draft.flow),
    () => Arr.head(flows),
  );

// The personas that run a flow, by name.
const personasOf = (flows: ReadonlyArray<FlowStatus>, name: string) =>
  flows
    .filter((flow) => flow.name === name)
    .flatMap((flow) => Option.toArray(Option.fromUndefinedOr(flow.persona)));

const typed = (text: string) => Option.liftPredicate(text.trim(), (item) => item !== "");

// The run now a draft asks for: its flow, the persona picked (else the
// flow's first), and the item, if one's typed.
export const runNowAction = (repo: RepoStatus, draft: Draft): Option.Option<Action> =>
  Option.map(chosenFlow(enabledFlows(repo), draft), (flow) => {
    const personas = personasOf(enabledFlows(repo), flow.name);

    return {
      kind: "run",
      repo: repo.name,
      flow: flow.name,
      item: typed(draft.item),
      persona: Option.orElse(
        Option.filter(draft.persona, (picked) => personas.includes(picked)),
        () => Arr.head(personas),
      ),
    };
  });

export const RunNowForm = ({
  draft,
  onDraft,
  onSubmit,
  outcome,
  pending,
  repo,
}: {
  readonly repo: RepoStatus;
  readonly draft: Draft;
  readonly pending: boolean;
  readonly outcome: Option.Option<Outcome>;
  readonly onDraft: (draft: Draft) => void;
  readonly onSubmit: () => void;
}) => {
  const flows = enabledFlows(repo);

  return present(chosenFlow(flows, draft), (flow) => {
    const personas = personasOf(flows, flow.name);
    const manual = flows.some((each) => each.name === flow.name && each.manual === true);

    const placeholder = Option.match(Option.liftPredicate(manual, Boolean), {
      onSome: () => "item, such as #73 (required)",
      onNone: () => "item, such as #73 (optional)",
    });

    return (
      <form
        className="actions run-now"
        aria-label={`Run a flow of ${repo.name} now`}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <select
          aria-label="flow"
          value={flow.name}
          onChange={(event) => {
            onDraft({ ...draft, flow: event.target.value, persona: Option.none() });
          }}
        >
          {Arr.dedupe(flows.map((each) => each.name)).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        {shownIf(personas.length > 1, () => (
          <select
            aria-label="persona"
            value={Option.getOrElse(draft.persona, () => personas[0] ?? "")}
            onChange={(event) => {
              onDraft({ ...draft, persona: Option.some(event.target.value) });
            }}
          >
            {personas.map((login) => (
              <option key={login} value={login}>
                @{login}
              </option>
            ))}
          </select>
        ))}
        <input
          aria-label="item"
          type="text"
          placeholder={placeholder}
          value={draft.item}
          onChange={(event) => {
            onDraft({ ...draft, item: event.target.value });
          }}
        />
        <button type="submit" disabled={pending}>
          Run now
        </button>
        <OutcomeView outcome={outcome} />
      </form>
    );
  });
};

export const CancelControl = ({
  closeSessions,
  confirming,
  label,
  onAsk,
  onCloseSessions,
  onConfirm,
  onKeep,
  outcome,
  pending,
}: {
  readonly label: string;
  readonly confirming: boolean;
  readonly closeSessions: boolean;
  readonly pending: boolean;
  readonly outcome: Option.Option<Outcome>;
  readonly onAsk: () => void;
  readonly onCloseSessions: (close: boolean) => void;
  readonly onConfirm: () => void;
  readonly onKeep: () => void;
}) => (
  <span className="actions">
    {either(
      confirming,
      () => (
        <span className="confirm" role="group" aria-label="Confirm the cancel">
          <span>Cancel {label}? It stops for good, and its worktrees and claim are released.</span>{" "}
          <label>
            <input
              type="checkbox"
              checked={closeSessions}
              onChange={(event) => {
                onCloseSessions(event.target.checked);
              }}
            />{" "}
            close its agent sessions
          </label>{" "}
          <button type="button" className="danger" disabled={pending} onClick={onConfirm}>
            Yes, cancel
          </button>{" "}
          <button type="button" onClick={onKeep}>
            Keep it
          </button>
        </span>
      ),
      () => (
        <button type="button" disabled={pending} onClick={onAsk}>
          Cancel
        </button>
      ),
    )}{" "}
    <OutcomeView outcome={outcome} />
  </span>
);

export const AttachControl = ({
  onCopy,
  onOpen,
  opens,
  outcome,
  pending,
}: {
  readonly opens: boolean;
  readonly pending: boolean;
  readonly outcome: Option.Option<Outcome>;
  readonly onCopy: () => void;
  readonly onOpen: () => void;
}) => (
  <span className="actions">
    <button type="button" onClick={onCopy}>
      Copy attach command
    </button>{" "}
    {shownIf(opens, () => (
      <button type="button" disabled={pending} onClick={onOpen}>
        Open in launcher
      </button>
    ))}{" "}
    <OutcomeView outcome={outcome} />
  </span>
);

// One button's request in flight and how its last one came out.
const useAction = () => {
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Option.Option<Outcome>>(Option.none());

  const act = (action: Action) => {
    setPending(true);
    setOutcome(Option.none());

    Effect.runFork(
      perform(location.origin, action).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.flatMap((came) =>
          Effect.sync(() => {
            setOutcome(Option.some(came));
            setPending(false);
          }),
        ),
      ),
    );
  };

  const say = (said: Outcome) => {
    setOutcome(Option.some(said));
  };

  return { act, outcome, pending, say };
};

// A repo's run now: a flow, a persona when several run it, and an item.
export const RunNow = ({ repo }: { readonly repo: RepoStatus }) => {
  const { act, outcome, pending } = useAction();
  const [draft, setDraft] = useState<Draft>({ flow: "", persona: Option.none(), item: "" });

  return (
    <RunNowForm
      repo={repo}
      draft={draft}
      pending={pending}
      outcome={outcome}
      onDraft={setDraft}
      onSubmit={() => {
        Option.map(runNowAction(repo, draft), act);
      }}
    />
  );
};

type RunInFlight = {
  readonly id: string;
  readonly repo: string;
  readonly flow: string;
  readonly itemKey: string;
};

// What a person can do to a run in flight: cancel it, or attach to it.
export const RunActions = ({
  opens,
  run,
}: {
  readonly run: RunInFlight;
  readonly opens: boolean;
}) => {
  const cancelling = useAction();
  const attaching = useAction();
  const [confirming, setConfirming] = useState(false);
  const [closeSessions, setCloseSessions] = useState(false);

  const copy = () => {
    const line = attachLine(run.id);

    void navigator.clipboard.writeText(line).then(
      () => {
        attaching.say({ kind: "done", message: `copied: ${line}` });
      },
      () => {
        attaching.say({ kind: "refused", message: `couldn't copy it; run ${line}` });
      },
    );
  };

  return (
    <div className="run-actions">
      <CancelControl
        label={`${run.repo}/${run.flow} ${run.itemKey}`}
        confirming={confirming}
        closeSessions={closeSessions}
        pending={cancelling.pending}
        outcome={cancelling.outcome}
        onAsk={() => {
          setConfirming(true);
        }}
        onCloseSessions={setCloseSessions}
        onConfirm={() => {
          setConfirming(false);
          cancelling.act({ kind: "cancel", runId: run.id, closeSessions });
        }}
        onKeep={() => {
          setConfirming(false);
        }}
      />
      <AttachControl
        opens={opens}
        pending={attaching.pending}
        outcome={attaching.outcome}
        onCopy={copy}
        onOpen={() => {
          attaching.act({ kind: "attach", runId: run.id });
        }}
      />
    </div>
  );
};
