import { createVerify, generateKeyPairSync } from "node:crypto";

import { expect } from "bun:test";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../test/effect-test.ts";
import { HostEnvironment } from "./environment.ts";
import { Exec, execOk, type ExecOptions, execTestLayer } from "./exec.ts";
import { gitCredentialEnv, GitHubTokens } from "./github-auth.ts";
import {
  appJwt,
  EXPIRY_MARGIN,
  refreshBefore,
  type TokenSource,
  TokenSources,
} from "./github-token-source.ts";

type Call = { readonly args: ReadonlyArray<string>; readonly options: ExecOptions };

type Posted = { readonly url: string; readonly authorization: string };

// An API that answers every installation token request with one that expires in an hour.
const fakeApi = (posted: Array<Posted>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      posted.push({ url: request.url, authorization: request.headers.authorization });
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ token: "ghs_installation", expires_at: expiresAt }), {
            status: 201,
          }),
        ),
      );
    }),
  );

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

// gh answers token-<login> for --user, and remembers how it was asked.
const tokensWith = (calls: Array<Call>, posted: Array<Posted> = []) =>
  GitHubTokens.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        fakeApi(posted),
        HostEnvironment.fixed({
          PATH: "/usr/bin",
          GH_TOKEN: "ambient",
          GITHUB_TOKEN: "ambient",
          CHERNABOG_TOKEN: "from-env",
        }),
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

const tokensWithSources = (
  sources: Readonly<Record<string, TokenSource>>,
  calls: Array<Call>,
  posted: Array<Posted>,
) =>
  Effect.provide(
    GitHubTokens.use(Effect.succeed),
    tokensWith(calls, posted).pipe(
      Layer.provide(
        Layer.succeed(
          TokenSources,
          TokenSources.of({
            sourceOf: (login) => Effect.succeed(sources[login] ?? { kind: "gh" }),
          }),
        ),
      ),
    ),
  );

const APP: TokenSource = {
  kind: "app",
  id: "123",
  installation: "456",
  privateKey: PRIVATE_KEY,
};

effect("an App persona's token is an installation token, asked for with a JWT the App signs", () =>
  Effect.gen(function* () {
    const calls: Array<Call> = [];
    const posted: Array<Posted> = [];
    const tokens = yield* tokensWithSources({ "chernabog-author[bot]": APP }, calls, posted);

    expect(yield* tokens.token(Option.some("chernabog-author[bot]"))).toBe("ghs_installation");
    yield* tokens.token(Option.some("chernabog-author[bot]"));
    expect(calls).toEqual([]);
    expect(posted.map((post) => post.url)).toEqual([
      "https://api.github.com/app/installations/456/access_tokens",
    ]);

    const jwt = posted[0]?.authorization.replace(/^Bearer /, "") ?? "";
    const [header = "", payload = "", signature = ""] = jwt.split(".");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(keys.publicKey, Buffer.from(signature, "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({ iss: "123" });

    expect(yield* tokens.env(Option.some("chernabog-author[bot]"))).toEqual({
      GH_TOKEN: "ghs_installation",
      GITHUB_TOKEN: "ghs_installation",
      ...gitCredentialEnv,
    });
  }),
);

effect("an env persona's token is its variable's, and a missing one says which", () =>
  Effect.gen(function* () {
    const calls: Array<Call> = [];

    const tokens = yield* tokensWithSources(
      {
        ci: { kind: "env", variable: "CHERNABOG_TOKEN" },
        gone: { kind: "env", variable: "NOT_SET" },
      },
      calls,
      [],
    );

    expect(yield* tokens.token(Option.some("ci"))).toBe("from-env");
    const missing = yield* Effect.flip(tokens.token(Option.some("gone")));
    expect(missing.message).toContain("$NOT_SET");
    expect(calls).toEqual([]);
  }),
);

effect("a persona without a source of its own still comes from gh", () =>
  Effect.gen(function* () {
    const calls: Array<Call> = [];
    const tokens = yield* tokensWithSources({}, calls, []);

    expect(yield* tokens.token(Option.some("alice"))).toBe("token-alice");
    expect(calls.length).toBe(1);
  }),
);

effect("an installation token is made again a few minutes before its hour is up", () =>
  Effect.sync(() => {
    const now = DateTime.makeUnsafe("2026-11-11T12:00:00Z");

    expect(Duration.toMillis(refreshBefore(now, DateTime.makeUnsafe("2026-11-11T13:00:00Z")))).toBe(
      Duration.toMillis(Duration.minutes(60)) - Duration.toMillis(EXPIRY_MARGIN),
    );
    expect(Duration.toMillis(refreshBefore(now, DateTime.makeUnsafe("2026-11-11T12:01:00Z")))).toBe(
      10_000,
    );
  }),
);

effect("an App's JWT was issued a minute ago and lasts under GitHub's ten minutes", () =>
  Effect.sync(() => {
    const payload = appJwt("9", PRIVATE_KEY, 1_000_000).split(".")[1] ?? "";

    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({
      iat: 999_940,
      exp: 1_000_540,
      iss: "9",
    });
  }),
);

effect("a persona's token comes from gh's login for it, never from GH_TOKEN", () =>
  Effect.gen(function* () {
    const calls: Array<Call> = [];
    const tokens = yield* tokensFrom(calls);

    expect(yield* tokens.token(Option.some("alice"))).toBe("token-alice");
    expect(calls.map((call) => call.args)).toEqual([
      ["auth", "token", "--hostname", "github.com", "--user", "alice"],
    ]);
    expect(calls[0]?.options.env).toEqual({ PATH: "/usr/bin", CHERNABOG_TOKEN: "from-env" });
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
