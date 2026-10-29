// A test is an Effect: scoped, on the real clock, with Bun's platform services.

import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { it } from "effect-bun-test";

import { HostEnvironment } from "../src/platform/environment.ts";
import { Home } from "../src/platform/home.ts";

// The timeout the package.json test scripts give with --timeout=15000, for a
// bare `bun test` too: Bun resets a default set any other way for each file,
// and tests that run git for real, such as epic-stack's, can take longer than
// its 5s on a busy machine. A test that names its own timeout keeps it.
const TIMEOUT_MS = 15_000;

const withTimeout =
  <R>(test: <E>(name: string, fn: () => Effect.Effect<void, E, R>, timeout?: number) => void) =>
  <E>(name: string, fn: () => Effect.Effect<void, E, R>, timeout = TIMEOUT_MS) => {
    test(name, fn, timeout);
  };

export const effect = withTimeout(it.scopedLive.layer(BunServices.layer));

// On a virtual clock instead, which a test moves with TestClock.adjust, for
// what waits or repeats on a schedule.
export const effectOnTestClock = withTimeout(it.scoped);

// Chernabog's home, and the person's, in a fresh directory removed after the test.
const TemporaryHome = Layer.effect(
  Home,
  FileSystem.FileSystem.use((fs) => fs.makeTempDirectoryScoped({ prefix: "chernabog-home-" })).pipe(
    Effect.map((root) => Home.of({ root, user: root })),
  ),
);

// Also a home of its own, a host environment with only PATH set (on this OS, or the one given), and any other services a test fakes.
export const effectAtHomeWith = <A>(
  fakes: Layer.Layer<A, never, BunServices.BunServices>,
  platform: string = process.platform,
) =>
  withTimeout(
    it.scopedLive.layer(
      Layer.mergeAll(
        TemporaryHome,
        HostEnvironment.fixed({ PATH: "/usr/bin" }, platform),
        fakes,
      ).pipe(Layer.provideMerge(BunServices.layer)),
    ),
  );

export const effectAtHome = effectAtHomeWith(Layer.empty);
