// A test is an Effect: scoped, on the real clock, with Bun's platform services.

import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { it } from "effect-bun-test";

import { HostEnvironment } from "../src/platform/environment.ts";
import { Home } from "../src/platform/home.ts";

export const effect = it.scopedLive.layer(BunServices.layer);

// On a virtual clock instead, which a test moves with TestClock.adjust, for
// what waits or repeats on a schedule.
export const effectOnTestClock = it.scoped;

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
  it.scopedLive.layer(
    Layer.mergeAll(
      TemporaryHome,
      HostEnvironment.fixed({ PATH: "/usr/bin" }, platform),
      fakes,
    ).pipe(Layer.provideMerge(BunServices.layer)),
  );

export const effectAtHome = effectAtHomeWith(Layer.empty);
