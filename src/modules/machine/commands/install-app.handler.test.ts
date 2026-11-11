import { PassThroughUnitOfWork } from "@effect-server-utils/unit-of-work/testing";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { AppPersona } from "../domain/machine-setup/app-persona.value-object.ts";
import { MachineSetupRoot } from "../domain/machine-setup/machine-setup.root.ts";
import { MachineSetupSpecifications } from "../domain/machine-setup/machine-setup.specification.ts";
import { MachineSetupsRepository } from "../domain/machine-setup/machine-setups.repository.ts";
import { type AppEnvironment } from "../domain/ports/clients/github-apps.client.ts";
import { AppKeysClientFake } from "../infrastructure/clients/app-keys.client-fake.ts";
import { GitHubAppsClientFake } from "../infrastructure/clients/github-apps.client-fake.ts";
import { MachineSetupsRepositoryFake } from "../infrastructure/repositories/machine-setups.repository-fake.ts";
import { installAppHandler } from "./install-app.handler.ts";

const KEY = "~/keys/acme-chernabog-review.pem";

const LOGIN = "acme-chernabog-review[bot]";

// The reviewer App this machine already acts as, installed on acme's repos.
const known = AppPersona.make({ login: LOGIN, id: "102", installation: "202", key: KEY });

const machine = (
  installations: Readonly<Record<string, string>>,
  provisioned: Array<AppEnvironment>,
  apps: ReadonlyArray<AppPersona> = [],
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
    AppKeysClientFake(new Map([[KEY, "PEM"]])),
    GitHubAppsClientFake({ installations, provisioned }),
    PassThroughUnitOfWork,
  );

const stored = MachineSetupsRepository.use((repository) =>
  repository.findOne(MachineSetupSpecifications.thisMachine).pipe(Effect.map(Option.getOrThrow)),
);

const reviewer = {
  role: "reviewer" as const,
  repo: "acme/widgets",
  login: LOGIN,
  created: Option.some({ id: "102", key: KEY }),
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
        login: LOGIN,
        created: Option.none(),
        environments: true,
      });

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

  effect("reusing an App this machine doesn't act as is refused", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        installAppHandler({ ...reviewer, created: Option.none(), environments: false }),
      );

      expect(error._tag).toBe("AppPersonaUnknown");
    }).pipe(Effect.provide(machine({}, []))),
  );
});
