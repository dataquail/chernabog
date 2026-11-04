// What needs a person, folded into one line at the top that opens to the
// list: holds, markers whose release is pending or failing, runs whose
// stillValid check keeps failing, leases at risk, and notification polls
// that fail. Absent when all is well. Why a tick started nothing is no one's
// to act on, so skips show beside their flows instead (flows.tsx).

import * as Option from "effect/Option";

import type { DaemonStatus } from "#daemon/protocol";

import { either, present } from "./show.tsx";
import { When } from "./time.tsx";

type Kind = "hold" | "marker" | "validity" | "lease" | "notification";

type Concern = {
  readonly kind: Kind;
  readonly key: string;
  readonly what: string;
  readonly why: string;
  readonly at: Option.Option<string>;
};

const LABEL = {
  hold: "held",
  marker: "marker",
  validity: "no longer valid?",
  lease: "lease at risk",
  notification: "notifications",
} satisfies { readonly [K in Kind]: string };

const KINDS: ReadonlyArray<Kind> = ["hold", "marker", "validity", "lease", "notification"];

const as = (persona: Option.Option<string>) =>
  Option.match(persona, { onNone: () => "", onSome: (login) => `@${login}` });

const where = (repo: string, flow: string, persona: Option.Option<string>) =>
  `${repo}/${flow}${as(persona)}`;

// Why a marker needs a person when its release hasn't failed.
const markerWaits = (status: string) => {
  if (status === "unreleasable") {
    return "no flow defines its release";
  }

  return "its release is pending";
};

// Everything in the status that needs a person, in the order the panel lists it.
export const concerns = (status: DaemonStatus): ReadonlyArray<Concern> => [
  ...(status.holds ?? []).map((hold, index): Concern => ({
    kind: "hold",
    key: `hold-${index}`,
    what: `${where(hold.repo, hold.flow, hold.persona)} ${hold.itemKey}`,
    why: hold.reason,
    at: Option.some(hold.at),
  })),
  ...(status.markers ?? []).map((marker, index): Concern => ({
    kind: "marker",
    key: `marker-${index}`,
    what: `${marker.name} on run ${marker.runId} (${marker.status}, ${marker.attempts} attempts)`,
    why: Option.getOrElse(marker.lastError, () => markerWaits(marker.status)),
    at: marker.nextAttemptAt,
  })),
  ...(status.validity ?? []).map((check, index): Concern => ({
    kind: "validity",
    key: `validity-${index}`,
    what: `run ${check.runId}, ${check.failures} failures in a row`,
    why: check.problem,
    at: Option.none(),
  })),
  ...(status.leases ?? []).flatMap((lease, index) =>
    Option.toArray(
      Option.map(lease.atRisk, (why): Concern => ({
        kind: "lease",
        key: `lease-${index}`,
        what: `run ${lease.runId} on ${lease.item}`,
        why,
        at: lease.expiresAt,
      })),
    ),
  ),
  ...(status.notifications ?? []).flatMap((notification, index) =>
    Option.toArray(
      Option.map(notification.problem, (why): Concern => ({
        kind: "notification",
        key: `notification-${index}`,
        what: Option.match(Option.fromUndefinedOr(notification.persona), {
          onNone: () => "the default persona",
          onSome: (login) => `@${login}`,
        }),
        why,
        at: Option.none(),
      })),
    ),
  ),
];

// How many of each kind, as the folded line says it: "2 held, 1 marker".
const tally = (listed: ReadonlyArray<Concern>) =>
  KINDS.flatMap((kind) => {
    const count = listed.filter((concern) => concern.kind === kind).length;

    return Option.toArray(
      Option.map(
        Option.liftPredicate(count, (found) => found > 0),
        (found) => `${found} ${LABEL[kind]}`,
      ),
    );
  }).join(", ");

export const Attention = ({
  now,
  status,
}: {
  readonly now: number;
  readonly status: DaemonStatus;
}) => {
  const listed = concerns(status);

  if (listed.length === 0) {
    return <></>;
  }

  return (
    <details className="attention" aria-label="Attention">
      <summary>
        <strong>
          {listed.length}{" "}
          {either(
            listed.length === 1,
            () => "needs",
            () => "need",
          )}{" "}
          attention
        </strong>{" "}
        <span className="muted">{tally(listed)}</span>
      </summary>
      <ul>
        {listed.map((concern) => (
          <li key={concern.key} data-kind={concern.kind}>
            <span className="tag">{LABEL[concern.kind]}</span> <strong>{concern.what}</strong>:{" "}
            {concern.why}
            {present(concern.at, (iso) => (
              <>
                {" "}
                <When iso={iso} now={now} />
              </>
            ))}
          </li>
        ))}
      </ul>
    </details>
  );
};
