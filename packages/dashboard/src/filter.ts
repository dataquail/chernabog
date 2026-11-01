// Which repos and personas the overview shows (stub).

import * as Option from "effect/Option";

import { type DaemonStatus } from "#daemon/protocol";

export type Filter = {
  readonly repo: Option.Option<string>;
  readonly persona: Option.Option<string>;
};

export const everything: Filter = { repo: Option.none(), persona: Option.none() };

export const filtered = (status: DaemonStatus, _filter: Filter): DaemonStatus => status;

export const repoChoices = (_status: DaemonStatus): ReadonlyArray<string> => [];

export const personaChoices = (_status: DaemonStatus): ReadonlyArray<string> => [];
