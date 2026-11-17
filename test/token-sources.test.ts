// Each persona's token source as machine config's github: entry gives it (#477).

import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { Home, homePaths } from "../src/platform/home.ts";
import { tokenSourceOf } from "../src/repo-config.ts";
import { effectAtHome } from "./effect-test.ts";

const writeMachineConfig = (text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* Home;
    yield* fs.writeFileString(homePaths(home.root).machineConfig, text);

    return home;
  });

effectAtHome("a persona without token: comes from gh, as before", () =>
  Effect.gen(function* () {
    yield* writeMachineConfig("github:\n  alice: {}\n");

    expect(yield* tokenSourceOf("alice")).toEqual({ kind: "gh" });
    expect(yield* tokenSourceOf("not-listed")).toEqual({ kind: "gh" });
  }),
);

effectAtHome("a persona's token can come from a variable", () =>
  Effect.gen(function* () {
    yield* writeMachineConfig("github:\n  ci:\n    token: { env: CHERNABOG_TOKEN }\n");

    expect(yield* tokenSourceOf("ci")).toEqual({ kind: "env", variable: "CHERNABOG_TOKEN" });
  }),
);

effectAtHome("an App persona's key is read from the file it names, under the person's home", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const home = yield* writeMachineConfig(
      [
        "github:",
        "  chernabog-author[bot]:",
        "    token:",
        "      app: { id: 123, installation: 456, key: ~/author.pem }",
        "",
      ].join("\n"),
    );

    yield* fs.writeFileString(`${home.user}/author.pem`, "PEM");

    expect(yield* tokenSourceOf("chernabog-author[bot]")).toEqual({
      kind: "app",
      id: "123",
      installation: "456",
      privateKey: "PEM",
      repositories: [],
    });
  }),
);

effectAtHome("an App persona's token is narrowed to the repos it runs on this machine", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const home = yield* writeMachineConfig(
      [
        "github:",
        "  chernabog-author[bot]:",
        "    token:",
        "      app: { id: 123, installation: 456, key: ~/author.pem }",
        "  alice: {}",
        "repos:",
        "  - { path: ~/one, repo: acme/one, personas: { 'chernabog-author[bot]': {} } }",
        "  - { path: ~/two, repo: acme/two, personas: { alice: {} } }",
        "  - { path: ~/three, repo: acme/three, personas: { alice: {}, 'chernabog-author[bot]': {} } }",
        "  - { path: ~/again, repo: acme/one, personas: { 'chernabog-author[bot]': {} } }",
        "",
      ].join("\n"),
    );

    yield* fs.writeFileString(`${home.user}/author.pem`, "PEM");

    expect(yield* tokenSourceOf("chernabog-author[bot]")).toMatchObject({
      kind: "app",
      repositories: ["one", "three"],
    });
  }),
);

effectAtHome("machine config's only App persona runs, and reaches, every repo naming none", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const home = yield* writeMachineConfig(
      [
        "github:",
        "  bot:",
        "    token:",
        "      app: { id: 1, installation: 2, key: ~/bot.pem }",
        "repos:",
        "  - { path: ~/one, repo: acme/one }",
        "  - { path: ~/two, repo: acme/two }",
        "",
      ].join("\n"),
    );

    yield* fs.writeFileString(`${home.user}/bot.pem`, "PEM");

    expect(yield* tokenSourceOf("bot")).toMatchObject({ repositories: ["one", "two"] });
  }),
);

effectAtHome("an App persona whose key file is missing says which file", () =>
  Effect.gen(function* () {
    yield* writeMachineConfig(
      "github:\n  bot:\n    token:\n      app: { id: 1, installation: 2, key: /no/such.pem }\n",
    );

    const error = yield* Effect.flip(tokenSourceOf("bot"));
    expect(error.message).toContain("github.bot.token.app.key");
    expect(error.message).toContain("/no/such.pem");
  }),
);
