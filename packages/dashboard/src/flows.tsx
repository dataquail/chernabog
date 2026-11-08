// Every flow the daemon runs, in one table, on ones first: what it is, the
// repo and persona it runs in and as, its schedule, when it ticks next and
// last, what its work waits on, and why its last tick started nothing. Off
// ones fold away below. Each carries the controls that change it
// (controls.ts), for the persona it belongs to; what one asks for goes to
// `act`.
//
// A flow is a row of its own rather than something under its repo, so a
// flow that later spans repos, or runs as no persona, has a place here.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";

import type { DaemonStatus, RepoStatus } from "#daemon/protocol";

import { flowSwitch, type ScheduleControl, scheduleField } from "./controls.ts";
import type { Attempt } from "./settings.ts";
import { either, present } from "./show.tsx";
import { When } from "./time.tsx";

type FlowStatus = RepoStatus["flows"][number];

type Skip = DaemonStatus["skips"][number];

const optional = Option.fromUndefinedOr;

// Where a control's attempt goes.
export type Act = (attempt: Attempt) => void;

// A flow, the repo it's in, and why its last tick started nothing, if it didn't.
export type FlowEntry = {
  readonly repo: RepoStatus;
  readonly flow: FlowStatus;
  readonly skip: Option.Option<Skip>;
};

export const Persona = ({ persona }: { readonly persona: Option.Option<string> }) =>
  Option.match(persona, {
    onNone: () => <span className="muted">default</span>,
    onSome: (login) => <>@{login}</>,
  });

const Time = ({ iso, now }: { readonly iso: Option.Option<string>; readonly now: number }) =>
  Option.match(iso, {
    onNone: () => <span className="muted">—</span>,
    onSome: (at) => <When iso={at} now={now} />,
  });

// A line of what a flow says, or nothing when it says none.
const Line = ({ label, text }: { readonly label: string; readonly text: Option.Option<string> }) =>
  present(text, (says) => (
    <div>
      <span className="muted">{label}:</span> {says}
    </div>
  ));

const listed = (items: Option.Option<ReadonlyArray<string>>) =>
  Option.liftPredicate(Option.getOrElse(items, () => []).join(", "), (joined) => joined !== "");

const samePersona = (skip: Skip, flow: FlowStatus) =>
  Option.getOrElse(skip.persona, () => "") === Option.getOrElse(optional(flow.persona), () => "");

const newest = Order.flip(Order.mapInput(Order.String, (skip: Skip) => skip.at));

// Each flow of each repo, on ones first, then by repo and name, with the
// latest skip the status keeps for it.
export const flowEntries = (status: DaemonStatus): ReadonlyArray<FlowEntry> =>
  Arr.sort(
    status.repos.flatMap((repo) =>
      repo.flows.map((flow): FlowEntry => ({
        repo,
        flow,
        skip: Arr.head(
          Arr.sort(
            status.skips.filter(
              (skip) =>
                skip.repo === repo.name && skip.flow === flow.name && samePersona(skip, flow),
            ),
            newest,
          ),
        ),
      })),
    ),
    Order.combineAll([
      Order.mapInput(Order.Boolean, (entry: FlowEntry) => !entry.flow.enabled),
      Order.mapInput(Order.String, (entry: FlowEntry) => entry.repo.name),
      Order.mapInput(Order.String, (entry: FlowEntry) => entry.flow.name),
      Order.mapInput(Order.String, (entry: FlowEntry) =>
        Option.getOrElse(optional(entry.flow.persona), () => ""),
      ),
    ]),
  );

// The persona's own schedule: enter sends what the field holds.
const ScheduleField = ({
  act,
  control,
}: {
  readonly act: Act;
  readonly control: ScheduleControl;
}) => (
  <div className="schedule">
    <input
      key={Option.getOrElse(control.own, () => "")}
      type="text"
      className="cron"
      aria-label={control.label}
      defaultValue={Option.getOrElse(control.own, () => "")}
      placeholder={Option.getOrElse(control.team, () => "")}
      spellCheck={false}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          act(control.send(event.currentTarget.value));
        }
      }}
    />
    <div className="muted">
      team <code>{Option.getOrElse(control.team, () => "—")}</code>, own{" "}
      <code>{Option.getOrElse(control.own, () => "—")}</code>
    </div>
  </div>
);

// The schedule the flow runs on, and the field for the persona's own.
const Schedule = ({
  act,
  flow,
  repo,
}: {
  readonly act: Act;
  readonly flow: FlowStatus;
  readonly repo: RepoStatus;
}) => (
  <>
    <code>{flow.schedule}</code>
    {present(scheduleField(repo, flow), (control) => (
      <ScheduleField act={act} control={control} />
    ))}
  </>
);

const offClass = (enabled: boolean) => {
  if (enabled) {
    return "";
  }

  return "off";
};

const LastSkip = ({ now, skip }: { readonly now: number; readonly skip: Option.Option<Skip> }) =>
  present(skip, (said) => (
    <div>
      <span className="muted">skipped:</span> {said.reason}
      {present(said.itemKey, (item) => (
        <> ({item})</>
      ))}{" "}
      <When iso={said.at} now={now} />
    </div>
  ));

const FlowRow = ({
  act,
  entry,
  now,
}: {
  readonly act: Act;
  readonly entry: FlowEntry;
  readonly now: number;
}) => {
  const { flow, repo, skip } = entry;
  const control = flowSwitch(repo, flow);

  return (
    <tr className={offClass(flow.enabled)}>
      <td>
        <input
          type="checkbox"
          role="switch"
          aria-label={control.label}
          checked={control.on}
          onChange={(event) => {
            act(control.send(event.currentTarget.checked));
          }}
        />{" "}
        <strong>{flow.name}</strong>
        {present(optional(flow.source), (source) => (
          <div className="muted">{source}</div>
        ))}
      </td>
      <td>{repo.name}</td>
      <td>
        <Persona persona={optional(flow.persona)} />
      </td>
      <td>
        <Schedule act={act} flow={flow} repo={repo} />
      </td>
      <td>
        <Time iso={flow.next} now={now} />
      </td>
      <td>
        <Time iso={flow.lastTick} now={now} />
        {present(optional(flow.lastCause), (cause) => (
          <div className="muted">{cause}</div>
        ))}
      </td>
      <td>
        <Line label="off" text={optional(flow.offReason)} />
        <Line label="pending" text={optional(flow.pending)} />
        <Line label="queued" text={listed(Option.some(flow.queued))} />
        <Line label="elsewhere" text={listed(optional(flow.assignedElsewhere))} />
        <Line label="waiting" text={listed(optional(flow.waiting))} />
        <LastSkip now={now} skip={Option.filter(skip, () => flow.enabled)} />
      </td>
    </tr>
  );
};

const FlowTable = ({
  act,
  entries,
  now,
}: {
  readonly act: Act;
  readonly entries: ReadonlyArray<FlowEntry>;
  readonly now: number;
}) => (
  <div className="scroll">
    <table className="flows">
      <thead>
        <tr>
          <th>Flow</th>
          <th>Repo</th>
          <th>Persona</th>
          <th>Schedule</th>
          <th>Next</th>
          <th>Last tick</th>
          <th>Work</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <FlowRow
            key={`${entry.repo.name}/${entry.flow.name}@${Option.getOrElse(optional(entry.flow.persona), () => "")}`}
            act={act}
            entry={entry}
            now={now}
          />
        ))}
      </tbody>
    </table>
  </div>
);

export const Flows = ({
  act,
  now,
  status,
}: {
  readonly act: Act;
  readonly now: number;
  // The status, as the filter leaves it.
  readonly status: DaemonStatus;
}) => {
  const entries = flowEntries(status);
  const on = entries.filter((entry) => entry.flow.enabled);
  const off = entries.filter((entry) => !entry.flow.enabled);

  return (
    <section aria-label="Flows">
      {either(
        entries.length === 0,
        () => (
          <p className="muted">No flows.</p>
        ),
        () => (
          <>
            {either(
              off.length === entries.length,
              () => (
                <p className="muted">Every flow is off.</p>
              ),
              () => (
                <FlowTable act={act} entries={on} now={now} />
              ),
            )}
            {either(
              off.length === 0,
              () => (
                <></>
              ),
              () => (
                <details className="off-flows">
                  <summary>
                    {off.length}{" "}
                    {either(
                      off.length === 1,
                      () => "flow is",
                      () => "flows are",
                    )}{" "}
                    off
                  </summary>
                  <FlowTable act={act} entries={off} now={now} />
                </details>
              ),
            )}
          </>
        ),
      )}
    </section>
  );
};

export const FlowPlanSection = (_props: { readonly flow: FlowStatus; readonly repo: string }) => (
  <section />
);
