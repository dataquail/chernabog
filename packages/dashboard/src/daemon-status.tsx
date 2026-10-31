// Which daemon this is: its pid, when it started and how many repos it serves.

import { type DaemonStatus } from "#daemon/protocol";

export const DaemonStatusView = ({ status }: { readonly status: DaemonStatus }) => (
  <dl>
    <dt>pid</dt>
    <dd>{status.pid}</dd>
    <dt>started</dt>
    <dd>
      <time dateTime={status.startedAt}>{status.startedAt}</time>
    </dd>
    <dt>repos</dt>
    <dd>{status.repos.length}</dd>
  </dl>
);
