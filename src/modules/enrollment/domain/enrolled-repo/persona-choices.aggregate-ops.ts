// The rules a persona's choices keep on their own, whichever entry holds
// them: the repo entry's defaults or a persona's own. Domain-private: the
// enrolled repo's ops compose them, and nothing outside domain/ names them
// (docs/adr/0007-the-hexagons-remaining-stereotypes.md).

import * as Option from "effect/Option";

import { type PersonaEntry } from "./persona-choices.aggregate.ts";

const withoutAccount = ({ account: _account, ...rest }: PersonaEntry): PersonaEntry => rest;

const withoutRoles = ({ roles: _roles, ...rest }: PersonaEntry): PersonaEntry => rest;

// An emptied roles map goes with the last role.
const withoutEmptyRoles = (choices: PersonaEntry) => {
  if (
    Option.fromUndefinedOr(choices.roles).pipe(
      Option.exists((roles) => Object.keys(roles).length === 0),
    )
  ) {
    return withoutRoles(choices);
  }

  return choices;
};

const withoutRole = (choices: PersonaEntry, role: string) => {
  const { [role]: _role, ...roles } = choices.roles ?? {};

  return withoutEmptyRoles({ ...choices, roles });
};

// Picks the account the choices spend, or one of their roles does; none
// clears the pick, and the roles map goes with its last role.
const pickAccount = (
  choices: PersonaEntry,
  role: Option.Option<string>,
  account: Option.Option<string>,
): PersonaEntry =>
  Option.match(role, {
    onNone: () =>
      Option.match(account, {
        onNone: () => withoutEmptyRoles(withoutAccount(choices)),
        onSome: (chosen) => ({ ...choices, account: chosen }),
      }),
    onSome: (named) =>
      Option.match(account, {
        onNone: () => withoutRole(choices, named),
        onSome: (chosen) => ({ ...choices, roles: { ...choices.roles, [named]: chosen } }),
      }),
  });

export const PersonaChoicesAggregateOps = { pickAccount } as const;
