// A test is an Effect: scoped, on the real clock, with Bun's platform services.

import { BunServices } from '@effect/platform-bun';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import { it } from 'effect-bun-test';

import { Home } from '../src/config.ts';
import { HostEnvironment } from '../src/platform/environment.ts';

export const effect = it.scopedLive.layer(BunServices.layer);

// Chernabog's home, and the person's, in a fresh directory removed after the test.
const TemporaryHome = Layer.effect(
  Home,
  FileSystem.FileSystem.use((fs) => fs.makeTempDirectoryScoped({ prefix: 'chernabog-home-' })).pipe(Effect.map((root) => Home.of({ root, user: root }))),
);

// Also a home of its own, a host environment with only PATH set, and any other services a test fakes.
export const effectAtHomeWith = <A>(fakes: Layer.Layer<A>) =>
  it.scopedLive.layer(Layer.mergeAll(TemporaryHome, HostEnvironment.fixed({ PATH: '/usr/bin' }), fakes).pipe(Layer.provideMerge(BunServices.layer)));

export const effectAtHome = effectAtHomeWith(Layer.empty);
