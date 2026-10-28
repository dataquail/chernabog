// Prints the bun.lock that installing the package.json on stdin writes, from a
// fake registry this process serves itself. The sandbox commits its repo's
// lockfile with it, synchronously, which it can't do against the registry it
// serves: an install it waits on would wait on it. The fake registry packs
// each version the same way every time, so the lockfile's integrity holds
// for the sandbox's own registry too, once its tarballs' URLs name that one
// (lockfileFor).
// Run: bun test/acceptance/lockfile.ts < package.json

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startFakeRegistry } from "./fake-registry.ts";

const registry = startFakeRegistry();
const dir = mkdtempSync(join(tmpdir(), "chernabog-lockfile-"));

writeFileSync(join(dir, "package.json"), await Bun.stdin.text());

const install = Bun.spawn([process.execPath, "install", "--ignore-scripts"], {
  cwd: dir,
  env: {
    ...process.env,
    NPM_CONFIG_REGISTRY: registry.url,
    BUN_INSTALL_CACHE_DIR: join(dir, ".bun-cache"),
  },
  stdout: "ignore",
  stderr: "inherit",
});

const code = await install.exited;

await registry.stop();

if (code === 0) {
  process.stdout.write(readFileSync(join(dir, "bun.lock"), "utf8"));
}

rmSync(dir, { recursive: true, force: true });

process.exit(code);
