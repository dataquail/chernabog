import {
  defineFlow,
  fillTemplate,
  globToRegExp,
  parseJson,
  pathsMatching,
  printJson,
} from "@chernabog/sdk";
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import YAML from "yaml";

import { BUNDLED_PACKAGES, decodeManifest, requiredVersion } from "../src/flow-deps.ts";
import { slugFromRemote } from "../src/modules/enrollment/infrastructure/clients/checkouts.client-live.ts";
import { EnrolledReposRepositoryLive } from "../src/modules/enrollment/infrastructure/repositories/enrolled-repos.repository-live.ts";
import { setFlowScheduleUseCase } from "../src/modules/enrollment/use-cases/set-flow-schedule.use-case.ts";
import { setPersonaAccountUseCase } from "../src/modules/enrollment/use-cases/set-persona-account.use-case.ts";
import { setPersonaFlowUseCase } from "../src/modules/enrollment/use-cases/set-persona-flow.use-case.ts";
import {
  BundleClientLive,
  scaffoldFiles,
} from "../src/modules/recipes/infrastructure/clients/bundle.client-live.ts";
import { ChernabogDirClientLive } from "../src/modules/recipes/infrastructure/clients/chernabog-dir.client-live.ts";
import { scaffoldRepoUseCase } from "../src/modules/recipes/use-cases/scaffold-repo.use-case.ts";
import {
  DEFAULT_LIMITS,
  EnrolledRepo,
  flowOff,
  loadRepo,
  MachineConfigFile,
  machineConfigFile,
  mergeRepoConfig,
  needsLogin,
  normalizeMachineConfig,
  personasOf,
  RepoConfigFile,
  routingOf,
} from "../src/repo-config.ts";
import { scheduleFor } from "../src/schedule.ts";
import { VERSION } from "../src/version.ts";
import { effect, effectAtHome } from "./effect-test.ts";

const machine = normalizeMachineConfig(
  Schema.decodeSync(MachineConfigFile)({
    accounts: {
      work: {},
      personal: {
        configDir: "~/.claude-personal",
        expectedEmail: "dev@example.com",
        agent: "codex",
      },
      ci: { oauthTokenEnv: "CLAUDE_CODE_OAUTH_TOKEN", usageGate: "none" },
    },
    concurrency: 2,
    humanOnly: ["a machine-wide limit"],
    repos: [{ path: "~/code/demo", repo: "dataquail/demo", account: "personal" }],
  }),
  "/Users/dev",
);

const enrolled: EnrolledRepo = {
  path: "/Users/dev/code/demo",
  repo: "dataquail/demo",
  account: "personal",
};

// The persona's own choices for a repo, as its entry in machine config writes them.
type Own = Partial<typeof EnrolledRepo.Encoded>;

const mergeAll = (
  repo: typeof RepoConfigFile.Encoded,
  own: Own,
  onto: EnrolledRepo = enrolled,
  on = machine,
) =>
  Effect.gen(function* () {
    const entry = yield* Schema.decodeUnknownEffect(EnrolledRepo)({ ...onto, ...own });

    return yield* mergeRepoConfig(
      on,
      entry,
      yield* Schema.decodeEffect(RepoConfigFile)(repo),
      "/snapshot/.chernabog",
      {},
    );
  });

// The repo as its one persona, the implicit one, runs it.
const merge = (repo: typeof RepoConfigFile.Encoded, own: Own, onto: EnrolledRepo = enrolled) =>
  Effect.map(mergeAll(repo, own, onto), (merged) => merged.personas[0]);

const flowSettings = (merged: Effect.Success<ReturnType<typeof merge>>, flow: string) =>
  Record.get(merged.flows, flow);

describe("config layers", () => {
  test("machine config expands home and defaults the account to the first one", () => {
    expect(machine.repos.map((repo) => repo.path)).toEqual(["/Users/dev/code/demo"]);
    expect(machine.accounts.find((account) => account.name === "personal")?.configDir).toEqual(
      Option.some("/Users/dev/.claude-personal"),
    );
  });

  test("an account's oauthTokenEnv names the variable its token comes from, never the token", () => {
    expect(machine.accounts.find((account) => account.name === "ci")?.oauthTokenEnv).toEqual(
      Option.some("CLAUDE_CODE_OAUTH_TOKEN"),
    );
    expect(machine.accounts.find((account) => account.name === "work")?.oauthTokenEnv).toEqual(
      Option.none(),
    );
  });

  test("an account reads usage unless it opts out with usageGate: none", () => {
    expect(machine.accounts.find((account) => account.name === "ci")?.usageGate).toBe("none");
    expect(machine.accounts.find((account) => account.name === "work")?.usageGate).toBe("usage");
    expect(() =>
      Schema.decodeUnknownSync(MachineConfigFile)({ accounts: { ci: { usageGate: "off" } } }),
    ).toThrow();
  });

  effect("a flow's agents by role merge role by role, and reach the SDK as flowRoleAgents", () =>
    Effect.gen(function* () {
      const merged = yield* merge(
        { flows: { ship: { agent: "claude", agents: { reviewer: "codex", author: "claude" } } } },
        { flows: { ship: { agents: { reviewer: "opencode" } } } },
      );

      expect(merged.chosen).toEqual(["ship"]);
      expect(Option.map(flowSettings(merged, "ship"), (ship) => ship.agents)).toEqual(
        Option.some({ reviewer: "opencode", author: "claude" }),
      );
      expect(merged.settings.flowRoleAgents).toEqual({
        ship: { reviewer: "opencode", author: "claude" },
      });
      expect(merged.settings.flowAgents).toEqual({ ship: "claude" });
    }),
  );

  effect("the persona's settings in machine config override the repo's config key by key", () =>
    Effect.gen(function* () {
      const merged = yield* merge(
        {
          schedule: "0 * * * *",
          localGate: ["pnpm test"],
          flows: { review: { schedule: "30 * * * *", concurrency: 5 } },
        },
        { schedule: "15 * * * *", flows: { review: { enabled: false } } },
      );

      expect(merged.schedule).toEqual({
        own: Option.some("15 * * * *"),
        repo: Option.some("0 * * * *"),
      });
      expect(flowSettings(merged, "review")).toEqual(
        Option.some({ enabled: false, concurrency: 2 }),
      );
      expect(merged.settings.localGate).toEqual(["pnpm test"]);
      expect(merged.settings.humanOnly).toEqual(["a machine-wide limit"]);
      expect(merged.settings.limits).toEqual(DEFAULT_LIMITS);
      expect(merged.settings.labels.eligible).toBe("auto:eligible");
    }),
  );

  effect("the persona's schedules beat the team's, a flow's own included", () =>
    Effect.gen(function* () {
      const scheduled = defineFlow({
        trigger: Effect.succeed([]),
        schedule: "45 * * * *",
        workflow: () => Effect.void,
      });

      const unscheduled = defineFlow({ trigger: Effect.succeed([]), workflow: () => Effect.void });
      const team = { schedule: "0 * * * *", flows: { review: { schedule: "30 * * * *" } } };

      const scheduleOf = (own: Own, name: string, flow = unscheduled) =>
        merge(team, own).pipe(Effect.map((merged) => scheduleFor(merged, name, flow, 0, 1)));

      expect(yield* scheduleOf({}, "review")).toBe("30 * * * *");
      expect(yield* scheduleOf({}, "implement", scheduled)).toBe("45 * * * *");
      expect(yield* scheduleOf({}, "implement")).toBe("0 * * * *");
      expect(yield* scheduleOf({ schedule: "15 * * * *" }, "review")).toBe("15 * * * *");
      expect(yield* scheduleOf({ schedule: "15 * * * *" }, "implement", scheduled)).toBe(
        "15 * * * *",
      );
      expect(
        yield* scheduleOf(
          { schedule: "15 * * * *", flows: { review: { schedule: "5 * * * *" } } },
          "review",
        ),
      ).toBe("5 * * * *");
      expect(
        yield* merge({}, {}).pipe(
          Effect.map((merged) => scheduleFor(merged, "implement", unscheduled, 1, 3)),
        ),
      ).toBe("20 * * * *");
    }),
  );

  effect("a persona runs the flows machine config lists for it, and no others", () =>
    Effect.gen(function* () {
      const team = {
        runners: ["Alice"],
        flows: { review: { runners: ["alice", "bob"] }, fix: { enabled: false } },
      };

      const offFor = (own: Own, flow: string) =>
        merge(team, own).pipe(Effect.map((merged) => flowOff(merged, flow)));

      expect(yield* offFor({ flows: { implement: {}, fix: {} } }, "implement")).toEqual(
        Option.none(),
      );
      // The team's enabled and runners are what enroll offers, not what runs.
      expect(yield* offFor({ flows: { implement: {}, fix: {} } }, "fix")).toEqual(Option.none());
      expect(yield* offFor({ flows: { implement: {} } }, "review")).toEqual(
        Option.some("flow turned off"),
      );
      expect(yield* offFor({ flows: { review: { enabled: false } } }, "review")).toEqual(
        Option.some("flow turned off"),
      );
      expect(yield* offFor({}, "implement")).toEqual(Option.some("flow turned off"));
      expect(flowSettings(yield* merge(team, {}), "review")).toEqual(Option.some({}));
    }),
  );

  effect("a persona's own keys replace the repo entry's, and the rest are inherited", () =>
    Effect.gen(function* () {
      const on = { ...machine, github: ["alice", "bob"] };

      const merged = yield* mergeAll(
        {},
        {
          schedule: "5 * * * *",
          flows: { implement: {} },
          personas: {
            alice: {},
            bob: { flows: { review: { schedule: "10 * * * *" } }, account: "work" },
          },
        },
        enrolled,
        on,
      );

      const [alice, bob] = merged.personas;

      expect(alice.persona).toEqual(Option.some("alice"));
      expect(alice.chosen).toEqual(["implement"]);
      expect(alice.settings.account.name).toBe("personal");
      expect(bob.chosen).toEqual(["review"]);
      expect(bob.schedule.own).toEqual(Option.some("5 * * * *"));
      expect(bob.settings.account.name).toBe("work");
      expect(bob.settings.agent).toBe("claude");
      expect(merged.settings).toBe(alice.settings);
    }),
  );

  effect("a role uses the persona's pick of account, which runs that account's agent", () =>
    Effect.gen(function* () {
      const merged = yield* merge({}, { account: "work", roles: { reviewer: "personal" } });
      expect(merged.settings.roleAgents).toEqual({ reviewer: "codex" });
      expect(
        Option.map(Record.get(merged.settings.agentAccounts, "codex"), (account) => account.name),
      ).toEqual(Option.some("personal"));
      expect(merged.settings.account.name).toBe("work");

      const same = yield* Effect.flip(merge({}, { account: "work", roles: { reviewer: "ci" } }));
      expect(same.message).toBe(
        "dataquail/demo: roles.reviewer is ci, a claude account like the persona's own (work); a role's account must run another agent",
      );
    }),
  );

  effect(
    "a flow filters work by assignee or requested reviewer only when the team or the person says so",
    () =>
      Effect.gen(function* () {
        const team = {
          flows: { implement: { assignee: ["@me", "none"] }, review: { reviewRequested: "alice" } },
        };

        const merged = yield* merge(team, { flows: { implement: {}, review: {} } });

        expect(routingOf(merged, "implement")).toEqual({
          assignee: Option.some(["@me", "none"]),
          reviewRequested: Option.none(),
        });
        expect(routingOf(merged, "review")).toEqual({
          assignee: Option.none(),
          reviewRequested: Option.some(["alice"]),
        });
        expect(routingOf(merged, "fix")).toEqual({
          assignee: Option.none(),
          reviewRequested: Option.none(),
        });
        expect(needsLogin(yield* mergeAll(team, { flows: { implement: {} } }))).toBe(true);
        // Only a flow that runs needs the login.
        expect(needsLogin(yield* mergeAll(team, { flows: { review: {} } }))).toBe(false);
        expect(needsLogin(yield* mergeAll({}, {}))).toBe(false);

        const cleared = yield* Schema.encodeEffect(Schema.OptionFromNullOr(Schema.String))(
          Option.none(),
        );

        expect(
          routingOf(
            yield* merge(team, { flows: { implement: { assignee: cleared } } }),
            "implement",
          ).assignee,
        ).toEqual(Option.none());
        expect(
          routingOf(yield* merge({}, { flows: { review: { reviewRequested: "@me" } } }), "review")
            .reviewRequested,
        ).toEqual(Option.some(["@me"]));
      }),
  );

  test("runners belong to the team, not to machine config", () => {
    const decoded = Schema.decodeUnknownResult(EnrolledRepo)({
      ...enrolled,
      flows: { review: { runners: ["me"] } },
    });

    expect(Option.map(Result.getFailure(decoded), (issue) => issue.message)).toEqual(
      Option.some(expect.stringContaining("runners is the team's choice")),
    );
  });

  effect("the agent comes from machine config, then the repo, then the account's own agent", () =>
    Effect.gen(function* () {
      const agentOf = (repo: typeof RepoConfigFile.Encoded, own: Own) =>
        merge(repo, own).pipe(Effect.map((merged) => merged.settings.agent));

      expect(yield* agentOf({ agent: "opencode" }, { agent: "claude" })).toBe("claude");
      expect(yield* agentOf({ agent: "opencode" }, {})).toBe("opencode");
      expect(yield* agentOf({}, {})).toBe("codex");
    }),
  );

  effect("each agent runs under an account of its own", () =>
    Effect.gen(function* () {
      const merged = yield* merge({}, {});

      const accountFor = (agent: string) =>
        Option.map(Record.get(merged.settings.agentAccounts, agent), (account) => account.name);

      expect(accountFor("codex")).toEqual(Option.some("personal"));
      expect(accountFor("claude")).toEqual(Option.some("work"));
      expect(merged.settings.account.name).toBe("personal");
    }),
  );

  effect("a repo cannot raise concurrency past the machine limit", () =>
    Effect.gen(function* () {
      const merged = yield* merge({ flows: { implement: { concurrency: 10 } } }, {});
      expect(
        Option.map(flowSettings(merged, "implement"), (settings) => settings.concurrency),
      ).toEqual(Option.some(2));
    }),
  );

  effect("an unknown account is refused", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(merge({}, {}, { ...enrolled, account: "other" }));
      expect(error.message).toBe(
        'dataquail/demo: account "other" is not one of work, personal, ci',
      );
    }),
  );

  describe("the launcher", () => {
    const machineWith = (extra: Partial<typeof MachineConfigFile.Encoded>) =>
      normalizeMachineConfig(
        Schema.decodeSync(MachineConfigFile)({
          repos: [{ path: "~/code/demo", repo: "dataquail/demo" }],
          ...extra,
        }),
        "/Users/dev",
      );

    const resolve = (
      repo: typeof RepoConfigFile.Encoded,
      own: Own,
      extra: Partial<typeof MachineConfigFile.Encoded> = {},
    ) =>
      Effect.map(
        mergeAll(
          repo,
          own,
          { path: "/Users/dev/code/demo", repo: "dataquail/demo" },
          machineWith(extra),
        ),
        (merged) => merged.settings.launcher,
      );

    const chosen = (
      repo: typeof RepoConfigFile.Encoded,
      own: Own,
      extra: Partial<typeof MachineConfigFile.Encoded> = {},
    ) => Effect.map(resolve(repo, own, extra), (launcher) => `${launcher.name} (${launcher.from})`);

    effect(
      "comes from the repo's entry in machine config, then machine config's own, then the repo's default, then headless",
      () =>
        Effect.gen(function* () {
          expect(
            yield* chosen({ launcher: "tmux" }, { launcher: "orca" }, { launcher: "tmux" }),
          ).toBe("orca (repo entry)");
          expect(yield* chosen({ launcher: "tmux" }, {}, { launcher: "orca" })).toBe(
            "orca (machine config)",
          );
          expect(yield* chosen({ launcher: "tmux" }, {})).toBe("tmux (repo config)");
          expect(yield* chosen({}, {})).toBe("headless (default)");
        }),
    );

    effect("fails closed outside the repo's allowedLaunchers, naming the layer that chose it", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          resolve(
            { launcher: "orca", allowedLaunchers: ["orca", "headless"] },
            {},
            { launcher: "tmux" },
          ),
        );

        expect(error.message).toBe(
          `launcher "tmux" (from machine config) isn't allowed by demo's config: allowedLaunchers is orca, headless`,
        );
        expect(
          yield* chosen(
            { launcher: "orca", allowedLaunchers: ["orca", "tmux"] },
            { launcher: "tmux" },
          ),
        ).toBe("tmux (repo entry)");
        const unset = yield* Effect.flip(resolve({ allowedLaunchers: ["orca"] }, {}));
        expect(unset.message).toContain('launcher "headless" (from default)');
      }),
    );

    effect("an unknown launcher is refused, listing the known ones", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          resolve(
            {},
            { launcher: "screen" },
            { launchers: { mine: { start: ["x"], close: ["y"] } } },
          ),
        );

        expect(error.message).toBe(
          'unknown launcher "screen" (from repo entry); known launchers: headless, orca, tmux, mine',
        );
      }),
    );

    effect("a launcher of your own comes from machine config, with its commands", () =>
      Effect.gen(function* () {
        const launcher = yield* resolve(
          {},
          {},
          {
            launcher: "mine",
            launchers: {
              mine: {
                start: ["wezterm", "cli", "spawn", "--", "sh", "-c", "{command}"],
                close: ["true"],
              },
            },
          },
        );

        expect(launcher.name).toBe("mine");
        expect(Option.map(launcher.custom, (commands) => commands.start[0])).toEqual(
          Option.some("wezterm"),
        );
      }),
    );

    test("launcher commands in a repo are refused", () => {
      const launchers = { mine: { start: ["curl", "evil.sh"], close: ["true"] } };
      const repo = Schema.decodeUnknownResult(RepoConfigFile)({ launchers });
      expect(Option.map(Result.getFailure(repo), (issue) => issue.message)).toEqual(
        Option.some(expect.stringMatching(/only be defined in machine config/)),
      );
    });
  });

  test("the scaffolded config.yaml is valid repo config", () => {
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(RepoConfigFile)(YAML.parse(scaffoldFiles()["config.yaml"])),
      ),
    ).toBe(true);
  });

  test("a duration that is not one is refused", () => {
    const decoded = Schema.decodeResult(RepoConfigFile)({ limits: { staleAfter: "soonish" } });
    expect(Option.map(Result.getFailure(decoded), (issue) => issue.message)).toEqual(
      Option.some(expect.stringMatching(/not a duration/)),
    );
  });
});

// Scaffolding a repo, and the files it says it wrote, as init says them.
const scaffold = (repo: string) =>
  scaffoldRepoUseCase(repo).pipe(
    Effect.map(({ changes }) =>
      changes.map(({ change, entries, path }) => {
        switch (change) {
          case "written": {
            return path;
          }

          case "updated": {
            return `${path} (updated)`;
          }

          case "pinned": {
            return `${path} (pins updated)`;
          }

          case "ignored": {
            return `${path} (+ ${entries.join(", ")})`;
          }
        }
      }),
    ),
    Effect.provide(Layer.mergeAll(ChernabogDirClientLive, BundleClientLive)),
  );

describe("init", () => {
  effect(
    "scaffolds .chernabog/ without flows, which come from recipes, and without overwriting",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const repo = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-init-" });
        yield* fs.writeFileString(`${repo}/.gitignore`, "node_modules/");
        const first = yield* scaffold(repo);
        expect(first).toContain(".chernabog/config.yaml");
        expect(
          first.filter(
            (path) =>
              path.startsWith(".chernabog/flows/") || path.startsWith(".chernabog/prompts/"),
          ),
        ).toEqual([]);
        expect(yield* fs.exists(`${repo}/.chernabog/config.schema.json`)).toBe(true);
        yield* fs.writeFileString(`${repo}/.chernabog/config.yaml`, "baseBranch: develop\n");
        expect(yield* scaffold(repo)).toEqual([]);
        expect(yield* fs.readFileString(`${repo}/.chernabog/config.yaml`)).toBe(
          "baseBranch: develop\n",
        );
        expect(yield* fs.exists(`${repo}/.chernabog/local.yaml`)).toBe(false);
        expect(yield* fs.readFileString(`${repo}/.gitignore`)).toBe("node_modules/");
      }),
  );

  effect("brings the generated schemas up to date, and only those", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-init-" });
      yield* scaffold(repo);
      yield* fs.writeFileString(`${repo}/.chernabog/config.schema.json`, "{}");
      yield* fs.writeFileString(`${repo}/.chernabog/config.yaml`, "baseBranch: develop\n");
      expect(yield* scaffold(repo)).toEqual([".chernabog/config.schema.json (updated)"]);
      expect(yield* fs.readFileString(`${repo}/.chernabog/config.schema.json`)).toContain(
        "allowedLaunchers",
      );
      expect(yield* fs.readFileString(`${repo}/.chernabog/config.yaml`)).toBe(
        "baseBranch: develop\n",
      );
    }),
  );

  effect("gitignores .chernabog/node_modules/ in a repo that ignores nothing yet", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-init-" });
      yield* scaffold(repo);
      expect(yield* fs.readFileString(`${repo}/.gitignore`)).toBe(".chernabog/node_modules/\n");
    }),
  );

  effect(
    "pins the bundled SDK and effect in package.json, and brings only those pins up to date",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const repo = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-init-" });
        const path = `${repo}/.chernabog/package.json`;
        yield* scaffold(repo);
        expect(parseJson(yield* fs.readFileString(path))).toEqual(
          Option.some({
            private: true,
            engines: { chernabog: `>=${VERSION}` },
            devDependencies: BUNDLED_PACKAGES,
          }),
        );

        yield* fs.writeFileString(
          path,
          '{ "name": "flows", "dependencies": { "effect": "4.0.0", "zod": "^3" }, "devDependencies": { "@chernabog/sdk": "0.0.1", "typescript": "5" } }',
        );
        expect(yield* scaffold(repo)).toEqual([".chernabog/package.json (pins updated)"]);
        expect(parseJson(yield* fs.readFileString(path))).toEqual(
          Option.some({
            name: "flows",
            dependencies: { zod: "^3" },
            devDependencies: { typescript: "5", ...BUNDLED_PACKAGES },
            engines: { chernabog: `>=${VERSION}` },
          }),
        );
        expect(yield* scaffold(repo)).toEqual([]);
      }),
  );

  effect("raises the chernabog floor only when the repo picks up something of this binary", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-init-" });
      const path = `${repo}/.chernabog/package.json`;

      const floorOf = fs
        .readFileString(path)
        .pipe(Effect.flatMap(decodeManifest), Effect.flatMap(requiredVersion));

      const withFloor = (floor: string) =>
        `{ "engines": { "chernabog": "${floor}" }, "devDependencies": ${printJson(BUNDLED_PACKAGES)} }`;

      yield* scaffold(repo);

      yield* fs.writeFileString(path, withFloor(">=0.0.1"));
      expect(yield* scaffold(repo)).toEqual([]);
      expect(yield* floorOf).toEqual(Option.some("0.0.1"));

      yield* fs.writeFileString(`${repo}/.chernabog/config.schema.json`, "{}");
      expect(yield* scaffold(repo)).toEqual([
        ".chernabog/config.schema.json (updated)",
        ".chernabog/package.json (pins updated)",
      ]);
      expect(yield* floorOf).toEqual(Option.some(VERSION));
    }),
  );

  effect("refuses a .chernabog/ that needs a newer chernabog, and writes nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-init-" });
      yield* fs.makeDirectory(`${repo}/.chernabog`);
      yield* fs.writeFileString(
        `${repo}/.chernabog/package.json`,
        '{ "engines": { "chernabog": ">=99.0.0" } }',
      );
      const scaffolded = yield* Effect.result(scaffold(repo));
      expect(Result.isFailure(scaffolded) && scaffolded.failure.message).toContain(
        "needs chernabog 99.0.0 or newer",
      );
      expect(yield* fs.readDirectory(`${repo}/.chernabog`)).toEqual(["package.json"]);
    }),
  );

  test("the repo slug comes from an https or ssh origin", () => {
    expect(slugFromRemote("git@github.com:dataquail/goodbones.git\n")).toEqual(
      Option.some("dataquail/goodbones"),
    );
    expect(slugFromRemote("https://github.com/dataquail/goodbones")).toEqual(
      Option.some("dataquail/goodbones"),
    );
    expect(slugFromRemote("/tmp/origin.git")).toEqual(Option.none());
  });
});

describe("loading a repo", () => {
  const configDirWith = (files: Readonly<Record<string, string>>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-load-" });

      for (const [name, text] of Object.entries(files)) {
        yield* fs.writeFileString(`${dir}/${name}`, text);
      }

      return dir;
    });

  const load = (files: Readonly<Record<string, string>>) =>
    Effect.flatMap(configDirWith(files), (dir) =>
      Effect.result(loadRepo(machine, { ...enrolled, path: dir }, dir)),
    );

  effectAtHome(
    "a .chernabog/ that needs a newer chernabog is refused, before its config is read",
    () =>
      Effect.gen(function* () {
        const loaded = yield* load({
          "package.json": '{ "engines": { "chernabog": ">=99.0.0" } }',
          "config.yaml": "notAKey: true\n",
        });

        expect(Result.isFailure(loaded) && loaded.failure.message).toBe(
          `.chernabog/ needs chernabog 99.0.0 or newer, and this is ${VERSION}; upgrade chernabog`,
        );
      }),
  );

  effectAtHome("engines.chernabog must be a floor", () =>
    Effect.gen(function* () {
      const loaded = yield* load({ "package.json": '{ "engines": { "chernabog": "garbage" } }' });
      expect(Result.isFailure(loaded) && loaded.failure.message).toContain(
        "it must be a floor such as",
      );
    }),
  );

  effectAtHome("a key this binary does not know fails the repo instead of being dropped", () =>
    Effect.gen(function* () {
      const loaded = yield* load({
        "package.json": `{ "engines": { "chernabog": ">=${VERSION}" } }`,
        "config.yaml": "limits:\n  ciRounds: 2\n  futureLimit: 1\n",
      });

      expect(Result.isFailure(loaded) && loaded.failure.message).toContain(
        '["limits"]["futureLimit"]',
      );
    }),
  );

  effectAtHome("a .chernabog/ without a floor loads on any binary", () =>
    Effect.gen(function* () {
      const loaded = yield* load({ "config.yaml": "baseBranch: develop\n" });
      expect(Result.isSuccess(loaded) && loaded.success.settings.baseBranch).toBe("develop");
    }),
  );
});

describe("GitHub personas", () => {
  type Logins = Readonly<Record<string, object>>;

  const machineWith = (github: Option.Option<Logins>) =>
    normalizeMachineConfig(
      Schema.decodeSync(MachineConfigFile)({
        ...Option.match(github, { onNone: () => ({}), onSome: (logins) => ({ github: logins }) }),
        repos: [],
      }),
      "/Users/dev",
    );

  const personas = (
    github: Option.Option<Logins>,
    chosen: Option.Option<ReadonlyArray<string>> = Option.none(),
  ) =>
    Effect.result(
      personasOf(machineWith(github), {
        ...enrolled,
        ...Option.match(chosen, {
          onNone: () => ({}),
          onSome: (logins) => ({
            personas: Object.fromEntries(logins.map((login) => [login, {}])),
          }),
        }),
      }),
    );

  effect("without github:, the one persona is the implicit one", () =>
    Effect.gen(function* () {
      expect(yield* personas(Option.none())).toEqual(Result.succeed([Option.none()]));
    }),
  );

  effect("personas without github: is refused", () =>
    Effect.gen(function* () {
      const chosen = yield* personas(Option.none(), Option.some(["alice"]));
      expect(Result.isFailure(chosen) && chosen.failure.message).toContain(
        "machine config has no github:",
      );
    }),
  );

  effect("one login under github: is the default", () =>
    Effect.gen(function* () {
      expect(yield* personas(Option.some({ alice: {} }))).toEqual(
        Result.succeed([Option.some("alice")]),
      );
    }),
  );

  effect("several logins need the repo to choose", () =>
    Effect.gen(function* () {
      const unchosen = yield* personas(Option.some({ alice: {}, bob: {} }));
      expect(Result.isFailure(unchosen) && unchosen.failure.message).toContain(
        "choose this repo's with personas:",
      );
      expect(
        yield* personas(Option.some({ alice: {}, bob: {} }), Option.some(["bob", "alice"])),
      ).toEqual(Result.succeed([Option.some("bob"), Option.some("alice")]));
    }),
  );

  effect("a persona must be one of github:'s logins", () =>
    Effect.gen(function* () {
      const chosen = yield* personas(Option.some({ alice: {} }), Option.some(["alice", "mallory"]));
      expect(Result.isFailure(chosen) && chosen.failure.message).toContain(
        "personas mallory not listed under github:",
      );
    }),
  );

  effect("the merged repo carries its personas", () =>
    Effect.gen(function* () {
      const merged = yield* mergeAll({}, { personas: { bob: {} } }, enrolled, {
        ...machine,
        github: ["alice", "bob"],
      });

      expect(merged.personas.map((own) => own.persona)).toEqual([Option.some("bob")]);
    }),
  );

  effect("personas: {} is refused", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        mergeAll({}, { personas: {} }, enrolled, { ...machine, github: ["alice"] }),
      );

      expect(error.message).toContain("personas is empty");
    }),
  );
});

// The enrollment use-cases over machine config as it's stored.
const setFlow = (...args: Parameters<typeof setPersonaFlowUseCase>) =>
  setPersonaFlowUseCase(...args).pipe(Effect.provide(EnrolledReposRepositoryLive));

const setSchedule = (...args: Parameters<typeof setFlowScheduleUseCase>) =>
  setFlowScheduleUseCase(...args).pipe(Effect.provide(EnrolledReposRepositoryLive));

const OFFERED = {
  personas: [],
  accounts: [
    { name: "work", agent: "claude" },
    { name: "personal", agent: "claude" },
    { name: "codex", agent: "codex" },
  ],
};

const setAccount = (
  name: string,
  persona: Option.Option<string>,
  role: Option.Option<string>,
  account: Option.Option<string>,
) =>
  setPersonaAccountUseCase(name, persona, role, account, OFFERED).pipe(
    Effect.provide(EnrolledReposRepositoryLive),
  );

describe("turning a flow on or off in machine config", () => {
  const read = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const decoded = yield* Schema.decodeUnknownEffect(MachineConfigFile)(
      YAML.parse(yield* fs.readFileString(yield* machineConfigFile)),
    );

    return (decoded.repos ?? [])[0];
  });

  const write = (text: string) =>
    Effect.flatMap(machineConfigFile, (file) =>
      FileSystem.FileSystem.use((fs) => fs.writeFileString(file, text)),
    );

  effectAtHome("turns a flow off on the repo's entry, keeping its settings, and on again", () =>
    Effect.gen(function* () {
      yield* write(
        'repos:\n  - repo: dataquail/demo\n    path: /demo\n    flows:\n      implement: {}\n      review: { schedule: "5 * * * *" }\n',
      );
      yield* setFlow("demo", Option.none(), "implement", false);
      yield* setFlow("demo", Option.none(), "review", false);
      yield* setFlow("demo", Option.none(), "fix", true);
      expect((yield* read).flows).toEqual({
        review: { schedule: "5 * * * *", enabled: false },
        fix: {},
      });
      yield* setFlow("demo", Option.none(), "review", true);
      expect((yield* read).flows?.review).toEqual({ schedule: "5 * * * *" });
    }),
  );

  effectAtHome(
    "gives one of several personas its own copy of the flows it inherits before changing them",
    () =>
      Effect.gen(function* () {
        yield* write(
          "github: { alice: {}, bob: {} }\nrepos:\n  - repo: dataquail/demo\n    path: /demo\n    flows: { implement: {} }\n    personas: { alice: {}, bob: {} }\n",
        );
        yield* setFlow("dataquail/demo", Option.some("bob"), "review", true);
        const entry = yield* read;
        expect(entry.flows).toEqual({ implement: {} });
        expect(entry.personas).toEqual({
          alice: {},
          bob: { flows: { implement: {}, review: {} } },
        });
      }),
  );
});

describe("overriding schedules and accounts in machine config", () => {
  const text = Effect.flatMap(machineConfigFile, (file) =>
    FileSystem.FileSystem.use((fs) => fs.readFileString(file)),
  );

  const write = (written: string) =>
    Effect.flatMap(machineConfigFile, (file) =>
      FileSystem.FileSystem.use((fs) => fs.writeFileString(file, written)),
    );

  const entry = Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(MachineConfigFile)(YAML.parse(yield* text));

    return (decoded.repos ?? [])[0];
  });

  const BASE =
    "accounts:\n  work: {}\n  personal: {}\n  codex: { agent: codex }\nrepos:\n  - repo: dataquail/demo\n    path: /demo\n    # the flows I run\n    flows:\n      implement: {}\n";

  effectAtHome("overrides a flow's schedule, and clearing it brings back the team's", () =>
    Effect.gen(function* () {
      yield* write(BASE);
      yield* setSchedule("demo", Option.none(), "implement", Option.some("*/20 * * * *"));
      yield* setSchedule("demo", Option.none(), "review", Option.some("5 * * * *"));
      expect((yield* entry).flows).toEqual({
        implement: { schedule: "*/20 * * * *" },
        review: { enabled: false, schedule: "5 * * * *" },
      });
      expect(yield* text).toContain("# the flows I run");

      yield* setSchedule("demo", Option.none(), "implement", Option.none());
      expect((yield* entry).flows?.implement).toEqual({});
    }),
  );

  effectAtHome("an invalid schedule is refused with the reason, and nothing is written", () =>
    Effect.gen(function* () {
      yield* write(BASE);

      const refused = yield* Effect.flip(
        setSchedule("demo", Option.none(), "implement", Option.some("every hour")),
      );

      expect(refused.message).toContain('"every hour" isn\'t a schedule');
      expect(yield* text).toBe(BASE);
    }),
  );

  effectAtHome(
    "picks a persona's account and a role's, refuses ones that clash, and clears them",
    () =>
      Effect.gen(function* () {
        yield* write(BASE);
        yield* setAccount("demo", Option.none(), Option.none(), Option.some("personal"));
        yield* setAccount("demo", Option.none(), Option.some("reviewer"), Option.some("codex"));
        expect(yield* entry).toMatchObject({ account: "personal", roles: { reviewer: "codex" } });

        const clash = yield* Effect.flip(
          setAccount("demo", Option.none(), Option.some("author"), Option.some("work")),
        );

        expect(clash.message).toContain("a claude account like the persona's own (personal)");
        expect((yield* entry).roles).toEqual({ reviewer: "codex" });

        const unknown = yield* Effect.flip(
          setAccount("demo", Option.none(), Option.none(), Option.some("nope")),
        );

        expect(unknown.message).toContain('account "nope" is not one of work, personal, codex');

        yield* setAccount("demo", Option.none(), Option.some("reviewer"), Option.none());
        yield* setAccount("demo", Option.none(), Option.none(), Option.none());
        const cleared = yield* entry;
        expect(cleared.account).toBeUndefined();
        expect(cleared.roles).toBeUndefined();
      }),
  );
});

describe("path rules and prompts", () => {
  test("globs match directories, nested files and exact names", () => {
    expect(
      pathsMatching(
        [".github/workflows/ci.yml", "src/.github.ts", "RELEASE.md", "packages/a/package.json"],
        [".github/**", "RELEASE.md", "**/package.json"],
      ),
    ).toEqual([".github/workflows/ci.yml", "RELEASE.md", "packages/a/package.json"]);
    expect(globToRegExp(".github/").test(".github/CODEOWNERS")).toBe(true);
    expect(globToRegExp("*.md").test("docs/a.md")).toBe(false);
  });

  test("prompt placeholders fill with values, and lists render as bullets", () => {
    expect(
      fillTemplate("#{{issue}}: {{ title }}\n{{notes}}\n{{empty}}\n{{unknown}}", {
        issue: 7,
        title: "Fix",
        notes: ["a", "b"],
        empty: [],
      }),
    ).toBe("#7: Fix\n- a\n- b\n- none\n{{unknown}}");
  });
});
