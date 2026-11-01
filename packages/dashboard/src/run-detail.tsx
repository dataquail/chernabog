// One run's detail, which #328 builds; until then, a placeholder that says so.

import type * as Option from "effect/Option";

import type { Detail } from "./run.ts";
import type { LogState } from "./run-log.ts";

export const RunDetailView = (_props: {
  readonly asked: string;
  readonly detail: Detail;
  readonly log: LogState;
  readonly now: number;
  readonly slug: Option.Option<string>;
}) => <></>;

export const RunDetail = ({ runId }: { readonly runId: string }) => (
  <div className="page">
    <header>
      <h1>Chernabog</h1>
    </header>
    <main>
      <h2>
        Run <code>{runId}</code>
      </h2>
      <p className="muted">A run's detail isn't here yet: it arrives with #328.</p>
      <p>
        <a href="#/">Back to the overview</a>
      </p>
    </main>
  </div>
);
