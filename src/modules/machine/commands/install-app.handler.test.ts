import { PassThroughUnitOfWork } from "@effect-server-utils/unit-of-work/testing";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { AppPersona } from "../domain/machine-setup/app-persona.value-object.ts";
import { AppPersonaUnknown } from "../domain/machine-setup/machine-setup.errors.ts";
import { MachineSetupRoot } from "../domain/machine-setup/machine-setup.root.ts";
import { MachineSetupSpecifications } from "../domain/machine-setup/machine-setup.specification.ts";
import { MachineSetupsRepository } from "../domain/machine-setup/machine-setups.repository.ts";
import {
  type AppEnvironment,
  type DescribedApp,
} from "../domain/ports/clients/github-apps.client.ts";
import { AppKeysClientFake } from "../infrastructure/clients/app-keys.client-fake.ts";
import { GitHubAppsClientFake } from "../infrastructure/clients/github-apps.client-fake.ts";
import { MachineSetupsRepositoryFake } from "../infrastructure/repositories/machine-setups.repository-fake.ts";
import { installAppHandler } from "./install-app.handler.ts";

const KEY = "~/keys/acme-chernabog-review.pem";

const LOGIN = "acme-chernabog-review[bot]";

// The reviewer App this machine already acts as, installed on acme's repos.
const known = AppPersona.make({ login: LOGIN, id: "102", installation: "202", key: KEY });

const AUTHOR = { contents: "write", checks: "read", metadata: "read" };
const REVIEWER = { contents: "write", checks: "write", metadata: "read" };

// Each App as GitHub has it now, by id.
const GITHUB_APPS = {
  "101": { slug: "acme-chernabog-author", owner: "acme", permissions: AUTHOR },
  "102": { slug: "acme-chernabog-review", owner: "acme", permissions: REVIEWER },
} satisfies Readonly<Record<string, DescribedApp>>;

const machine = (
  installations: Readonly<Record<string, string>>,
  provisioned: Array<AppEnvironment>,
  apps: ReadonlyArray<AppPersona> = [],
  repositories?: Readonly<Record<string, ReadonlyArray<string>>>,
  described: Readonly<Record<string, DescribedApp>> = GITHUB_APPS,
) =>
  Layer.mergeAll(
    MachineSetupsRepositoryFake(
      MachineSetupRoot.make({
        personas: ["alice", ...apps.map((app) => app.login)],
        apps,
        accounts: [],
        accountsWritten: false,
      }),
    ),
    AppKeysClientFake(
      new Map([[KEY, "PEM"], ...apps.map((app): [string, string] => [app.key, "PEM"])]),
    ),
    GitHubAppsClientFake({ installations, provisioned, repositories, apps: described }),
    PassThroughUnitOfWork,
  );

const stored = MachineSetupsRepository.use((repository) =>
  repository.findOne(MachineSetupSpecifications.thisMachine).pipe(Effect.map(Option.getOrThrow)),
);

const reviewer = {
  role: "reviewer" as const,
  repo: "acme/widgets",
  created: Option.some({ login: LOGIN, id: "102", key: KEY }),
};

describe("installAppHandler", () => {
  effect(
    "adds the App's installation on the repo as a persona, and sets up its Environment",
    () => {
      const provisioned: Array<AppEnvironment> = [];

      return Effect.gen(function* () {
        const installed = yield* installAppHandler({ ...reviewer, environments: true });
        const setup = yield* stored;

        expect(installed).toMatchObject({
          login: "acme-chernabog-review[bot]",
          id: "102",
          reused: false,
          installation: "202",
          environment: Option.some("chernabog-review"),
        });
        expect(setup.personas).toEqual(["alice", "acme-chernabog-review[bot]"]);
        expect(setup.apps.map((app) => [app.login, app.id, app.installation, app.key])).toEqual([
          ["acme-chernabog-review[bot]", "102", "202", KEY],
        ]);
        expect(provisioned).toEqual([
          {
            repo: "acme/widgets",
            name: "chernabog-review",
            defaultBranchOnly: true,
            variables: { CHERNABOG_APP_ID: "102" },
            secrets: { CHERNABOG_APP_KEY: "PEM" },
          },
        ]);
      }).pipe(Effect.provide(machine({ "102 acme/widgets": "202" }, provisioned)));
    },
  );

  effect("sets up no Environment unless asked", () => {
    const provisioned: Array<AppEnvironment> = [];

    return Effect.gen(function* () {
      const installed = yield* installAppHandler({ ...reviewer, environments: false });

      expect(installed.environment).toEqual(Option.none());
      expect(provisioned).toEqual([]);
    }).pipe(Effect.provide(machine({ "102 acme/widgets": "202" }, provisioned)));
  });

  effect("an App not installed on the repo becomes no persona", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(installAppHandler({ ...reviewer, environments: true }));

      expect(error.message).toBe(
        "acme-chernabog-review isn't installed on acme/widgets; install it there from https://github.com/apps/acme-chernabog-review/installations/new, then run chernabog ci apps again",
      );
      expect((yield* stored).personas).toEqual(["alice"]);
    }).pipe(Effect.provide(machine({ "102 acme/other": "203" }, []))),
  );

  effect("reuses the App this machine acts as on another of the owner's repos", () => {
    const provisioned: Array<AppEnvironment> = [];

    return Effect.gen(function* () {
      const installed = yield* installAppHandler({
        role: "reviewer",
        repo: "acme/gadgets",
        created: Option.none(),
        environments: true,
      });

      expect(installed.reused).toBe(true);
      expect(installed.installation).toBe("202");
      expect(installed.alsoOn).toEqual(["acme/widgets"]);
      expect((yield* stored).apps).toEqual([known]);
      expect(provisioned.map((environment) => [environment.repo, environment.name])).toEqual([
        ["acme/gadgets", "chernabog-review"],
      ]);
    }).pipe(
      Effect.provide(
        machine({ "102 acme/widgets": "202", "102 acme/gadgets": "202" }, provisioned, [known]),
      ),
    );
  });

  effect("doesn't call the repo itself another when --repo is in another case", () =>
    Effect.gen(function* () {
      const installed = yield* installAppHandler({
        ...reviewer,
        repo: "Acme/Widgets",
        environments: false,
      });

      expect(installed.alsoOn).toEqual(["acme/gadgets"]);
    }).pipe(
      Effect.provide(
        machine({ "102 Acme/Widgets": "202" }, [], [], {
          "202": ["acme/widgets", "acme/gadgets"],
        }),
      ),
    ),
  );

  effect("reuses the role's App on an owner whose name has capitals, in any case", () => {
    const author = AppPersona.make({
      login: "dataquail-chernabog-author[bot]",
      id: "301",
      installation: "401",
      key: "~/keys/dataquail-chernabog-author.pem",
    });

    const reviewing = AppPersona.make({
      login: "dataquail-chernabog-review[bot]",
      id: "302",
      installation: "402",
      key: "~/keys/dataquail-chernabog-review.pem",
    });

    return Effect.gen(function* () {
      const installed = yield* installAppHandler({
        role: "author",
        repo: "DataQuail/widgets",
        created: Option.none(),
        environments: false,
      });

      expect([installed.login, installed.id, installed.alsoOn]).toEqual([
        "dataquail-chernabog-author[bot]",
        "301",
        [],
      ]);
    }).pipe(
      Effect.provide(
        machine(
          { "301 DataQuail/widgets": "401" },
          [],
          [reviewing, author],
          {
            "401": ["dataquail/widgets"],
          },
          {
            "301": { slug: "dataquail-chernabog-author", owner: "DataQuail", permissions: AUTHOR },
            "302": {
              slug: "dataquail-chernabog-review",
              owner: "DataQuail",
              permissions: REVIEWER,
            },
          },
        ),
      ),
    );
  });

  effect("reuses an App the person renamed on GitHub's form, found by what it may do", () => {
    const renamed = AppPersona.make({
      login: "quail-gatekeeper[bot]",
      id: "102",
      installation: "202",
      key: "~/keys/quail-gatekeeper.pem",
    });

    return Effect.gen(function* () {
      const installed = yield* installAppHandler({
        ...reviewer,
        created: Option.none(),
        environments: false,
      });

      expect([installed.login, installed.id]).toEqual(["quail-gatekeeper[bot]", "102"]);
    }).pipe(
      Effect.provide(
        machine(
          { "102 acme/widgets": "202" },
          [],
          [renamed],
          {},
          {
            "102": { slug: "quail-gatekeeper", owner: "acme", permissions: REVIEWER },
          },
        ),
      ),
    );
  });

  effect("finds nothing to reuse in another owner's App, or another role's", () =>
    Effect.gen(function* () {
      const otherRole = yield* Effect.flip(
        installAppHandler({
          role: "author",
          repo: "acme/widgets",
          created: Option.none(),
          environments: false,
        }),
      );

      const otherOwner = yield* Effect.flip(
        installAppHandler({
          role: "reviewer",
          repo: "globex/site",
          created: Option.none(),
          environments: false,
        }),
      );

      expect(otherRole).toEqual(new AppPersonaUnknown({ role: "author", owner: "acme" }));
      expect(otherOwner).toEqual(new AppPersonaUnknown({ role: "reviewer", owner: "globex" }));
    }).pipe(Effect.provide(machine({ "102 acme/widgets": "202" }, [], [known]))),
  );
});
