// Each enrolled repo: its status, whether it's paused, where its sessions run
// and the personas it runs as; under it, its flows. Each carries the controls
// that change it (controls.ts), for the persona it belongs to; what one asks
// for goes to `act`.

import * as Option from "effect/Option";

import type { PersonaStatus, RepoStatus } from "#daemon/protocol";

import {
  type AccountControl,
  accountPickers,
  flowSwitch,
  pauseControl,
  type ScheduleControl,
  scheduleField,
} from "./controls.ts";
import { RunNow } from "./run-actions.tsx";
import type { Attempt, Offered } from "./settings.ts";
import { either, present, shownIf } from "./show.tsx";
import { When } from "./time.tsx";

type FlowStatus = RepoStatus["flows"][number];

const optional = Option.fromUndefinedOr;

// Where a control's attempt goes.
export type Act = (attempt: Attempt) => void;

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

const FlowRow = ({
  act,
  flow,
  now,
  repo,
}: {
  readonly act: Act;
  readonly flow: FlowStatus;
  readonly now: number;
  readonly repo: RepoStatus;
}) => {
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
        <strong>{flow.name}</strong> <Persona persona={optional(flow.persona)} />
        {present(optional(flow.source), (source) => (
          <div className="muted">{source}</div>
        ))}
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
      </td>
    </tr>
  );
};

// A picker of the accounts machine config offers, the default first.
const AccountPicker = ({
  act,
  control,
  offered,
}: {
  readonly act: Act;
  readonly control: AccountControl;
  readonly offered: Offered;
}) => (
  <select
    aria-label={control.label}
    value={Option.getOrElse(control.current, () => "")}
    onChange={(event) => {
      act(control.send(event.currentTarget.value));
    }}
  >
    <option value="">default</option>
    {offered.accounts.map((account) => (
      <option key={account.name} value={account.name}>
        {account.name} ({account.agent})
      </option>
    ))}
  </select>
);

const PersonaAccounts = ({
  act,
  offered,
  persona,
  repo,
}: {
  readonly act: Act;
  readonly offered: Offered;
  readonly persona: PersonaStatus;
  readonly repo: RepoStatus;
}) => (
  <div className="persona">
    <Persona persona={optional(persona.persona)} /> spends {persona.account}
    {accountPickers(repo, persona, offered).map((control) => (
      <label key={control.label} className="role">
        {" "}
        {Option.getOrElse(control.role, () => "account")}{" "}
        <AccountPicker act={act} control={control} offered={offered} />
      </label>
    ))}
  </div>
);

const Personas = ({
  act,
  offered,
  repo,
}: {
  readonly act: Act;
  readonly offered: Offered;
  readonly repo: RepoStatus;
}) => {
  const personas = Option.getOrElse(optional(repo.personas), () => []);

  return either(
    personas.length === 0,
    () => "—",
    () =>
      personas.map((persona) => (
        <PersonaAccounts
          key={Option.getOrElse(optional(persona.persona), () => "")}
          act={act}
          offered={offered}
          persona={persona}
          repo={repo}
        />
      )),
  );
};

const Flows = ({
  act,
  now,
  repo,
}: {
  readonly act: Act;
  readonly now: number;
  readonly repo: RepoStatus;
}) =>
  either(
    repo.flows.length === 0,
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
            {repo.flows.map((flow) => (
              <FlowRow
                key={`${flow.name}@${Option.getOrElse(optional(flow.persona), () => "")}`}
                act={act}
                flow={flow}
                now={now}
                repo={repo}
              />
            ))}
          </tbody>
        </table>
      </div>
    ),
  );

const PauseButton = ({ act, repo }: { readonly act: Act; readonly repo: RepoStatus }) => {
  const control = pauseControl(repo);

  return (
    <button
      type="button"
      aria-label={control.label}
      onClick={() => {
        act(control.send());
      }}
    >
      {control.text}
    </button>
  );
};

const Repo = ({
  act,
  now,
  offered,
  repo,
}: {
  readonly act: Act;
  readonly now: number;
  readonly offered: Offered;
  readonly repo: RepoStatus;
}) => (
  <article className="repo" aria-label={repo.slug}>
    <h3>
      {repo.name} <span className="muted">{repo.slug}</span>{" "}
      <span className={`badge ${repo.status}`}>{repo.status}</span>
      {shownIf(repo.paused, () => (
        <span className="badge paused">paused</span>
      ))}
      {shownIf(!repo.enabled, () => (
        <span className="badge off">disabled</span>
      ))}{" "}
      <PauseButton act={act} repo={repo} />
    </h3>
    {present(repo.message, (message) => (
      <p className="muted">{message}</p>
    ))}
    <dl className="facts">
      <dt>launcher</dt>
      <dd>{Option.getOrElse(repo.launcher, () => "—")}</dd>
      <dt>personas</dt>
      <dd>
        <Personas act={act} offered={offered} repo={repo} />
      </dd>
    </dl>
    <Flows act={act} now={now} repo={repo} />
    <RunNow repo={repo} />
  </article>
);

export const Repos = ({
  act,
  enrolled,
  now,
  offered,
  repos,
}: {
  readonly act: Act;
  // Whether any repo is enrolled, before the filter.
  readonly enrolled: boolean;
  readonly now: number;
  // What machine config offers a persona's account pick.
  readonly offered: Offered;
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
      () =>
        repos.map((repo) => (
          <Repo key={repo.name} act={act} offered={offered} repo={repo} now={now} />
        )),
    )}
  </section>
);
