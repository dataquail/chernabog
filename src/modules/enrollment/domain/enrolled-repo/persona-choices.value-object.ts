// What a persona chooses for a repo. On the repo's entry these are the
// defaults every persona inherits; on a persona's entry, its own, each key
// replacing the repo entry's.

import * as Schema from 'effect/Schema';

import { PersonaFlowSettings } from './flow-settings.value-object.ts';

export const PersonaChoices = {
  // The account from accounts: whose budget the persona's runs spend.
  account: Schema.optionalKey(Schema.String),
  accounts: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description: "Other accounts from accounts: the persona's runs use, at most one per agent, for steps on another agent than its account's, such as a codex reviewer. Unset, each agent uses its first account.",
    }),
  ),
  agent: Schema.optionalKey(Schema.String.annotate({ description: "The adapter its agent steps run with, over the repo's agent and the account's." })),
  roles: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String).annotate({
      description: 'An account by role, such as { reviewer: codex-work }, where a role needs another account than the persona\'s own: a step given { role } runs with that account\'s agent.',
    }),
  ),
  // The flows that run: the ones listed, and no others.
  flows: Schema.optionalKey(Schema.Record(Schema.String, PersonaFlowSettings)),
  schedule: Schema.optionalKey(Schema.String),
  activeHours: Schema.optionalKey(Schema.String),
  launcher: Schema.optionalKey(Schema.String),
  enabled: Schema.optionalKey(Schema.Boolean),
};

export const PersonaEntry = Schema.Struct(PersonaChoices);

export type PersonaEntry = typeof PersonaEntry.Type;
