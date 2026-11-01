// Which daemon this is: its pid, when it started, how many repos it serves,
// how many runs hold a slot, and whether it is about to restart.

import type { DaemonStatus } from "#daemon/protocol";

// What the daemon is doing about restarting, if anything.
const restarting = (status: DaemonStatus) => {
  if (status.draining === true) {
    return ["draining: starting no new runs, to restart on an upgraded chernabog"];
  }

  if (status.reloadPending) {
    return ["reload pending: restarts once nothing is executing"];
  }

  return [];
};

export const DaemonStatusView = ({ status }: { readonly status: DaemonStatus }) => (
  <dl className="daemon">
    <dt>pid</dt>
    <dd>{status.pid}</dd>
    <dt>started</dt>
    <dd>
      <time dateTime={status.startedAt}>{status.startedAt}</time>
    </dd>
    <dt>repos</dt>
    <dd>{status.repos.length}</dd>
    <dt>busy</dt>
    <dd>{status.busy}</dd>
    {restarting(status).map((says) => (
      <div key="restarting" className="restarting">
        <dt>state</dt>
        <dd>{says}</dd>
      </div>
    ))}
  </dl>
);
