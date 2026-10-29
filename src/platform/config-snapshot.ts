// Flows, steps and prompts are read from the config branch, never from the
// branch or worktree under work, so a pull request can't rewrite the reviewer
// that reviews it. The config branch is GitHub's default branch, asked of the
// remote on every snapshot, so every machine reads the same one and a change
// of default on GitHub carries them all along; no setting names it (ADR 0005).
// The config branch's .chernabog/ tree is extracted once per tree
// hash under the Chernabog home, outside the repo, with its own dependencies
// installed: imports resolve from what the trusted tree declares, never from
// whatever the checkout last installed. The SDK is one of those dependencies,
// so each snapshot runs the blocks its own tree pins. A run records the tree
// it started from and resumes against that snapshot, whatever the config
// branch has since.

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { ConfigError } from "./config-error.ts";
import { Exec, execOk } from "./exec.ts";
import { checkCompatibility, checkInstalled, installFlowDependencies } from "./flow-deps.ts";
import { Home, homePaths } from "./home.ts";

export type Snapshot = { readonly tree: string; readonly configDir: string };

const git = (path: string, args: ReadonlyArray<string>) =>
  execOk("git", ["-C", path, ...args]).pipe(Effect.map((output) => output.trim()));

const DEFAULT_REF = /^ref: refs\/heads\/(\S+)\s+HEAD$/m;

// The remote's default branch as the checkout last recorded it (origin/HEAD),
// without asking the remote; main when it recorded none.
export const knownDefaultBranch = (path: string) =>
  Effect.gen(function* () {
    const result = yield* (yield* Exec).run("git", [
      "-C",
      path,
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);

    if (result.exitCode !== 0) {
      return "main";
    }

    return result.stdout.trim().replace(/^origin\//, "");
  });

// The config branch: GitHub's default branch, asked of the remote and recorded
// as the checkout's origin/HEAD. `fetch: false`, or a remote that can't be
// reached, reads what was last recorded instead.
export const configBranch = (path: string, fetch = true) =>
  Effect.gen(function* () {
    if (fetch) {
      const listed = yield* (yield* Exec).run("git", [
        "-C",
        path,
        "ls-remote",
        "--symref",
        "origin",
        "HEAD",
      ]);

      const found = Option.fromNullishOr(DEFAULT_REF.exec(listed.stdout));

      if (listed.exitCode === 0 && Option.isSome(found)) {
        const branch = found.value[1];
        yield* git(path, [
          "symbolic-ref",
          "refs/remotes/origin/HEAD",
          `refs/remotes/origin/${branch}`,
        ]).pipe(Effect.ignore);

        return branch;
      }
    }

    return yield* knownDefaultBranch(path);
  });

// The tree hash of .chernabog/ on the config branch: what `trust` approves.
// `fetch: false` reads what the checkout already has, without asking the remote.
export const configTree = (path: string, fetch = true) =>
  Effect.gen(function* () {
    const branch = yield* configBranch(path, fetch);

    if (fetch) {
      yield* git(path, ["fetch", "--quiet", "origin", branch]).pipe(Effect.ignore);
    }

    const exec = yield* Exec;

    for (const ref of [`origin/${branch}`, branch]) {
      const result = yield* exec.run("git", [
        "-C",
        path,
        "rev-parse",
        "--verify",
        "--quiet",
        `${ref}:.chernabog`,
      ]);

      if (result.exitCode === 0) {
        return result.stdout.trim();
      }
    }

    return yield* new ConfigError({
      message: `${path}: no .chernabog/ on ${branch}, GitHub's default branch; run chernabog init and merge it first`,
    });
  });

// The snapshot of the .chernabog/ tree `tree` from the checkout at `path`,
// extracted and installed the first time it's asked for. A run resumes against
// the tree it started from by this, after the config branch has moved on.
export const snapshotTree = (path: string, tree: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const snapshots = homePaths((yield* Home).root).snapshots;
    const root = `${snapshots}/${tree}`;
    const configDir = `${root}/.chernabog`;

    if (!(yield* fs.exists(configDir))) {
      // Extracted and installed beside it first, so a half-made snapshot is never read.
      yield* fs.makeDirectory(snapshots, { recursive: true });

      const staging = yield* fs.makeTempDirectory({
        directory: snapshots,
        prefix: `${tree}.partial-`,
      });

      yield* Effect.gen(function* () {
        yield* fs.makeDirectory(`${staging}/.chernabog`);
        yield* execOk("sh", [
          "-c",
          'git -C "$1" archive "$2" | tar -x -C "$3"',
          "sh",
          path,
          tree,
          `${staging}/.chernabog`,
        ]);
        // Before installing, so a repo this binary can't run says so instead of failing the install.
        yield* checkCompatibility(`${staging}/.chernabog`);
        yield* installFlowDependencies(`${staging}/.chernabog`);
        // Once installed: the SDK and the packages its flows import from, as the lockfile pins them.
        yield* checkInstalled(`${staging}/.chernabog`);
      }).pipe(
        Effect.onError(() => Effect.ignore(fs.remove(staging, { recursive: true, force: true }))),
      );

      // Another process may have made the same snapshot meanwhile; either copy will do.
      yield* fs.rename(staging, root).pipe(
        Effect.catchTag("PlatformError", (error) =>
          Effect.flatMap(fs.exists(configDir), (made) => {
            if (made) {
              return fs.remove(staging, { recursive: true, force: true });
            }

            return Effect.fail(error);
          }),
        ),
      );
    }

    return { tree, configDir } satisfies Snapshot;
  }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(new ConfigError({ message: `${path}: ${error.message}` })),
    ),
  );

// The snapshot of .chernabog/ as the config branch has it now.
export const snapshotConfig = (path: string, fetch = true) =>
  Effect.flatMap(configTree(path, fetch), (tree) => snapshotTree(path, tree));
