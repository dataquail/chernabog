import { describe, expect } from 'bun:test';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';

import { effect } from '../../../../test/effect-test.ts';
import { RepoSlug } from '../../../kernel/repo-slug.id.ts';
import { EnrolledRepoRoot } from '../domain/enrolled-repo/enrolled-repo.root.ts';
import { EnrolledReposRepositoryFake } from '../infrastructure/repositories/enrolled-repos.repository-fake.ts';
import { listEnrolledReposUseCase } from './list-enrolled-repos.use-case.ts';

const repos = [
  EnrolledRepoRoot.make({ repo: RepoSlug.make('dataquail/demo'), path: '/src/demo', defaults: {}, paused: false }),
  EnrolledRepoRoot.make({ repo: RepoSlug.make('dataquail/other'), name: 'other-2', path: '/src/other', baseBranch: 'trunk', defaults: {}, paused: false }),
];

describe('listEnrolledReposUseCase', () => {
  effect('lists every enrolled repo, with the branch each is trusted from', () =>
    Effect.gen(function* () {
      const listed = yield* listEnrolledReposUseCase(Option.none());

      expect(listed.repos.map((repo) => [repo.name, repo.repo, repo.path, repo.baseBranch])).toEqual([
        ['demo', 'dataquail/demo', '/src/demo', 'main'],
        ['other-2', 'dataquail/other', '/src/other', 'trunk'],
      ]);
    }).pipe(Effect.provide(EnrolledReposRepositoryFake(repos))),
  );

  effect('lists only the one named, and fails for a name no repo answers to', () =>
    Effect.gen(function* () {
      expect((yield* listEnrolledReposUseCase(Option.some('dataquail/other'))).repos.map((repo) => repo.name)).toEqual(['other-2']);
      expect((yield* Effect.flip(listEnrolledReposUseCase(Option.some('nope'))))._tag).toBe('RepoNotEnrolled');
    }).pipe(Effect.provide(EnrolledReposRepositoryFake(repos))),
  );
});
