// `chernabog sandbox init` (#718, ADR 24, decision 11), through the real CLI:
// it writes the template Dockerfile into .chernabog/sandbox/, and refuses to
// write over one that's there.
//
// The image built from the untouched template is checked only where a person
// names a runtime to build it with, as a build pulls a base image and
// installs from the network:
//
//   CHERNABOG_TEST_SANDBOX_RUNTIME=docker bun test test/acceptance/sandbox-init.test.ts

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { openSandbox, type Sandbox } from "./sandbox.ts";

const DOCKERFILE = ".chernabog/sandbox/Dockerfile";

const RUNTIME = Option.fromUndefinedOr(process.env.CHERNABOG_TEST_SANDBOX_RUNTIME);

describe("chernabog sandbox init", () => {
  let sandbox: Sandbox;
  const dockerfile = () => join(sandbox.checkout, DOCKERFILE);

  beforeAll(() => {
    sandbox = openSandbox();
  });

  afterAll(async () => {
    await sandbox.github.stop();
  });

  test("writes the template Dockerfile, with git, gh, curl, Claude Code, an optional Codex, a non-root user and room for the repo's toolchain", async () => {
    const written = await sandbox.runCli(["sandbox", "init"]);

    expect(written.output).toContain(`wrote ${DOCKERFILE}`);
    expect(written.code).toBe(0);

    const text = readFileSync(dockerfile(), "utf8");

    expect(text).toMatch(/^FROM /m);
    expect(text).toContain("apt-get install -y --no-install-recommends gh");
    expect(text).toMatch(/install -y --no-install-recommends ca-certificates curl git/);
    expect(text).toContain("https://claude.ai/install.sh");
    expect(text).toContain("ARG AGENT_UID=");
    expect(text).toContain("ARG AGENT_GID=");
    expect(text).toMatch(/^USER agent$/m);
    expect(text).toContain("The repo's toolchain goes here");
    // The Codex CLI is an optional step, off until the repo turns it on (#724).
    expect(text).toMatch(/^ARG INSTALL_CODEX=false$/m);
    expect(text).toContain("github.com/openai/codex/releases");
  });

  test("refuses to write over a Dockerfile that's there, and leaves it as it was", async () => {
    const own = "FROM alpine\n# the repo's own\n";
    mkdirSync(join(sandbox.checkout, ".chernabog", "sandbox"), { recursive: true });
    writeFileSync(dockerfile(), own);

    const refused = await sandbox.runCli(["sandbox", "init"]);

    expect(refused.code).not.toBe(0);
    expect(refused.output).toContain(`${DOCKERFILE} is already there`);
    expect(readFileSync(dockerfile(), "utf8")).toBe(own);
  });

  test("writes into the checkout it's given", async () => {
    const other = join(sandbox.root, "other");
    execFileSync("git", ["init", "-q", other]);

    const written = await sandbox.runCli(["sandbox", "init", other]);

    expect(written.code).toBe(0);
    expect(existsSync(join(other, DOCKERFILE))).toBe(true);
  });

  // The image test's, removed once the file's tests are done.
  const images: Array<{ runtime: string; tag: string }> = [];

  afterAll(() => {
    for (const { runtime, tag } of images) {
      execFileSync(runtime, ["rmi", "-f", tag], { stdio: "ignore" });
    }
  });

  const imageTitle =
    "an image built from the untouched template runs claude, git and gh as the non-root user";

  Option.match(RUNTIME, {
    onNone: () => {
      test.skip(`${imageTitle}: set CHERNABOG_TEST_SANDBOX_RUNTIME=docker or podman to run`, () => {});
    },
    onSome: (runtime) => {
      test(`${imageTitle} (${runtime})`, async () => {
        const context = join(sandbox.root, "image");
        execFileSync("git", ["init", "-q", context]);
        expect((await sandbox.runCli(["sandbox", "init", context])).code).toBe(0);
        const tag = `chernabog-sandbox-init-test:${process.pid}`;
        images.push({ runtime, tag });

        execFileSync(
          runtime,
          [
            "build",
            "-q",
            "--build-arg",
            "AGENT_UID=4242",
            "--build-arg",
            "AGENT_GID=4242",
            "-t",
            tag,
            join(context, ".chernabog", "sandbox"),
          ],
          { stdio: ["ignore", "ignore", "inherit"] },
        );

        const ran = execFileSync(
          runtime,
          [
            "run",
            "--rm",
            tag,
            "sh",
            "-c",
            "id -u; id -un; claude --version; git --version; gh --version",
          ],
          { encoding: "utf8" },
        );

        expect(ran).toMatch(/^4242\nagent\n/);
        expect(ran).toContain("(Claude Code)");
        expect(ran).toContain("git version");
        expect(ran).toContain("gh version");
      }, 600_000);
    },
  });
});
