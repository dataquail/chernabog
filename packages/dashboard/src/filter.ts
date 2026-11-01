// Which repos and personas the overview shows. A filter keeps a repo's flows
// and runs, and the attention that names it; a persona's flows, its runs and
// the repos they are in. Markers, validity and leases name a run, and are
// kept while their run is.

import * as Option from "effect/Option";

import type { DaemonStatus } from "#daemon/protocol";

export type Filter = {
  readonly repo: Option.Option<string>;
  readonly persona: Option.Option<string>;
};

export const everything: Filter = { repo: Option.none(), persona: Option.none() };

const passes = (wanted: Option.Option<string>, value: Option.Option<string>) =>
  Option.match(wanted, {
    onNone: () => true,
    onSome: (name) => Option.contains(value, name),
  });

export const filtered = (status: DaemonStatus, filter: Filter): DaemonStatus => {
  const named = (repo: string, persona: Option.Option<string>) =>
    passes(filter.repo, Option.some(repo)) && passes(filter.persona, persona);

  const repos = status.repos.flatMap((repo) => {
    if (!passes(filter.repo, Option.some(repo.name))) {
      return [];
    }

    if (Option.isNone(filter.persona)) {
      return [repo];
    }

    const flows = repo.flows.filter((flow) =>
      passes(filter.persona, Option.fromUndefinedOr(flow.persona)),
    );

    if (flows.length === 0) {
      return [];
    }

    return [{ ...repo, flows }];
  });

  const active = status.active.filter((run) => named(run.repo, run.persona));
  const recent = status.recent.filter((run) => named(run.repo, run.persona));

  const unfiltered = Option.isNone(filter.repo) && Option.isNone(filter.persona);
  const runs = new Set<string>([...active, ...recent].map((run) => run.id));
  const shownRun = (runId: string) => unfiltered || runs.has(runId);

  return {
    ...status,
    repos,
    active,
    recent,
    skips: status.skips.filter((skip) => named(skip.repo, skip.persona)),
    holds: status.holds?.filter((hold) => named(hold.repo, hold.persona)),
    notifications: status.notifications?.filter(
      (notification) =>
        Option.isNone(filter.repo) &&
        passes(filter.persona, Option.fromUndefinedOr(notification.persona)),
    ),
    validity: status.validity?.filter((check) => shownRun(check.runId)),
    leases: status.leases?.filter((lease) => shownRun(lease.runId)),
    markers: status.markers?.filter((marker) => shownRun(marker.runId)),
  };
};

const sorted = (names: Iterable<string>) => [...new Set(names)].toSorted();

export const repoChoices = (status: DaemonStatus): ReadonlyArray<string> =>
  sorted(status.repos.map((repo) => repo.name));

// Each persona a flow, a repo or a run names; the implicit one has no name.
export const personaChoices = (status: DaemonStatus): ReadonlyArray<string> =>
  sorted([
    ...status.repos.flatMap((repo) => [
      ...repo.flows.flatMap((flow) => Option.toArray(Option.fromUndefinedOr(flow.persona))),
      ...(repo.personas ?? []).flatMap((persona) =>
        Option.toArray(Option.fromUndefinedOr(persona.persona)),
      ),
    ]),
    ...[...status.active, ...status.recent].flatMap((run) => Option.toArray(run.persona)),
  ]);
