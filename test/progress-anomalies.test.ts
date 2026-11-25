// `chernabog progress anomalies` on an enrolled checkout: the repo's own SDK's
// Ledger, loaded from its .chernabog/, run as the repo's persona, and reported
// with the repo it's for.

import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { printJson } from "../packages/core/src/json.ts";
import { type Anomaly, progressAnomalies } from "../src/modules/runs/runs.platform.ts";
import { Exec } from "../src/platform/exec.ts";
import { BUNDLED_CORE } from "../src/platform/flow-deps.ts";
import { GitHubTokens } from "../src/platform/github-auth.ts";
import { EnrolledRepo, MachineConfigFile, normalizeMachineConfig } from "../src/repo-config.ts";
import { effectAtHomeWith } from "./effect-test.ts";

// The ledger stands in for GitHub, so a request that reaches it is a defect.
const noGitHub = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => Effect.die(`no request reaches GitHub here: ${request.url}`)),
);

const effectWithGit = effectAtHomeWith(
  Layer.mergeAll(Exec.layer, GitHubTokens.fixed("test-token"), noGitHub),
);

// A checkout whose team names two personas, and whose .chernabog/ has
// installed an SDK whose Ledger lists `anomaly` and acknowledges nothing.
const checkoutListing = (anomaly: Anomaly) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-anomalies-" });
    const sdk = `${path}/.chernabog/node_modules/@chernabog/sdk`;
    yield* fs.makeDirectory(sdk, { recursive: true });
    yield* fs.writeFileString(
      `${path}/.chernabog/package.json`,
      printJson({
        dependencies: { "@chernabog/sdk": "9.9.9" },
        devDependencies: { "@chernabog/core": BUNDLED_CORE },
      }),
    );
    yield* fs.writeFileString(`${path}/.chernabog/config.yaml`, "personas: [data-quail, bob]\n");
    yield* fs.writeFileString(
      `${sdk}/package.json`,
      printJson({
        name: "@chernabog/sdk",
        version: "9.9.9",
        peerDependencies: { "@chernabog/core": `^${BUNDLED_CORE}` },
      }),
    );
    yield* fs.writeFileString(
      `${sdk}/index.ts`,
      [
        'import * as Effect from "effect/Effect";',
        `export const Ledger = { survey: Effect.succeed([${printJson(anomaly)}]), acknowledge: () => Effect.succeed([]) };`,
        "",
      ].join("\n"),
    );

    return path;
  });

describe("progress anomalies on an enrolled checkout", () => {
  effectWithGit(
    "lists what the repo's own ledger finds, with the repo and the personas its team names",
    () =>
      Effect.gen(function* () {
        const anomaly: Anomaly = {
          item: "pr-184",
          phase: "approved",
          from: "review-asked",
          by: "mallory",
          version: "9bf23c1d0e5f",
          why: "mallory isn't a writer of acme/app's",
        };

        const path = yield* checkoutListing(anomaly);

        const enrolled = yield* Schema.decodeEffect(EnrolledRepo)({
          path,
          repo: "acme/app",
        });

        const file = yield* Schema.decodeEffect(MachineConfigFile)({
          repos: [{ path, repo: "acme/app" }],
        });

        const machine = normalizeMachineConfig(file, "/home/dev");

        const result = yield* progressAnomalies({
          machine,
          enrolled,
          fromCheckout: true,
          acknowledge: [],
        });

        expect(result).toEqual({
          repo: "app",
          personas: ["data-quail", "bob"],
          anomalies: [anomaly],
          acknowledged: [],
          moved: [],
        });
      }),
  );
});
