// `bun run mutation <module>`: one module's mutation run, by its config in
// stryker/. It runs in place, so leave the tree alone until it ends.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const modules = readdirSync("stryker")
  .filter((file) => file.endsWith(".conf.mjs"))
  .map((file) => file.slice(0, -".conf.mjs".length))
  .toSorted();

const [name, ...rest] = process.argv.slice(2);

if (name === undefined || !modules.includes(name)) {
  console.error(
    `Usage: bun run mutation <module> [stryker options]\nModules: ${modules.join(", ")}`,
  );
  process.exit(2);
}

const run = spawnSync("stryker", ["run", `stryker/${name}.conf.mjs`, ...rest], {
  stdio: "inherit",
});

process.exit(run.status ?? 1);
