// Times as the overview shows them: how long since or until, with the instant
// itself in the element, for a tooltip and for a reader that wants it.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const twoDigits = (value: number) => String(value).padStart(2, "0");

// A span of time: 42s, 5m 00s, 1h 30m.
export const span = (milliseconds: number) => {
  const total = Math.max(0, milliseconds);

  if (total >= HOUR) {
    return `${Math.floor(total / HOUR)}h ${twoDigits(Math.floor((total % HOUR) / MINUTE))}m`;
  }

  if (total >= MINUTE) {
    return `${Math.floor(total / MINUTE)}m ${twoDigits(Math.floor((total % MINUTE) / SECOND))}s`;
  }

  return `${Math.floor(total / SECOND)}s`;
};

// How long from `iso` to now, or from now until it.
export const relative = (iso: string, now: number) => {
  const at = Date.parse(iso);

  if (at > now) {
    return `in ${span(at - now)}`;
  }

  return `${span(now - at)} ago`;
};

export const When = ({ iso, now }: { readonly iso: string; readonly now: number }) => (
  <time dateTime={iso} title={iso}>
    {relative(iso, now)}
  </time>
);
