// A small npm registry for bun to install recipe packages from, so recipes
// run down the real path (bun add, bun info, .npmrc auth) with no network.
// @chernabog/recipes is packed from packages/recipes/, at 0.1.0 and at 0.2.0,
// which changes the implement recipe; @acme/recipes, a company's own
// package, answers only with its token. @chernabog/sdk and effect are stubs
// holding only their package.json: the loader always substitutes the
// binary's own copies, so nothing reads what's installed of them.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { type Json, printJson } from "@chernabog/sdk";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

import { EFFECT_VERSION } from "../../src/platform/effect-modules.ts";
import { BUNDLED_SDK } from "../../src/platform/flow-deps.ts";

const RECIPES = fileURLToPath(new URL("../../packages/recipes", import.meta.url));

export const ACME_TOKEN = "acme-secret";

// A line implement gains in @chernabog/recipes 0.2.0.
export const UPSTREAM_FIX = "// Fixed upstream in 0.2.0.\n";

type Release = {
  readonly manifest: Readonly<Record<string, Json>>;
  readonly files: Readonly<Record<string, string>>;
};

const filesUnder = (root: string, directory: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(join(root, directory)).flatMap((entry) => {
      const path = join(root, directory, entry);

      if (statSync(path).isDirectory()) {
        return Object.entries(filesUnder(root, join(directory, entry)));
      }

      return [[join(directory, entry), readFileSync(path, "utf8")]];
    }),
  );

const PackageJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));

const officialRecipes = (version: string, change: (files: Record<string, string>) => void) => {
  const manifest = {
    ...Schema.decodeSync(PackageJson)(readFileSync(join(RECIPES, "package.json"), "utf8")),
    version,
  };

  const files = { ...filesUnder(RECIPES, "flows"), ...filesUnder(RECIPES, "prompts") };
  change(files);

  return { manifest, files };
};

const stub = (name: string, version: string): Release => ({
  manifest: { name, version },
  files: {},
});

export const ACME_DEPLOY = `import { defineFlow, Implement } from "@chernabog/sdk";
import { Effect } from "effect";

export default defineFlow({
  trigger: Implement.triggerFor("deploy"),
  workflow: () => Effect.void,
});
`;

const PACKAGES = {
  "@chernabog/recipes": {
    "0.1.0": officialRecipes("0.1.0", () => {}),
    "0.2.0": officialRecipes("0.2.0", (files) => {
      files["flows/implement.ts"] = `${files["flows/implement.ts"]}${UPSTREAM_FIX}`;
    }),
  },
  "@acme/recipes": {
    "1.0.0": {
      manifest: {
        name: "@acme/recipes",
        version: "1.0.0",
        peerDependencies: { "@chernabog/sdk": `^${BUNDLED_SDK}` },
        chernabog: {
          recipes: {
            deploy: {
              description: "Deploys what's labelled deploy",
              flow: "flows/deploy.ts",
              prompts: ["prompts/deploy.md"],
            },
          },
        },
      },
      files: { "flows/deploy.ts": ACME_DEPLOY, "prompts/deploy.md": "Deploy {{repo}}.\n" },
    },
  },
  "@chernabog/sdk": { [BUNDLED_SDK]: stub("@chernabog/sdk", BUNDLED_SDK) },
  effect: { [EFFECT_VERSION]: stub("effect", EFFECT_VERSION) },
} satisfies Readonly<Record<string, Readonly<Record<string, Release>>>>;

// Every package, by any name a request gives.
const REGISTRY: Readonly<Record<string, Readonly<Record<string, Release>>>> = PACKAGES;

// One ustar header and its file, padded to 512-byte blocks.
const tarEntry = (name: string, content: Uint8Array) => {
  const header = new Uint8Array(512);

  const field = (offset: number, length: number, value: string) => {
    header.set(new TextEncoder().encode(value).slice(0, length), offset);
  };

  const octal = (offset: number, length: number, value: number) => {
    field(offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
  };

  field(0, 100, name);
  octal(100, 8, 0o644);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, content.length);
  octal(136, 12, 0);
  field(148, 8, "        ");
  field(156, 1, "0");
  field(257, 6, "ustar\0");
  field(263, 2, "00");
  octal(
    148,
    7,
    header.reduce((sum, byte) => sum + byte, 0),
  );

  const padded = new Uint8Array(Math.ceil(content.length / 512) * 512);
  padded.set(content);

  return [header, padded];
};

const tarball = (release: Release) => {
  const entries = Object.entries({
    "package.json": printJson(release.manifest),
    ...release.files,
  }).flatMap(([path, text]) => tarEntry(`package/${path}`, new TextEncoder().encode(text)));

  const tar = new Uint8Array(entries.reduce((size, part) => size + part.length, 1024));
  let offset = 0;

  for (const part of entries) {
    tar.set(part, offset);
    offset += part.length;
  }

  return new Uint8Array(Bun.gzipSync(tar));
};

const packed = new Map<string, Uint8Array<ArrayBuffer>>();

const packedOf = (name: string, version: string, release: Release) => {
  const key = `${name}@${version}`;
  const found = packed.get(key) ?? tarball(release);
  packed.set(key, found);

  return found;
};

export type FakeRegistry = {
  readonly url: string;
  // The packages each request asked for, with the token it carried.
  readonly requests: Array<string>;
  readonly stop: () => Promise<void>;
};

export const startFakeRegistry = (): FakeRegistry => {
  const requests: Array<string> = [];

  let port = 0;

  const server = Bun.serve({
    port: 0,
    fetch: (request): Response => {
      const url = new URL(request.url);
      const path = decodeURIComponent(url.pathname.slice(1));

      const token = Option.getOrElse(
        Option.fromNullishOr(request.headers.get("authorization")),
        () => "",
      );

      requests.push(`${path} ${token}`);

      const tarballMatch = Option.fromNullishOr(/^tarballs\/(.+)\/([^/]+)\.tgz$/.exec(path));

      const name = Option.getOrElse(
        Option.map(tarballMatch, (match) => match[1]),
        () => path,
      );

      const found = Record.get(REGISTRY, name);

      if (Option.isNone(found)) {
        return new Response("{}", { status: 404 });
      }

      const versions: Readonly<Record<string, Release>> = found.value;

      if (name.startsWith("@acme/") && token !== `Bearer ${ACME_TOKEN}`) {
        return new Response("{}", { status: 401 });
      }

      if (Option.isSome(tarballMatch)) {
        const version = tarballMatch.value[2];

        return Option.match(Record.get(versions, version), {
          onNone: () => new Response("", { status: 404 }),
          onSome: (release) => new Response(new Blob([packedOf(name, version, release)])),
        });
      }

      const base = `http://localhost:${String(port)}`;
      const latest = Object.keys(versions).toSorted(Bun.semver.order).at(-1) ?? "";

      return Response.json({
        name,
        "dist-tags": { latest },
        versions: Object.fromEntries(
          Object.entries(versions).map(([version, release]) => {
            const tgz = packedOf(name, version, release);

            return [
              version,
              {
                ...release.manifest,
                name,
                version,
                dist: {
                  tarball: `${base}/tarballs/${name}/${version}.tgz`,
                  integrity: `sha512-${createHash("sha512").update(tgz).digest("base64")}`,
                  shasum: createHash("sha1").update(tgz).digest("hex"),
                },
              },
            ];
          }),
        ),
      });
    },
  });

  port = server.port ?? 0;

  return {
    url: `http://localhost:${String(port)}/`,
    requests,
    stop: () => server.stop(true),
  };
};
