import { expect } from "bun:test";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../test/effect-test.ts";
import { HostEnvironment } from "./environment.ts";
import { Exec, execOk, type ExecOptions, execTestLayer } from "./exec.ts";
import { gitCredentialEnv, GitHubTokens } from "./github-auth.ts";

type Call = { readonly args: ReadonlyArray<string>; readonly options: ExecOptions };

// gh answers token-<login> for --user, and remembers how it was asked.
const tokensWith = (calls: Array<Call>) =>
  GitHubTokens.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        HostEnvironment.fixed({ PATH: "/usr/bin", GH_TOKEN: "ambient", GITHUB_TOKEN: "ambient" }),
        execTestLayer((command, args, options) => {
          if (command !== "gh") {
            return Option.none();
          }

          calls.push({ args, options });

          return Option.some({ exitCode: 0, stdout: `token-${args.at(-1) ?? ""}\n`, stderr: "" });
        }),
      ),
    ),
  );

const tokensFrom = (calls: Array<Call>) =>
  Effect.provide(GitHubTokens.use(Effect.succeed), tokensWith(calls));

effect("a persona's token comes from gh's login for it, never from GH_TOKEN", () =>
  Effect.gen(function* () {
    const calls: Array<Call> = [];
    const tokens = yield* tokensFrom(calls);

    expect(yield* tokens.token(Option.some("alice"))).toBe("token-alice");
    expect(calls.map((call) => call.args)).toEqual([
      ["auth", "token", "--hostname", "github.com", "--user", "alice"],
    ]);
    expect(calls[0]?.options.env).toEqual({ PATH: "/usr/bin" });
  }),
);

effect("each persona's token is looked up once, then cached", () =>
  Effect.gen(function* () {
    const calls: Array<Call> = [];
    const tokens = yield* tokensFrom(calls);

    yield* tokens.token(Option.some("alice"));
    yield* tokens.token(Option.some("alice"));
    expect(yield* tokens.token(Option.some("bob"))).toBe("token-bob");
    expect(calls.length).toBe(2);
  }),
);

effect(
  "a persona's environment carries its token for gh and git; the implicit persona's adds nothing",
  () =>
    Effect.gen(function* () {
      const tokens = yield* tokensFrom([]);

      expect(yield* tokens.env(Option.none())).toEqual({});
      expect(yield* tokens.env(Option.some("alice"))).toEqual({
        GH_TOKEN: "token-alice",
        GITHUB_TOKEN: "token-alice",
        ...gitCredentialEnv,
      });
    }),
);

effect(
  "with the credential environment, git answers github.com with $GH_TOKEN over the repo's own helper",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-git-" });

      const env = {
        PATH: yield* Config.String("PATH").pipe(Config.withDefault("/usr/bin:/bin")),
        HOME: home,
        GIT_TERMINAL_PROMPT: "0",
      };

      const git = (args: ReadonlyArray<string>, options: ExecOptions = {}) =>
        execOk("git", args, { cwd: home, ...options, env: { ...env, ...options.env } });

      yield* git(["init", "-q"]);
      yield* git([
        "config",
        "credential.helper",
        "!f() { echo username=wrong; echo password=WRONG; }; f",
      ]);

      const answer = yield* git(["credential", "fill"], {
        env: { ...gitCredentialEnv, GH_TOKEN: "token-alice" },
        stdin: "protocol=https\nhost=github.com\n\n",
      });

      expect(answer).toContain("username=x-access-token");
      expect(answer).toContain("password=token-alice");
      expect(answer).not.toContain("WRONG");
    }).pipe(Effect.provide(Exec.layer)),
);
