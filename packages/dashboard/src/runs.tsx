// The runs in flight and the ones that ended lately, each linking to its
// detail. The keyboard's selection runs through both, active ones first.

import * as Option from "effect/Option";

import type { DaemonStatus } from "#daemon/protocol";

import { RunActions } from "./run-actions.tsx";
import { either, present } from "./show.tsx";
import { span, When } from "./time.tsx";

type Run = DaemonStatus["active"][number] | DaemonStatus["recent"][number];

export const runHref = (runId: string) => `#/runs/${encodeURIComponent(runId)}`;

const Item = ({ run }: { readonly run: Run }) => (
  <>
    <a href={runHref(run.id)}>{run.itemKey}</a>
    {present(run.itemTitle, (title) => (
      <div className="muted">{title}</div>
    ))}
  </>
);

const persona = (run: Run) =>
  Option.match(run.persona, { onNone: () => "default", onSome: (login) => `@${login}` });

// What an active run is doing: its step, or that it's parked on a signal.
const doing = (run: DaemonStatus["active"][number]) => {
  if (run.parked) {
    return "parked";
  }

  return Option.getOrElse(run.currentStep, () => "starting");
};

// Whether the repo a run is in can open its sessions in their launcher.
const opens = (status: DaemonStatus, repo: string) =>
  status.repos.some((each) => each.name === repo && each.opensSessions === true);

export const Runs = ({
  now,
  selected,
  status,
}: {
  readonly now: number;
  readonly selected: Option.Option<number>;
  readonly status: DaemonStatus;
}) => {
  const isSelected = (index: number) => Option.contains(selected, index);

  return (
    <section aria-label="Runs">
      <h2>Active runs</h2>
      {either(
        status.active.length === 0,
        () => (
          <p className="muted">No runs in flight.</p>
        ),
        () => (
          <div className="scroll">
            <table className="runs">
              <thead>
                <tr>
                  <th>Repo</th>
                  <th>Flow</th>
                  <th>Persona</th>
                  <th>Item</th>
                  <th>Step</th>
                  <th>Running for</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {status.active.map((run, index) => (
                  <tr key={run.id} aria-selected={isSelected(index)}>
                    <td>{run.repo}</td>
                    <td>{run.flow}</td>
                    <td>{persona(run)}</td>
                    <td>
                      <Item run={run} />
                    </td>
                    <td>{doing(run)}</td>
                    <td>{span(now - Date.parse(run.startedAt))}</td>
                    <td>
                      <RunActions run={run} opens={opens(status, run.repo)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ),
      )}
      <h2>Recent runs</h2>
      {either(
        status.recent.length === 0,
        () => (
          <p className="muted">No runs have ended lately.</p>
        ),
        () => (
          <div className="scroll">
            <table className="runs">
              <thead>
                <tr>
                  <th>Repo</th>
                  <th>Flow</th>
                  <th>Persona</th>
                  <th>Item</th>
                  <th>Outcome</th>
                  <th>Summary</th>
                  <th>Ended</th>
                </tr>
              </thead>
              <tbody>
                {status.recent.map((run, index) => (
                  <tr key={run.id} aria-selected={isSelected(status.active.length + index)}>
                    <td>{run.repo}</td>
                    <td>{run.flow}</td>
                    <td>{persona(run)}</td>
                    <td>
                      <Item run={run} />
                    </td>
                    <td>
                      <span className={`badge ${run.status}`}>{run.status}</span>
                    </td>
                    <td>{Option.getOrElse(run.summary, () => "")}</td>
                    <td>
                      {present(run.finishedAt, (iso) => (
                        <When iso={iso} now={now} />
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ),
      )}
    </section>
  );
};
