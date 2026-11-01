// The dashboard's main page (stub).

import type * as Option from "effect/Option";

import { type Filter } from "./filter.ts";
import { type Live } from "./live.ts";

export const Overview = (_props: {
  readonly live: Live;
  readonly filter: Filter;
  readonly selected: Option.Option<number>;
  readonly now: number;
  readonly onFilter: (filter: Filter) => void;
}) => <main />;
