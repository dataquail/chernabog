// Each enrolled repo: its status, whether it's paused, where its sessions run
// and the personas it runs as; under it, its flows.

import * as Option from "effect/Option";

import type { RepoStatus } from "#daemon/protocol";

import { either, present, shownIf } from "./show.tsx";
import { When } from "./time.tsx";

type FlowStatus = RepoStatus["flows"][number];

const optional = Option.fromUndefinedOr;

const Persona = ({ persona }: { readonly persona: Option.Option<string> }) =>
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

const Schedule = ({ flow }: { readonly flow: FlowStatus }) => {
  const team = optional(flow.teamSchedule);
  const own = optional(flow.ownSchedule);

  return (
    <>
      <code>{flow.schedule}</code>
      {shownIf(Option.isSome(team) || Option.isSome(own), () => (
        <div className="muted">
          team <code>{Option.getOrElse(team, () => "—")}</code>, own{" "}
          <code>{Option.getOrElse(own, () => "—")}</code>
        </div>
      ))}
    </>
  );
};

const offClass = (enabled: boolean) => {
  if (enabled) {
    return "";
  }

  return "off";
};

const FlowRow = ({ flow, now }: { readonly flow: FlowStatus; readonly now: number }) => (
  <tr className={offClass(flow.enabled)}>
    <td>
      <strong>{flow.name}</strong> <Persona persona={optional(flow.persona)} />
      {present(optional(flow.source), (source) => (
        <div className="muted">{source}</div>
      ))}
    </td>
    <td>
      <Schedule flow={flow} />
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
    </td>
  </tr>
);

const Personas = ({ repo }: { readonly repo: RepoStatus }) => {
  const personas = Option.getOrElse(optional(repo.personas), () => []);

  return either(
    personas.length === 0,
    () => "—",
    () =>
      personas.map((persona) => (
        <span key={Option.getOrElse(optional(persona.persona), () => "")} className="persona">
          <Persona persona={optional(persona.persona)} /> ({persona.account})
        </span>
      )),
  );
};

const Flows = ({ flows, now }: { readonly flows: RepoStatus["flows"]; readonly now: number }) =>
  either(
    flows.length === 0,
    () => <p className="muted">No flows.</p>,
    () => (
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Flow</th>
              <th>Schedule</th>
              <th>Next</th>
              <th>Last tick</th>
              <th>Work</th>
            </tr>
          </thead>
          <tbody>
            {flows.map((flow) => (
              <FlowRow
                key={`${flow.name}@${Option.getOrElse(optional(flow.persona), () => "")}`}
                flow={flow}
                now={now}
              />
            ))}
          </tbody>
        </table>
      </div>
    ),
  );

const Repo = ({ now, repo }: { readonly now: number; readonly repo: RepoStatus }) => (
  <article className="repo" aria-label={repo.slug}>
    <h3>
      {repo.name} <span className="muted">{repo.slug}</span>{" "}
      <span className={`badge ${repo.status}`}>{repo.status}</span>
      {shownIf(repo.paused, () => (
        <span className="badge paused">paused</span>
      ))}
      {shownIf(!repo.enabled, () => (
        <span className="badge off">disabled</span>
      ))}
    </h3>
    {present(repo.message, (message) => (
      <p className="muted">{message}</p>
    ))}
    <dl className="facts">
      <dt>launcher</dt>
      <dd>{Option.getOrElse(repo.launcher, () => "—")}</dd>
      <dt>personas</dt>
      <dd>
        <Personas repo={repo} />
      </dd>
    </dl>
    <Flows flows={repo.flows} now={now} />
  </article>
);

export const Repos = ({
  enrolled,
  now,
  repos,
}: {
  // Whether any repo is enrolled, before the filter.
  readonly enrolled: boolean;
  readonly now: number;
  readonly repos: ReadonlyArray<RepoStatus>;
}) => (
  <section aria-label="Repos">
    <h2>Repos</h2>
    {either(
      repos.length === 0,
      () => (
        <p className="muted">
          {either(
            enrolled,
            () => "No repos match the filter.",
            () => "No repos are enrolled.",
          )}
        </p>
      ),
      () => repos.map((repo) => <Repo key={repo.name} repo={repo} now={now} />),
    )}
  </section>
);
