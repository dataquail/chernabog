// What the page renders for what may be absent: the value's rendering, or
// nothing.

import * as Option from "effect/Option";
import type { ReactNode } from "react";

export const present = <A,>(value: Option.Option<A>, render: (a: A) => ReactNode): ReactNode =>
  Option.match(value, { onNone: () => <></>, onSome: render });

// `render`'s result when `condition` holds, else nothing.
export const shownIf = (condition: boolean, render: () => ReactNode): ReactNode =>
  present(Option.liftPredicate(condition, Boolean), render);

// `whenTrue` or `whenFalse`, by `condition`.
export const either = (
  condition: boolean,
  whenTrue: () => ReactNode,
  whenFalse: () => ReactNode,
): ReactNode =>
  Option.match(Option.liftPredicate(condition, Boolean), {
    onNone: whenFalse,
    onSome: whenTrue,
  });
