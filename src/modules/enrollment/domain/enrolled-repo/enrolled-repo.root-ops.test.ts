import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { IMPLICIT } from "../../../../kernel/persona.value-object.ts";
import { RepoSlug } from "../../../../kernel/repo-slug.id.ts";
import { Checkout } from "./checkout.value-object.ts";
import { AmbiguousClone } from "./enrolled-repo.errors.ts";
import { EnrolledRepoRoot } from "./enrolled-repo.root.ts";
import { EnrolledRepoRootOps } from "./enrolled-repo.root-ops.ts";
import { MachineOffer } from "./machine-offer.value-object.ts";
import { type PersonaEntry } from "./persona-choices.value-object.ts";
import { TeamFlows } from "./team-flows.value-object.ts";

const slug = RepoSlug.make("acme/widgets");
const alice = Option.some("alice");
const bob = Option.some("bob");

const enrolled = (fields: Partial<ConstructorParameters<typeof EnrolledRepoRoot>[0]> = {}) =>
  EnrolledRepoRoot.make({
    repo: slug,
    path: "/src/widgets",
    defaults: {},
    paused: false,
    ...fields,
  });

// Two personas that both inherit the repo entry's flows.
const shared = () =>
  enrolled({
    defaults: { flows: { implement: {}, review: { schedule: "0 * * * *" } } },
    personas: { alice: {}, bob: {} },
  });

describe("EnrolledRepoRootOps.nameOf", () => {
  test("is the entry's name, else the name half of its slug", () => {
    expect(EnrolledRepoRootOps.nameOf(enrolled())).toBe("widgets");
    expect(EnrolledRepoRootOps.nameOf(enrolled({ name: "widgets-2" }))).toBe("widgets-2");
  });
});

describe("EnrolledRepoRootOps.choicesOf", () => {
  test("a persona's own keys replace the repo entry's whole, flows included", () => {
    const repo = enrolled({
      defaults: { account: "work", flows: { implement: {}, review: {} } },
      personas: { alice: { flows: { review: {} } }, bob: {} },
    });

    expect(EnrolledRepoRootOps.choicesOf(repo, alice)).toEqual({
      account: "work",
      flows: { review: {} },
    });
    expect(EnrolledRepoRootOps.choicesOf(repo, bob)).toEqual({
      account: "work",
      flows: { implement: {}, review: {} },
    });
    expect(EnrolledRepoRootOps.choicesOf(repo, IMPLICIT)).toEqual(repo.defaults);
  });
});

describe("EnrolledRepoRootOps.entryFor", () => {
  const at = (path: string, name: string) => enrolled({ path, name });

  const enrolling = (path: string, name: Option.Option<string> = Option.none()) => ({
    repo: slug,
    name,
    path,
  });

  test("finds the entry with the slug, wherever its checkout is now", () => {
    expect(
      EnrolledRepoRootOps.entryFor(
        [enrolled({ repo: RepoSlug.make("acme/other") }), enrolled({ path: "/old" })],
        enrolling("/new"),
      ),
    ).toEqual(Result.succeed(Option.some(1)));
  });

  test("is none for a repo not enrolled yet", () => {
    expect(EnrolledRepoRootOps.entryFor([], enrolling("/new"))).toEqual(
      Result.succeed(Option.none()),
    );
  });

  test("of several clones, takes the one named, else the one at the path", () => {
    const clones = [at("/one", "one"), at("/two", "two")];

    expect(
      EnrolledRepoRootOps.entryFor(clones, enrolling("/elsewhere", Option.some("two"))),
    ).toEqual(Result.succeed(Option.some(1)));
    expect(EnrolledRepoRootOps.entryFor(clones, enrolling("/one"))).toEqual(
      Result.succeed(Option.some(0)),
    );
  });

  test("refuses to guess between clones when neither name nor path says", () => {
    const found = EnrolledRepoRootOps.entryFor(
      [at("/one", "one"), at("/two", "two")],
      enrolling("/three"),
    );

    expect(found).toEqual(Result.fail(new AmbiguousClone({ repo: slug, names: ["one", "two"] })));
    expect(Result.isFailure(found) && found.failure.message).toBe(
      "acme/widgets is enrolled as one, two; name the one this is with --name",
    );
  });
});

describe("EnrolledRepoRootOps.reenroll", () => {
  test("replaces what the enrolment gives and keeps every other setting", () => {
    const existing = enrolled({
      path: "/old",
      defaults: { account: "work", flows: { implement: {} } },
      personas: { alice: { flows: { review: {} } } },
    });

    const again = EnrolledRepoRootOps.reenroll(
      existing,
      enrolled({ path: "/new", name: "widgets-2" }),
    );

    expect(again).toEqual(
      enrolled({
        path: "/new",
        name: "widgets-2",
        defaults: { account: "work", flows: { implement: {} } },
        personas: { alice: { flows: { review: {} } } },
      }),
    );
  });
});

describe("EnrolledRepoRootOps.ownFlows", () => {
  test("a persona with flows of its own owns them", () => {
    const repo = enrolled({ personas: { alice: { flows: {} }, bob: {} } });

    expect(EnrolledRepoRootOps.ownFlows(repo, alice)).toEqual({ repo, owner: alice });
  });

  test("the only persona, and the implicit one, edit the repo entry's", () => {
    const only = enrolled({ defaults: { flows: { implement: {} } }, personas: { alice: {} } });

    expect(EnrolledRepoRootOps.ownFlows(only, alice)).toEqual({ repo: only, owner: Option.none() });
    expect(EnrolledRepoRootOps.ownFlows(only, IMPLICIT)).toEqual({
      repo: only,
      owner: Option.none(),
    });
  });

  test("one of several that inherits gets its own copy first", () => {
    const { owner, repo } = EnrolledRepoRootOps.ownFlows(shared(), alice);

    expect(owner).toEqual(alice);
    expect(repo.personas).toEqual({ alice: { flows: shared().defaults.flows }, bob: {} });
    expect(repo.defaults).toEqual(shared().defaults);
  });
});

describe("EnrolledRepoRootOps.setFlow", () => {
  test("a change for one of several personas leaves the others the inherited flows", () => {
    const changed = EnrolledRepoRootOps.setFlow(shared(), alice, "implement", false);

    expect(changed.personas).toEqual({
      alice: { flows: { review: { schedule: "0 * * * *" } } },
      bob: {},
    });
    expect(EnrolledRepoRootOps.choicesOf(changed, bob).flows).toEqual(shared().defaults.flows);
  });

  test("turning a flow off keeps its settings as enabled: false, and drops one with none", () => {
    const off = EnrolledRepoRootOps.setFlow(
      EnrolledRepoRootOps.setFlow(shared(), IMPLICIT, "review", false),
      IMPLICIT,
      "implement",
      false,
    );

    expect(off.defaults.flows).toEqual({ review: { schedule: "0 * * * *", enabled: false } });
  });

  test("turning a flow on lists it, keeping its settings", () => {
    const repo = enrolled({
      defaults: { flows: { review: { schedule: "0 * * * *", enabled: false } } },
    });

    const on = EnrolledRepoRootOps.setFlow(
      EnrolledRepoRootOps.setFlow(repo, IMPLICIT, "review", true),
      IMPLICIT,
      "implement",
      true,
    );

    expect(on.defaults.flows).toEqual({ review: { schedule: "0 * * * *" }, implement: {} });
  });

  test("leaves the entry it was given as it was", () => {
    const before = shared();
    EnrolledRepoRootOps.setFlow(before, alice, "implement", false);

    expect(before).toEqual(shared());
  });
});

describe("EnrolledRepoRootOps.setFlowSchedule", () => {
  test("overrides a listed flow's schedule, and clears it again", () => {
    const set = EnrolledRepoRootOps.setFlowSchedule(
      shared(),
      IMPLICIT,
      "implement",
      Option.some("5 * * * *"),
    );

    expect(set.defaults.flows?.implement).toEqual({ schedule: "5 * * * *" });
    expect(
      EnrolledRepoRootOps.setFlowSchedule(set, IMPLICIT, "implement", Option.none()).defaults.flows
        ?.implement,
    ).toEqual({});
  });

  test("an unlisted flow keeps the override, off", () => {
    const set = EnrolledRepoRootOps.setFlowSchedule(
      shared(),
      IMPLICIT,
      "address-review",
      Option.some("5 * * * *"),
    );

    expect(set.defaults.flows?.["address-review"]).toEqual({
      enabled: false,
      schedule: "5 * * * *",
    });
  });

  test("clearing a flow that isn't listed changes nothing", () => {
    expect(
      EnrolledRepoRootOps.setFlowSchedule(shared(), IMPLICIT, "address-review", Option.none()),
    ).toEqual(shared());
  });
});

describe("EnrolledRepoRootOps.setAccount", () => {
  test("a persona without an entry of its own picks on the repo entry", () => {
    expect(
      EnrolledRepoRootOps.setAccount(enrolled(), alice, Option.none(), Option.some("work"))
        .defaults,
    ).toEqual({ account: "work" });
  });

  test("a persona with an entry picks on its own", () => {
    const picked = EnrolledRepoRootOps.setAccount(
      shared(),
      bob,
      Option.some("reviewer"),
      Option.some("codex-work"),
    );

    expect(picked.personas?.bob).toEqual({ roles: { reviewer: "codex-work" } });
    expect(picked.defaults).toEqual(shared().defaults);
  });

  test("clearing the last role drops the roles map", () => {
    const repo = enrolled({ defaults: { account: "work", roles: { reviewer: "codex-work" } } });

    expect(
      EnrolledRepoRootOps.setAccount(repo, IMPLICIT, Option.some("reviewer"), Option.none())
        .defaults,
    ).toEqual({ account: "work" });
  });

  test("clearing the account keeps the roles", () => {
    const repo = enrolled({ defaults: { account: "work", roles: { reviewer: "codex-work" } } });

    expect(
      EnrolledRepoRootOps.setAccount(repo, IMPLICIT, Option.none(), Option.none()).defaults,
    ).toEqual({ roles: { reviewer: "codex-work" } });
  });
});

describe("EnrolledRepoRootOps.named", () => {
  test("finds the repo a person names by its name, its slug or its path", () => {
    const repos = [enrolled({ repo: RepoSlug.make("acme/other"), path: "/src/other" }), enrolled()];

    for (const name of ["widgets", "acme/widgets", "/src/widgets"]) {
      expect(EnrolledRepoRootOps.named(repos, name)).toEqual(Result.succeed(repos[1]));
    }
  });

  test("fails naming the enrolled repos when none answers", () => {
    const missing = EnrolledRepoRootOps.named([enrolled()], "gadgets");

    expect(Result.isFailure(missing) && missing.failure.message).toBe(
      "no enrolled repo named gadgets (enrolled: widgets); run chernabog enroll in it",
    );
    expect(Result.isFailure(EnrolledRepoRootOps.named([], "gadgets")) && "failed").toBe("failed");
  });
});

describe("EnrolledRepoRootOps.pause and resume", () => {
  test("pause and resume change nothing but whether the repo is paused", () => {
    const paused = EnrolledRepoRootOps.pause(shared());

    expect(paused).toEqual(EnrolledRepoRoot.make({ ...shared(), paused: true }));
    expect(EnrolledRepoRootOps.pause(paused)).toEqual(paused);
    expect(EnrolledRepoRootOps.resume(paused)).toEqual(shared());
  });
});

const team = (
  fields: Partial<{
    agent: Option.Option<string>;
    runners: Option.Option<ReadonlyArray<string>>;
    flows: TeamFlows["flows"];
  }> = {},
) => TeamFlows.make({ agent: Option.none(), runners: Option.none(), flows: {}, ...fields });

const machine = (
  personas: ReadonlyArray<string>,
  accounts: ReadonlyArray<readonly [string, string]> = [["work", "claude"]],
) =>
  MachineOffer.make({
    personas,
    accounts: accounts.map(([name, agent]) => ({ name, agent })),
  });

const checkout = (flows: ReadonlyArray<string>, teamFlows = team()) =>
  Checkout.make({ root: "/src/widgets", repo: slug, flows, team: teamFlows });

describe("EnrolledRepoRootOps flow offers", () => {
  test("the team's defaults are its flows that aren't off and that this machine can run", () => {
    const teamFlows = team({
      flows: { fix: { enabled: false }, review: { agent: "codex" }, ship: { runners: ["bob"] } },
    });

    const offers = EnrolledRepoRootOps.flowOffers(
      checkout(["fix", "implement", "review", "ship"], teamFlows),
      machine(["alice"]),
      ["alice"],
    );

    expect(offers.map((offer) => [offer.name, offer.teamDefault])).toEqual([
      ["fix", false],
      ["implement", true],
      ["review", true],
      ["ship", false],
    ]);
    expect(offers[2].unavailable).toEqual(
      Option.some("needs codex; add an account for each with chernabog setup"),
    );
    expect(offers[3].teamOff).toEqual(
      Option.some("not a runner (runners: bob; this machine is alice)"),
    );
    expect(EnrolledRepoRootOps.defaultFlows(offers)).toEqual(["implement"]);
  });

  test("a flow's agents are its own, its roles' and the repo's, each once", () => {
    expect(
      EnrolledRepoRootOps.agentsOf(
        team({
          agent: Option.some("claude"),
          flows: { review: { agent: "codex", agents: { reviewer: "codex", fixer: "opencode" } } },
        }),
        "review",
      ),
    ).toEqual(["codex", "opencode", "claude"]);
  });
});

describe("EnrolledRepoRootOps.choosePersonas", () => {
  const two = machine(["alice", "bob"]);

  test("the ones named, else the only one, else the ones the repo has", () => {
    expect(EnrolledRepoRootOps.choosePersonas(two, Option.none(), Option.some(["bob"]))).toEqual(
      Result.succeed([bob]),
    );
    expect(
      EnrolledRepoRootOps.choosePersonas(machine(["alice"]), Option.none(), Option.none()),
    ).toEqual(Result.succeed([alice]));
    expect(EnrolledRepoRootOps.choosePersonas(two, Option.some(["bob"]), Option.none())).toEqual(
      Result.succeed([bob]),
    );
    expect(EnrolledRepoRootOps.choosePersonas(machine([]), Option.none(), Option.none())).toEqual(
      Result.succeed([IMPLICIT]),
    );
  });

  test("refuses one the machine doesn't act as, none at all, or a choice no one made", () => {
    const failure = (result: Result.Result<unknown, { readonly _tag: string }>) =>
      Result.isFailure(result) && result.failure._tag;

    expect(
      failure(EnrolledRepoRootOps.choosePersonas(two, Option.none(), Option.some(["eve"]))),
    ).toBe("UnknownPersona");
    expect(failure(EnrolledRepoRootOps.choosePersonas(two, Option.none(), Option.some([])))).toBe(
      "NoPersonaChosen",
    );
    expect(failure(EnrolledRepoRootOps.choosePersonas(two, Option.none(), Option.none()))).toBe(
      "PersonaChoiceNeeded",
    );
    expect(
      failure(EnrolledRepoRootOps.choosePersonas(machine([]), Option.none(), Option.some(["bob"]))),
    ).toBe("NoPersonasToChoose");
  });
});

describe("EnrolledRepoRootOps.chooseFlows", () => {
  const offers = EnrolledRepoRootOps.flowOffers(
    checkout(["fix", "implement", "review"], team({ flows: { review: { agent: "codex" } } })),
    machine([]),
    [],
  );

  test("the ones chosen, else the ones it runs, else the defaults", () => {
    expect(
      EnrolledRepoRootOps.chooseFlows(offers, Option.none(), Option.some(["fix", "fix"])),
    ).toEqual(Result.succeed(["fix"]));
    expect(EnrolledRepoRootOps.chooseFlows(offers, Option.some(["fix"]), Option.none())).toEqual(
      Result.succeed(["fix"]),
    );
    expect(EnrolledRepoRootOps.chooseFlows(offers, Option.none(), Option.none())).toEqual(
      Result.succeed(["fix", "implement"]),
    );
  });

  test("refuses a flow the checkout doesn't have, or one this machine can't run", () => {
    const unknown = EnrolledRepoRootOps.chooseFlows(offers, Option.none(), Option.some(["ship"]));

    const unavailable = EnrolledRepoRootOps.chooseFlows(
      offers,
      Option.none(),
      Option.some(["review"]),
    );

    expect(Result.isFailure(unknown) && unknown.failure.message).toBe(
      "no flow named ship in .chernabog/flows/ (it has: fix, implement, review)",
    );
    expect(Result.isFailure(unavailable) && unavailable.failure.message).toBe(
      "review can't run here: it needs codex; add an account for each with chernabog setup",
    );
  });
});

describe("EnrolledRepoRootOps.chooseAccounts", () => {
  const accounts = machine(
    [],
    [
      ["work", "claude"],
      ["personal", "claude"],
      ["codex", "codex"],
      ["codex-work", "codex"],
    ],
  );

  const reviewing = team({ flows: { review: { agent: "codex" } } });
  const none = { account: Option.none(), accounts: [] };

  test("the ones named, else the ones chosen before, else the first, one per other agent", () => {
    expect(
      EnrolledRepoRootOps.chooseAccounts(accounts, reviewing, ["review"], none, ["personal"]),
    ).toEqual(Result.succeed({ account: Option.some("personal"), accounts: ["codex"] }));
    expect(
      EnrolledRepoRootOps.chooseAccounts(
        accounts,
        reviewing,
        ["review"],
        { account: Option.some("personal"), accounts: ["codex-work"] },
        [],
      ),
    ).toEqual(Result.succeed({ account: Option.some("personal"), accounts: ["codex-work"] }));
  });

  test("a machine with one account records none, and no account for the repo's agent fails", () => {
    expect(
      EnrolledRepoRootOps.chooseAccounts(machine([]), team(), ["implement"], none, []),
    ).toEqual(Result.succeed({ account: Option.none(), accounts: [] }));

    const missing = EnrolledRepoRootOps.chooseAccounts(
      machine([]),
      team({ agent: Option.some("codex") }),
      [],
      none,
      [],
    );

    expect(Result.isFailure(missing) && missing.failure.message).toBe(
      "no account for codex in machine config; add one with chernabog setup",
    );
  });

  test("an account named that machine config doesn't have is refused", () => {
    const unknown = EnrolledRepoRootOps.chooseAccounts(accounts, team(), [], none, ["nope"]);

    expect(Result.isFailure(unknown) && unknown.failure.message).toBe(
      "no account named nope in machine config (it has: work, personal, codex, codex-work)",
    );
  });
});

describe("EnrolledRepoRootOps enrolling", () => {
  test("a new checkout is a new entry; one enrolled before keeps its settings", () => {
    const fresh = Result.getOrThrow(
      EnrolledRepoRootOps.enroll([], checkout(["implement"]), Option.none()),
    );

    expect([fresh.added, fresh.repo.path]).toEqual([true, "/src/widgets"]);

    const before = enrolled({ path: "/old", defaults: { flows: { review: {} } }, paused: true });

    const again = Result.getOrThrow(
      EnrolledRepoRootOps.enroll([before], checkout(["implement"]), Option.none()),
    );

    expect([again.added, again.repo.path, again.repo.defaults, again.repo.paused]).toEqual([
      false,
      "/src/widgets",
      { flows: { review: {} } },
      true,
    ]);
  });

  test("a checkout without flows has nothing to enrol", () => {
    const empty = EnrolledRepoRootOps.entryOf([], checkout([]), Option.none());

    expect(Result.isFailure(empty) && empty.failure.message).toBe(
      "/src/widgets: no flows in .chernabog/flows/; run chernabog init here first",
    );
  });

  test("one persona's choices go on the repo's entry, keeping a listed flow's settings", () => {
    const repo = enrolled({
      defaults: {
        flows: { implement: { schedule: "5 * * * *", enabled: false }, fix: {} },
        accounts: ["x"],
      },
    });

    expect(
      EnrolledRepoRootOps.enrolPersonas(
        repo,
        [
          {
            persona: IMPLICIT,
            flows: ["implement", "review"],
            account: Option.some("work"),
            accounts: [],
          },
        ],
        false,
      ).defaults,
    ).toEqual({
      flows: { implement: { schedule: "5 * * * *" }, review: {} },
      account: "work",
    });
  });

  test("per persona, each chosen one gets its own, and one no longer chosen goes", () => {
    const repo = enrolled({ personas: { alice: { flows: { fix: {} } }, carol: {} } });

    const chosen = EnrolledRepoRootOps.enrolPersonas(
      repo,
      [
        { persona: alice, flows: ["fix"], account: Option.none(), accounts: [] },
        { persona: bob, flows: ["review"], account: Option.none(), accounts: ["codex"] },
      ],
      true,
    );

    expect(chosen.personas).toEqual({
      alice: { flows: { fix: {} } },
      bob: { flows: { review: {} }, accounts: ["codex"] },
    });
  });
});

describe("EnrolledRepoRootOps.moved", () => {
  test("is the repo's other entries whose checkout is gone", () => {
    const here = enrolled({ path: "/src/widgets" });
    const gone = enrolled({ path: "/old/widgets", name: "old" });
    const there = enrolled({ path: "/elsewhere/widgets", name: "there" });

    expect(
      EnrolledRepoRootOps.moved([here, gone, there], slug, "/src/widgets", (path) =>
        path.startsWith("/elsewhere"),
      ),
    ).toEqual([gone]);
  });
});

describe("EnrolledRepoRootOps checks", () => {
  test("a schedule must be a cron expression", () => {
    expect(EnrolledRepoRootOps.checkSchedule(Option.some("*/5 * * * *"))).toEqual(
      Result.succeed(Option.some("*/5 * * * *")),
    );

    const refused = EnrolledRepoRootOps.checkSchedule(Option.some("every hour"));
    expect(Result.isFailure(refused) && refused.failure.message).toContain(
      '"every hour" isn\'t a schedule',
    );
  });

  test("a persona's accounts must be known, and one per agent", () => {
    const offer = machine(
      [],
      [
        ["work", "claude"],
        ["personal", "claude"],
        ["codex", "codex"],
      ],
    );

    const check = (defaults: PersonaEntry) =>
      EnrolledRepoRootOps.checkAccounts(enrolled({ defaults }), IMPLICIT, offer);

    expect(Result.isSuccess(check({ account: "personal", roles: { reviewer: "codex" } }))).toBe(
      true,
    );

    const clash = check({ account: "personal", roles: { author: "work" } });
    expect(Result.isFailure(clash) && clash.failure.message).toBe(
      "acme/widgets: roles.author is work, a claude account like the persona's own (personal); a role's account must run another agent",
    );

    const unknown = check({ account: "nope" });
    expect(Result.isFailure(unknown) && unknown.failure.message).toBe(
      'acme/widgets: account "nope" is not one of work, personal, codex',
    );
  });
});
