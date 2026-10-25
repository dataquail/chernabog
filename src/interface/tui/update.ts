// What each key does: a new model, and the action the app carries out.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";

import { type Persona, samePersona } from "../../kernel/persona.value-object.ts";
import { runLabel } from "../../kernel/run-id.id.ts";
import { cronProblem } from "../../modules/runs/domain/schedule/schedule.value-object.ts";
import {
  flowEnabled,
  type FlowRow,
  flowRows,
  type Model,
  personaAccounts,
  personaFlows,
  personasOf,
  projectsOf,
  type RunEntry,
  runRows,
  type Settings,
  type SettingsRow,
  settingsRows,
} from "./view.ts";

// A key as the terminal gives it: its name, and the text it types, if any.
export type Key = { readonly name: string; readonly ctrl?: boolean; readonly sequence?: string };

export type Action =
  | { readonly kind: "none" }
  | { readonly kind: "quit" }
  | { readonly kind: "refresh" }
  | { readonly kind: "open-log"; readonly run: string }
  | { readonly kind: "attach"; readonly run: string }
  | { readonly kind: "cancel"; readonly run: string; readonly label: string }
  | {
      readonly kind: "trigger";
      readonly repo: string;
      readonly flow: string;
      readonly persona: Option.Option<string>;
    }
  | { readonly kind: "pause"; readonly repo: string; readonly paused: boolean }
  | {
      readonly kind: "toggle-flow";
      readonly repo: string;
      readonly flow: string;
      readonly persona: Option.Option<string>;
      readonly enabled: boolean;
    }
  // A flow's schedule for a persona; none clears the override.
  | {
      readonly kind: "set-schedule";
      readonly repo: string;
      readonly flow: string;
      readonly persona: Option.Option<string>;
      readonly schedule: Option.Option<string>;
    }
  // The account a persona, or one of its roles, spends; none clears the pick.
  | {
      readonly kind: "set-account";
      readonly repo: string;
      readonly persona: Option.Option<string>;
      readonly role: Option.Option<string>;
      readonly account: Option.Option<string>;
    };

export type Updated = { readonly model: Model; readonly action: Action };

const none: Action = { kind: "none" };

const clamp = (value: number, length: number) =>
  Math.max(0, Math.min(value, Math.max(0, length - 1)));

const otherPane = (focus: Model["focus"]): Model["focus"] => {
  if (focus === "flows") {
    return "runs";
  }

  return "flows";
};

// Moves the selection in the focused pane.
const move = (
  model: Model,
  flows: ReadonlyArray<FlowRow>,
  runs: ReadonlyArray<RunEntry>,
  step: number,
): Updated => {
  if (model.focus === "flows") {
    return {
      model: { ...model, flowIndex: clamp(model.flowIndex + step, flows.length) },
      action: none,
    };
  }

  return { model: { ...model, runIndex: clamp(model.runIndex + step, runs.length) }, action: none };
};

const selectedRepoName = (
  model: Model,
  flows: ReadonlyArray<FlowRow>,
  selectedRun: Option.Option<RunEntry>,
) => {
  if (model.focus === "flows") {
    return Option.map(Arr.get(flows, model.flowIndex), (flow) => flow.repo);
  }

  return Option.map(selectedRun, (run) => run.repo);
};

const updateLog = (model: Model, cleared: Model, key: Key): Updated => {
  const page = Math.max(1, model.height - 6);
  const top = Math.max(0, model.logLines.length - 1);

  switch (key.name) {
    case "escape":
    case "backspace":
    case "h":
    case "left":
      return {
        model: { ...cleared, view: "main", logRun: Option.none(), logLines: [], logScroll: 0 },
        action: none,
      };
    case "up":
    case "k":
      return { model: { ...cleared, logScroll: Math.min(model.logScroll + 1, top) }, action: none };
    case "down":
    case "j":
      return { model: { ...cleared, logScroll: Math.max(0, model.logScroll - 1) }, action: none };
    case "pageup":
      return {
        model: { ...cleared, logScroll: Math.min(model.logScroll + page, top) },
        action: none,
      };
    case "pagedown":
      return {
        model: { ...cleared, logScroll: Math.max(0, model.logScroll - page) },
        action: none,
      };
    case "end":
    case "g":
      return { model: { ...cleared, logScroll: 0 }, action: none };
    case "a":
      return Option.match(model.logRun, {
        onNone: () => ({ model, action: none }),
        onSome: (run) => ({ model: cleared, action: { kind: "attach", run } }),
      });
    default:
      return { model, action: none };
  }
};

const flowOfRow = (row: SettingsRow) => {
  if (row.kind === "flow") {
    return Option.some(row.flow);
  }

  return Option.none<string>();
};

const roleOfRow = (row: SettingsRow) => {
  if (row.kind === "role") {
    return Option.some(row.role);
  }

  return Option.none<string>();
};

const withSettings = (model: Model, settings: Settings): Model => ({
  ...model,
  settings: Option.some(settings),
});

const toggleOf = (model: Model, settings: Settings, flow: string): Action =>
  Option.match(
    Arr.findFirst(personaFlows(model, settings), (found) => found.name === flow),
    {
      onNone: () => none,
      onSome: (found) => ({
        kind: "toggle-flow",
        repo: settings.repo,
        flow,
        persona: settings.persona,
        enabled: !flowEnabled(model, settings.repo, found),
      }),
    },
  );

// Typing a flow's schedule: the cron is checked before it's saved.
const updateCron = (
  model: Model,
  settings: Settings,
  editing: { readonly flow: string; readonly text: string },
  key: Key,
): Updated => {
  const browse = withSettings(model, { ...settings, editing: { kind: "browse" } });

  switch (key.name) {
    case "escape":
      return { model: browse, action: none };
    case "return":
    case "enter": {
      const cron = editing.text.trim();

      if (cron.length === 0) {
        return {
          model: {
            ...model,
            message: Option.some(
              "type a schedule; c in the list clears the override, back to the team's",
            ),
          },
          action: none,
        };
      }

      return Option.match(cronProblem(cron), {
        onSome: (reason) => ({ model: { ...model, message: Option.some(reason) }, action: none }),
        onNone: () => ({
          model: browse,
          action: {
            kind: "set-schedule",
            repo: settings.repo,
            flow: editing.flow,
            persona: settings.persona,
            schedule: Option.some(cron),
          },
        }),
      });
    }

    case "backspace":
      return {
        model: withSettings(model, {
          ...settings,
          editing: { kind: "cron", flow: editing.flow, text: editing.text.slice(0, -1) },
        }),
        action: none,
      };
    default: {
      const typed = Option.filter(
        Option.fromUndefinedOr(key.sequence),
        (text) => text.length === 1 && text >= " ",
      );

      return {
        model: withSettings(model, {
          ...settings,
          editing: {
            kind: "cron",
            flow: editing.flow,
            text: `${editing.text}${Option.getOrElse(typed, () => "")}`,
          },
        }),
        action: none,
      };
    }
  }
};

// Choosing an account from a list.
const updatePick = (
  model: Model,
  settings: Settings,
  editing: {
    readonly role: Option.Option<string>;
    readonly choices: ReadonlyArray<string>;
    readonly index: number;
  },
  key: Key,
): Updated => {
  const browse = withSettings(model, { ...settings, editing: { kind: "browse" } });

  const moved = (step: number) =>
    withSettings(model, {
      ...settings,
      editing: {
        kind: "pick",
        ...editing,
        index: clamp(editing.index + step, editing.choices.length),
      },
    });

  switch (key.name) {
    case "escape":
      return { model: browse, action: none };
    case "up":
    case "k":
      return { model: moved(-1), action: none };
    case "down":
    case "j":
      return { model: moved(1), action: none };
    case "return":
    case "enter":
      return {
        model: browse,
        action: {
          kind: "set-account",
          repo: settings.repo,
          persona: settings.persona,
          role: editing.role,
          account: Arr.get(editing.choices, editing.index),
        },
      };
    default:
      return { model, action: none };
  }
};

const accountNames = (model: Model) =>
  Option.match(model.status, {
    onNone: () => [],
    onSome: (status) => (status.accounts ?? []).map((account) => account.name),
  });

// What c clears on a row: a flow's schedule, the persona's account, or a role's.
const clearOf = (model: Model, settings: Settings, row: SettingsRow): Option.Option<Action> => {
  const accounts = personaAccounts(model, settings);

  if (row.kind === "flow") {
    const own = Option.flatMap(
      Arr.findFirst(personaFlows(model, settings), (flow) => flow.name === row.flow),
      (flow) => Option.fromUndefinedOr(flow.ownSchedule),
    );

    return Option.as(own, {
      kind: "set-schedule",
      repo: settings.repo,
      flow: row.flow,
      persona: settings.persona,
      schedule: Option.none(),
    });
  }

  if (row.kind === "account") {
    return Option.as(
      Option.flatMap(accounts, (found) => found.ownAccount),
      {
        kind: "set-account",
        repo: settings.repo,
        persona: settings.persona,
        role: Option.none(),
        account: Option.none(),
      },
    );
  }

  const own = Option.flatMap(
    Option.flatMap(accounts, (found) =>
      Arr.findFirst(found.roles, (role) => role.role === row.role),
    ),
    (role) => role.account,
  );

  return Option.as(own, {
    kind: "set-account",
    repo: settings.repo,
    persona: settings.persona,
    role: Option.some(row.role),
    account: Option.none(),
  });
};

// A persona's settings for a repo: its flows, their schedules, its accounts.
const updateSettings = (model: Model, settings: Settings, key: Key): Updated => {
  const { editing } = settings;

  if (editing.kind === "cron") {
    return updateCron(model, settings, editing, key);
  }

  if (editing.kind === "pick") {
    return updatePick(model, settings, editing, key);
  }

  const rows = settingsRows(model, settings);
  const row = Arr.get(rows, settings.index);
  const cleared: Model = { ...model, message: Option.none() };

  const stay = (message: string): Updated => ({
    model: { ...cleared, message: Option.some(message) },
    action: none,
  });

  switch (key.name) {
    case "escape":
    case "backspace":
    case "h":
    case "left":
      return { model: { ...cleared, view: "main", settings: Option.none() }, action: none };
    case "up":
    case "k":
      return {
        model: withSettings(cleared, {
          ...settings,
          index: clamp(settings.index - 1, rows.length),
        }),
        action: none,
      };
    case "down":
    case "j":
      return {
        model: withSettings(cleared, {
          ...settings,
          index: clamp(settings.index + 1, rows.length),
        }),
        action: none,
      };
    case "e":
    case "space":
      return Option.match(Option.flatMap(row, flowOfRow), {
        onNone: () => stay("select a flow to turn on or off"),
        onSome: (flow) => ({ model: cleared, action: toggleOf(model, settings, flow) }),
      });
    case "s":
      return Option.match(Option.flatMap(row, flowOfRow), {
        onNone: () => stay("select a flow to give it a schedule"),
        onSome: (name) => {
          const flow = Arr.findFirst(personaFlows(model, settings), (found) => found.name === name);

          if (Option.exists(flow, (found) => found.manual === true)) {
            return stay(`${name} is a manual flow; it has no schedule to set`);
          }

          const own = Option.flatMap(flow, (found) => Option.fromUndefinedOr(found.ownSchedule));

          return {
            model: withSettings(cleared, {
              ...settings,
              editing: { kind: "cron", flow: name, text: Option.getOrElse(own, () => "") },
            }),
            action: none,
          };
        },
      });

    case "return":
    case "enter": {
      const role = Option.flatMap(row, roleOfRow);
      const choices = accountNames(model);

      if (!Option.exists(row, (found) => found.kind !== "flow")) {
        return stay("select the account, or a role, to choose its account");
      }

      if (choices.length === 0) {
        return stay("machine config has no accounts to choose from; add them with chernabog setup");
      }

      return {
        model: withSettings(cleared, {
          ...settings,
          editing: { kind: "pick", role, choices, index: 0 },
        }),
        action: none,
      };
    }

    case "c":
      return Option.match(
        Option.flatMap(row, (found) => clearOf(model, settings, found)),
        {
          onNone: () => stay("nothing of yours to clear here; it's the default already"),
          onSome: (action) => ({ model: cleared, action }),
        },
      );
    default:
      return { model, action: none };
  }
};

// On a flow: its persona's settings for the repo, with that flow selected. On a run: its log.
const openSelected = (
  model: Model,
  cleared: Model,
  flow: Option.Option<FlowRow>,
  selectedRun: Option.Option<RunEntry>,
): Updated => {
  if (Option.isSome(flow)) {
    const opened: Settings = {
      repo: flow.value.repo,
      persona: flow.value.persona,
      index: 0,
      editing: { kind: "browse" },
    };

    const index = Math.max(
      0,
      settingsRows(model, opened).findIndex(
        (row) => row.kind === "flow" && row.flow === flow.value.flow,
      ),
    );

    return {
      model: { ...cleared, view: "settings", settings: Option.some({ ...opened, index }) },
      action: none,
    };
  }

  return Option.match(selectedRun, {
    onNone: () => ({
      model: { ...cleared, message: Option.some("select a flow or a run first") },
      action: none,
    }),
    onSome: (run) => ({
      model: { ...cleared, view: "log", logRun: Option.some(run.id), logLines: [], logScroll: 0 },
      action: { kind: "open-log", run: run.id },
    }),
  });
};

// Attaches to the selected run (a), or asks to cancel it (x), which waits on
// the person's y.
const onSelectedRun = (
  cleared: Model,
  selectedRun: Option.Option<RunEntry>,
  key: string,
): Updated =>
  Option.match(selectedRun, {
    onNone: () => {
      let doing = "cancel";

      if (key === "a") {
        doing = "attach to";
      }

      return {
        model: { ...cleared, message: Option.some(`select a run to ${doing} (tab to the runs)`) },
        action: none,
      };
    },
    onSome: (run): Updated => {
      if (key === "a") {
        return { model: cleared, action: { kind: "attach", run: run.id } };
      }

      return {
        model: {
          ...cleared,
          cancelling: Option.some(run),
          message: Option.some(
            `cancel ${runLabel(run)}? It stops for good, and its worktrees and claim are released. y to cancel, any other key to keep it`,
          ),
        },
        action: none,
      };
    },
  });

// y cancels the run asked about; any other key keeps it.
const confirmCancel = (cleared: Model, run: RunEntry, key: Key): Updated => {
  const asked = { ...cleared, cancelling: Option.none<RunEntry>() };

  if (key.name === "y") {
    return { model: asked, action: { kind: "cancel", run: run.id, label: runLabel(run) } };
  }

  return {
    model: { ...asked, message: Option.some(`left ${runLabel(run)} running`) },
    action: none,
  };
};

// The filters as they'd be with `project` and `persona`; the selections go
// back to the top of what's now shown.
const filteredTo = (
  model: Model,
  project: Option.Option<string>,
  personaFilter: Option.Option<Persona>,
): Model => ({ ...model, project, personaFilter, flowIndex: 0, runIndex: 0 });

// The next choice after `current` in `choices`, all (none) between the last and the first.
const cycle = <A>(
  choices: ReadonlyArray<A>,
  current: Option.Option<A>,
  same: (left: A, right: A) => boolean,
  step: number,
): Option.Option<A> => {
  const at = Option.match(current, {
    onNone: () => -1,
    onSome: (chosen) => choices.findIndex((choice) => same(choice, chosen)),
  });

  const count = choices.length + 1;
  const next = (((at + 1 + step) % count) + count) % count;

  return Arr.get(choices, next - 1);
};

const typed = (key: Key) => Option.getOrElse(Option.fromUndefinedOr(key.sequence), () => key.name);

// 1-9 picks a project tab, 0 All, [ and ] cycle them, and @ cycles the
// persona filter. Each does nothing when there's no choice to make.
const filterKey = (model: Model, key: Key): Option.Option<Model> => {
  const projects = projectsOf(model.status);
  const personas = personasOf(model.status);
  const text = typed(key);
  const same = (left: string, right: string) => left === right;

  if (text === "@" && personas.length > 1) {
    return Option.some(
      filteredTo(model, model.project, cycle(personas, model.personaFilter, samePersona, 1)),
    );
  }

  if (projects.length < 2) {
    return Option.none();
  }

  if (text === "[" || text === "]") {
    let step = -1;

    if (text === "]") {
      step = 1;
    }

    return Option.some(
      filteredTo(model, cycle(projects, model.project, same, step), model.personaFilter),
    );
  }

  const tab = Number(text);

  if (/^[0-9]$/.test(text) && tab <= projects.length) {
    return Option.some(filteredTo(model, Arr.get(projects, tab - 1), model.personaFilter));
  }

  return Option.none();
};

const updateMain = (model: Model, key: Key): Updated => {
  const flows = flowRows(model);
  const runs = runRows(model);

  const selectedRun = Arr.get(runs, model.runIndex).pipe(
    Option.filter(() => model.focus === "runs"),
  );

  const cleared: Model = { ...model, message: Option.none() };

  if (key.name === "c" && key.ctrl === true) {
    return { model, action: { kind: "quit" } };
  }

  const settings = Option.filter(model.settings, () => model.view === "settings");

  // Typing a schedule, q and r are letters like any other.
  if (Option.exists(settings, (found) => found.editing.kind === "cron")) {
    return Option.match(settings, {
      onNone: () => ({ model, action: none }),
      onSome: (found) => updateSettings(model, found, key),
    });
  }

  if (key.name === "q") {
    return { model, action: { kind: "quit" } };
  }

  if (key.name === "r") {
    return { model: cleared, action: { kind: "refresh" } };
  }

  if (model.view === "log") {
    return updateLog(model, cleared, key);
  }

  if (Option.isSome(settings)) {
    return updateSettings(model, settings.value, key);
  }

  switch (key.name) {
    case "tab":
      return { model: { ...cleared, focus: otherPane(model.focus) }, action: none };
    case "up":
    case "k":
      return move(cleared, flows, runs, -1);
    case "down":
    case "j":
      return move(cleared, flows, runs, 1);
    case "return":
    case "enter":
    case "l":
    case "right":
      return openSelected(
        model,
        cleared,
        Arr.get(flows, model.flowIndex).pipe(Option.filter(() => model.focus === "flows")),
        selectedRun,
      );

    case "a":
      return onSelectedRun(cleared, selectedRun, key.name);
    case "t":
      return Option.match(
        Arr.get(flows, model.flowIndex).pipe(Option.filter(() => model.focus === "flows")),
        {
          onNone: () => ({
            model: {
              ...cleared,
              message: Option.some("select a flow to trigger (tab to the flows)"),
            },
            action: none,
          }),
          onSome: (flow) => ({
            model: cleared,
            action: { kind: "trigger", repo: flow.repo, flow: flow.flow, persona: flow.persona },
          }),
        },
      );
    case "e": {
      const flow = Arr.get(flows, model.flowIndex).pipe(
        Option.filter(() => model.focus === "flows"),
      );

      const status = Option.flatMap(flow, (row) =>
        Option.flatMap(model.status, (found) =>
          Arr.findFirst(found.repos, (repo) => repo.name === row.repo),
        ).pipe(
          Option.flatMap((repo) =>
            Arr.findFirst(
              repo.flows,
              (candidate) =>
                candidate.name === row.flow &&
                samePersona(Option.fromUndefinedOr(candidate.persona), row.persona),
            ),
          ),
        ),
      );

      return Option.match(Option.all([flow, status]), {
        onNone: () => ({
          model: {
            ...cleared,
            message: Option.some("select a flow to turn on or off (tab to the flows)"),
          },
          action: none,
        }),
        onSome: ([row, found]) => ({
          model: cleared,
          action: {
            kind: "toggle-flow",
            repo: row.repo,
            flow: row.flow,
            persona: row.persona,
            enabled: !flowEnabled(model, row.repo, found),
          },
        }),
      });
    }

    case "p": {
      const name = selectedRepoName(model, flows, Arr.get(runs, model.runIndex));

      const repo = Option.flatMap(model.status, (status) =>
        Arr.findFirst(status.repos, (candidate) => Option.contains(name, candidate.name)),
      );

      return Option.match(repo, {
        onNone: () => ({ model, action: none }),
        onSome: (found) => ({
          model: cleared,
          action: { kind: "pause", repo: found.name, paused: !found.paused },
        }),
      });
    }

    default:
      return Option.match(filterKey(cleared, key), {
        onSome: (filtered) => ({ model: filtered, action: none }),
        // x asks to cancel the selected run.
        onNone: () =>
          Option.match(
            Option.liftPredicate(key.name, (name) => name === "x"),
            {
              onNone: () => ({ model, action: none }),
              onSome: (name) => onSelectedRun(cleared, selectedRun, name),
            },
          ),
      });
  }
};

// While a cancel is asked, y cancels the run and any other key keeps it.
export const update = (model: Model, key: Key): Updated =>
  Option.match(model.cancelling, {
    onNone: () => updateMain(model, key),
    onSome: (run) => confirmCancel({ ...model, message: Option.none() }, run, key),
  });
