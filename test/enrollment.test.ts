import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import YAML from "yaml";

import { Asker } from "../src/interface/cli/asker.prompt.ts";
import {
  enrollCheckout,
  type EnrollFlags,
} from "../src/interface/cli/enrollment/enroll.command.ts";
import { type SetupFlags, setUpMachine } from "../src/interface/cli/machine/setup.command.ts";
import { EnrollmentCommandsLive } from "../src/modules/enrollment/enrollment.command-handlers.ts";
import { EnrollmentLayer } from "../src/modules/enrollment/enrollment.layer.ts";
import { EnrollmentQueriesLive } from "../src/modules/enrollment/enrollment.query-handlers.ts";
import { MachineLayer } from "../src/modules/machine/machine.layer.ts";
import { execTestLayer } from "../src/platform/exec.ts";
import { GitHubApi } from "../src/platform/github-api.ts";
import { Home } from "../src/platform/home.ts";
import { MachineConfigFile, machineConfigFile } from "../src/repo-config.ts";
import { scripted } from "./asker.ts";
import { effectAtHomeWith } from "./effect-test.ts";

// git answers for a checkout of dataquail/demo wherever it is, and gh is logged in to `logins`.
const fakes = (logins: ReadonlyArray<string>) =>
  Layer.mergeAll(
    execTestLayer((command, args) => {
      if (command === "git" && args.includes("--show-toplevel")) {
        return Option.some({ exitCode: 0, stdout: `${args[1]}\n`, stderr: "" });
      }

      if (command === "git" && args.includes("get-url")) {
        return Option.some({
          exitCode: 0,
          stdout: "git@github.com:dataquail/demo.git\n",
          stderr: "",
        });
      }

      if (command === "git" && args.includes("symbolic-ref")) {
        return Option.some({ exitCode: 0, stdout: "origin/main\n", stderr: "" });
      }

      if (command === "gh" && args[1] === "status") {
        return Option.some({
          exitCode: 0,
          stdout: `github.com\n${logins.map((login) => `  ✓ Logged in to github.com account ${login} (keyring)\n  - Active account: true\n`).join("")}`,
          stderr: "",
        });
      }

      return Option.none();
    }),
    // Who the implicit persona is, when the team names runners.
    Layer.succeed(
      GitHubApi,
      GitHubApi.of({
        request: () =>
          Effect.succeed({
            status: 200,
            body: Option.some({ login: "carol" }),
            nextUrl: Option.none(),
            headers: {},
          }),
      }),
    ),
  );

const effect = effectAtHomeWith(fakes(["alice"]));
const effectWithLogins = effectAtHomeWith(fakes(["alice", "bob"]));

type EnrollOptions = {
  readonly account: Option.Option<ReadonlyArray<string>>;
  readonly name: Option.Option<string>;
  readonly personas: Option.Option<ReadonlyArray<string>>;
  readonly flows: Option.Option<ReadonlyArray<string>>;
  readonly defaults: boolean;
};

// enroll's flags, by what they choose.
const options = (given: Partial<EnrollOptions> = {}): EnrollFlags => {
  const { personas, ...rest } = {
    account: Option.none(),
    name: Option.none(),
    personas: Option.none(),
    flows: Option.none(),
    defaults: false,
    ...given,
  };

  return { ...rest, persona: personas };
};

const writeMachine = (config: typeof MachineConfigFile.Encoded) =>
  Effect.flatMap(machineConfigFile, (file) =>
    FileSystem.FileSystem.use((fs) => fs.writeFileString(file, YAML.stringify(config))),
  );

const readMachine = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  return yield* Schema.decodeUnknownEffect(MachineConfigFile)(
    YAML.parse(yield* fs.readFileString(yield* machineConfigFile)),
  );
});

const entry = Effect.map(readMachine, (machine) => (machine.repos ?? [])[0]);

// The accounts as written, before decoding turns their settings into Options.
const writtenAccounts = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(yield* machineConfigFile);

  return yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      accounts: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
    }),
  )(YAML.parse(text));
}).pipe(Effect.map((written) => written.accounts));

// A checkout of its own flows, fix, implement and review, and this team
// config. Enrolling reads only the flows' names, so they're stubs, which keeps
// these tests to the choices rather than to whichever flows the scaffold has.
const checkout = (teamConfig: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-enroll-" });
    yield* fs.makeDirectory(`${root}/.chernabog/flows`, { recursive: true });

    for (const flow of ["fix", "implement", "review"]) {
      yield* fs.writeFileString(`${root}/.chernabog/flows/${flow}.ts`, "export default {};\n");
    }

    yield* fs.writeFileString(`${root}/.chernabog/config.yaml`, teamConfig);

    return root;
  });

// Enrolling, or setting up, with these answers: a script of them, or no one to ask.
const enrollAnswering = (layer: Layer.Layer<Asker>, root: string, given: EnrollFlags) =>
  enrollCheckout(root, given).pipe(
    Effect.provide(
      Layer.mergeAll(
        layer,
        Layer.fresh(EnrollmentLayer),
        Layer.fresh(EnrollmentCommandsLive),
        Layer.fresh(EnrollmentQueriesLive),
        Layer.fresh(MachineLayer),
      ),
    ),
  );

const setupAnswering = (layer: Layer.Layer<Asker>, given: SetupFlags) =>
  setUpMachine(given).pipe(
    Effect.provide(
      Layer.mergeAll(
        layer,
        Layer.fresh(MachineLayer),
        Layer.fresh(EnrollmentLayer),
        Layer.fresh(EnrollmentCommandsLive),
        Layer.fresh(EnrollmentQueriesLive),
      ),
    ),
  );

const TEAM = "flows:\n  fix:\n    enabled: false\n";

describe("enrolling a repo", () => {
  effect("with one persona and one account, it asks only to confirm the flows", () =>
    Effect.gen(function* () {
      yield* writeMachine({ github: { alice: {} } });
      const root = yield* checkout(TEAM);
      const answers = scripted(["defaults"]);
      const { lines } = yield* enrollAnswering(answers.layer, root, options());

      expect(answers.asked.map((question) => question.message)).toEqual(["Flows for alice"]);
      expect(answers.asked[0].choices[0].title).toBe("Accept the defaults (implement, review)");
      expect((yield* entry).flows).toEqual({ implement: {}, review: {} });
      expect(lines).toEqual(["demo as alice: flows implement, review"]);
    }),
  );

  effectWithLogins(
    "says nothing of the reviewer pool, whatever the flows are named: doctor asks the repo's flows",
    () =>
      Effect.gen(function* () {
        yield* writeMachine({ github: { alice: {} } });
        const root = yield* checkout(`${TEAM}reviewers: [alice, bob]\n`);

        const { lines } = yield* enrollAnswering(
          Asker.none,
          root,
          options({ flows: Option.some(["implement"]) }),
        );

        expect(lines).toEqual(["demo as alice: flows implement"]);
      }),
  );

  effectWithLogins("with several personas, each chosen one gets its own checklist", () =>
    Effect.gen(function* () {
      yield* writeMachine({ github: { alice: {}, bob: {} } });
      const root = yield* checkout(TEAM);
      const answers = scripted([["alice", "bob"], "defaults", "choose", ["fix"]]);
      yield* enrollAnswering(answers.layer, root, options());

      expect(answers.asked.map((question) => question.message)).toEqual([
        "Which GitHub personas work in this repo?",
        "Flows for alice",
        "Flows for bob",
        "Which flows should run as bob?",
      ]);
      expect((yield* entry).personas).toEqual({
        alice: { flows: { implement: {}, review: {} } },
        bob: { flows: { fix: {} } },
      });
    }),
  );

  effect("accepting the defaults turns on exactly the team's, runners included", () =>
    Effect.gen(function* () {
      const root = yield* checkout(
        "flows:\n  fix:\n    enabled: false\n  review:\n    runners: [bob]\n",
      );

      const answers = scripted(["defaults"]);
      yield* enrollAnswering(answers.layer, root, options());

      // Without github:, the implicit persona is carol, who isn't one of review's runners.
      expect(answers.asked[0].choices[0].title).toBe("Accept the defaults (implement)");
      expect((yield* entry).flows).toEqual({ implement: {} });
      expect((yield* entry).personas).toBeUndefined();
    }),
  );

  effect(
    "a flow needing an agent with no account can't be turned on, and says how to fix that",
    () =>
      Effect.gen(function* () {
        const root = yield* checkout("flows:\n  review:\n    agent: codex\n");
        const answers = scripted(["choose", ["implement", "review"]]);
        yield* enrollAnswering(answers.layer, root, options());

        const review = answers.asked[1].choices.find((choice) => choice.value === "review");
        expect(review).toEqual({
          title: "review",
          value: "review",
          selected: false,
          disabled: true,
          description: "needs codex; add an account for each with chernabog setup",
        });
        expect(answers.asked[0].choices[0].title).toBe("Accept the defaults (fix, implement)");
        expect((yield* entry).flows).toEqual({ implement: {} });

        const flagged = yield* Effect.flip(
          enrollAnswering(Asker.none, root, options({ flows: Option.some(["review"]) })),
        );

        expect(flagged.message).toBe(
          "review can't run here: it needs codex; add an account for each with chernabog setup",
        );
      }),
  );

  effect(
    "asks which account where there is a choice, for the persona and for each other agent its flows need",
    () =>
      Effect.gen(function* () {
        yield* writeMachine({
          accounts: {
            work: {},
            personal: { configDir: "~/.claude-personal" },
            codex: { agent: "codex" },
            "codex-work": { agent: "codex" },
          },
        });

        const root = yield* checkout(
          "flows:\n  fix:\n    enabled: false\n  review:\n    agent: codex\n",
        );

        const answers = scripted(["defaults", "personal", "codex-work"]);
        const { lines } = yield* enrollAnswering(answers.layer, root, options());

        expect(answers.asked.map((question) => question.message)).toEqual([
          "Flows for this machine",
          "Which account should this machine's runs spend?",
          "Which codex account should this machine's codex steps spend?",
        ]);
        const enrolled = yield* entry;
        expect(enrolled.account).toBe("personal");
        expect(enrolled.accounts).toEqual(["codex-work"]);
        expect(lines).toEqual([
          "demo as this machine: flows implement, review; account personal, codex-work",
        ]);
      }),
  );

  effectWithLogins("every choice has a flag, so nothing is asked", () =>
    Effect.gen(function* () {
      yield* writeMachine({ github: { alice: {}, bob: {} }, accounts: { work: {}, personal: {} } });
      const root = yield* checkout(TEAM);
      yield* enrollAnswering(
        Asker.none,
        root,
        options({
          personas: Option.some(["bob"]),
          flows: Option.some(["fix"]),
          account: Option.some(["personal"]),
        }),
      );
      expect((yield* entry).personas).toEqual({ bob: { flows: { fix: {} }, account: "personal" } });

      yield* enrollAnswering(
        Asker.none,
        root,
        options({ personas: Option.some(["alice", "bob"]), defaults: true }),
      );
      // Choices made before stay unless a flag changes them.
      expect((yield* entry).personas).toEqual({
        alice: { flows: { implement: {}, review: {} }, account: "work" },
        bob: { flows: { implement: {}, review: {} }, account: "personal" },
      });

      const unchosen = yield* Effect.flip(
        enrollAnswering(Asker.none, yield* checkout(TEAM), options({ name: Option.some("other") })),
      );

      expect(unchosen.message).toContain("choose this repo's with --persona");
    }),
  );

  effect("re-enrolling keeps a listed flow's settings", () =>
    Effect.gen(function* () {
      const root = yield* checkout(TEAM);
      yield* writeMachine({
        repos: [
          { repo: "dataquail/demo", path: root, flows: { implement: { schedule: "5 * * * *" } } },
        ],
      });
      yield* enrollAnswering(Asker.none, root, options());
      expect((yield* entry).flows).toEqual({ implement: { schedule: "5 * * * *" } });
      yield* enrollAnswering(Asker.none, root, options({ defaults: true }));
      expect((yield* entry).flows).toEqual({ implement: { schedule: "5 * * * *" }, review: {} });
    }),
  );
});

describe("setting up a machine", () => {
  const homeDirs = (names: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* Home;

      for (const name of names) {
        yield* fs.makeDirectory(`${home.user}/${name}`, { recursive: true });
      }

      return home.user;
    });

  effect("one GitHub login and one account found are chosen without asking", () =>
    Effect.gen(function* () {
      yield* homeDirs([".codex", "code"]);

      const lines = yield* setupAnswering(Asker.none, {
        persona: Option.none(),
        account: Option.none(),
      });

      const machine = yield* readMachine;

      expect(machine.github).toEqual({ alice: {} });
      // The default work account (~/.claude) stays, so repos that name it keep it.
      expect(yield* writtenAccounts).toEqual({
        work: {},
        codex: { configDir: "~/.codex", agent: "codex" },
      });
      expect(lines).toEqual([
        "GitHub personas: alice",
        "AI accounts added: codex (~/.codex, codex)",
      ]);
    }),
  );

  effect(
    "the only gh login is added without dropping the others, and opencode isn't looked for in the home directory",
    () =>
      Effect.gen(function* () {
        yield* homeDirs([".opencode"]);
        yield* writeMachine({ github: { bob: {} }, accounts: { work: {} } });

        const lines = yield* setupAnswering(Asker.none, {
          persona: Option.none(),
          account: Option.none(),
        });

        expect((yield* readMachine).github).toEqual({ bob: {}, alice: {} });
        expect(lines).toEqual(["GitHub personas: bob, alice", "AI accounts added: none"]);
      }),
  );

  effectWithLogins(
    "asks which logins and accounts to use, and about accounts it did not find",
    () =>
      Effect.gen(function* () {
        const home = yield* homeDirs([
          ".claude",
          ".claude-personal",
          ".codex",
          "elsewhere/.work-claude",
        ]);

        yield* writeMachine({ accounts: { work: {} } });

        const answers = scripted([
          ["bob"],
          [`${home}/.claude-personal`],
          "~/elsewhere/.work-claude",
          "claude",
          "",
        ]);

        yield* setupAnswering(answers.layer, { persona: Option.none(), account: Option.none() });
        const machine = yield* readMachine;

        expect(answers.asked[1].choices.map((choice) => choice.title)).toEqual([
          "~/.claude-personal",
          "~/.codex",
        ]);
        expect(machine.github).toEqual({ bob: {} });
        expect(yield* writtenAccounts).toEqual({
          work: {},
          "claude-personal": { configDir: "~/.claude-personal" },
          "work-claude": { configDir: "~/elsewhere/.work-claude" },
        });
      }),
  );

  effectWithLogins("flags choose without asking, and a login an enrolled repo runs as stays", () =>
    Effect.gen(function* () {
      yield* homeDirs([".claude-personal"]);
      yield* writeMachine({
        github: { alice: {}, bob: {} },
        repos: [{ repo: "dataquail/demo", path: "/demo", personas: { bob: {} } }],
      });

      const dropped = yield* Effect.flip(
        setupAnswering(Asker.none, { persona: Option.some(["alice"]), account: Option.none() }),
      );

      expect(dropped.message).toBe(
        "enrolled repos still run as bob; keep those personas, or chernabog unenroll the repos first",
      );

      yield* setupAnswering(Asker.none, {
        persona: Option.some(["bob"]),
        account: Option.some(["~/.claude-personal"]),
      });
      const machine = yield* readMachine;
      expect(machine.github).toEqual({ bob: {} });
      expect(Object.keys(machine.accounts ?? {})).toEqual(["work", "claude-personal"]);

      const unknown = yield* Effect.flip(
        setupAnswering(Asker.none, { persona: Option.some(["mallory"]), account: Option.none() }),
      );

      expect(unknown.message).toContain("gh isn't logged in to github.com as mallory");
    }),
  );
});
