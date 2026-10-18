import { expect } from 'bun:test';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';

import { renderTemplates, templatesRoot } from '../scripts/templates.ts';
import { effect } from './effect-test.ts';

effect(
  'src/templates.ts is what scripts/gen-templates.ts writes from templates/ (run it after changing a template)',
  () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const generated = yield* fs.readFileString(yield* path.fromFileUrl(new URL('../src/templates.ts', import.meta.url)));
    expect(generated).toBe((yield* renderTemplates(templatesRoot)).text);
  }),
);
