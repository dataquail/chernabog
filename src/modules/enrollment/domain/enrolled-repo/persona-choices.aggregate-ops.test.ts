import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { type PersonaEntry } from "./persona-choices.aggregate.ts";
import { PersonaChoicesAggregateOps } from "./persona-choices.aggregate-ops.ts";

const { pickAccount } = PersonaChoicesAggregateOps;

describe("PersonaChoicesAggregateOps.pickAccount", () => {
  const choices: PersonaEntry = { agent: "claude", account: "home" };

  test("an account picked with no role becomes the choices' own", () => {
    expect(pickAccount(choices, Option.none(), Option.some("work"))).toEqual({
      agent: "claude",
      account: "work",
    });
  });

  test("an account picked for a role joins the roles, leaving the choices' own", () => {
    expect(pickAccount(choices, Option.some("reviewer"), Option.some("codex-work"))).toEqual({
      agent: "claude",
      account: "home",
      roles: { reviewer: "codex-work" },
    });
  });

  test("clearing the pick drops the account, so the default applies again", () => {
    expect(pickAccount(choices, Option.none(), Option.none())).toEqual({ agent: "claude" });
  });

  test("clearing a role keeps the others", () => {
    const two: PersonaEntry = { roles: { reviewer: "codex-work", planner: "home" } };

    expect(pickAccount(two, Option.some("reviewer"), Option.none())).toEqual({
      roles: { planner: "home" },
    });
  });

  test("the roles map goes with its last role", () => {
    const one: PersonaEntry = { account: "home", roles: { reviewer: "codex-work" } };

    expect(pickAccount(one, Option.some("reviewer"), Option.none())).toEqual({ account: "home" });
  });

  test("clearing the account takes an emptied roles map with it", () => {
    expect(pickAccount({ account: "home", roles: {} }, Option.none(), Option.none())).toEqual({});
  });
});
