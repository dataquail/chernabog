// Each enrolled repo's own settings: its status, whether it's paused, where
// its sessions run, the accounts its personas spend, and starting one of its
// flows now. Its flows are the flows tab's (flows.tsx). Each carries the
// controls that change it (controls.ts), for the persona it belongs to; what
// one asks for goes to `act`.

import * as Option from "effect/Option";

import type { PersonaStatus, RepoStatus } from "#daemon/protocol";

import { type AccountControl, accountPickers, pauseControl } from "./controls.ts";
import { type Act, Persona } from "./flows.tsx";
import { RunNow } from "./run-actions.tsx";
import type { Offered } from "./settings.ts";
import { either, present, shownIf } from "./show.tsx";

export type { Act } from "./flows.tsx";

const optional = Option.fromUndefinedOr;

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
  offered,
  repo,
}: {
  readonly act: Act;
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
    <p className="muted">
      {repo.flows.filter((flow) => flow.enabled).length} of {repo.flows.length} flows on;{" "}
      <a href="#/flows">see them</a>
    </p>
    <RunNow repo={repo} />
  </article>
);

export const Repos = ({
  act,
  enrolled,
  offered,
  repos,
}: {
  readonly act: Act;
  // Whether any repo is enrolled, before the filter.
  readonly enrolled: boolean;
  // What machine config offers a persona's account pick.
  readonly offered: Offered;
  readonly repos: ReadonlyArray<RepoStatus>;
}) => (
  <section aria-label="Repos">
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
      () => repos.map((repo) => <Repo key={repo.name} act={act} offered={offered} repo={repo} />),
    )}
  </section>
);
