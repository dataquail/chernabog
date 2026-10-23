import { describe, expect, test } from 'bun:test';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';

import { IMPLICIT } from '../../../../kernel/persona.value-object.ts';
import { RepoSlug } from '../../../../kernel/repo-slug.id.ts';
import { AmbiguousClone } from './enrolled-repo.errors.ts';
import { EnrolledRepoRoot } from './enrolled-repo.root.ts';
import { EnrolledRepoRootOps } from './enrolled-repo.root-ops.ts';

const slug = RepoSlug.make('acme/widgets');
const alice = Option.some('alice');
const bob = Option.some('bob');

const enrolled = (fields: Partial<ConstructorParameters<typeof EnrolledRepoRoot>[0]> = {}) => EnrolledRepoRoot.make({ repo: slug, path: '/src/widgets', defaults: {}, ...fields });

// Two personas that both inherit the repo entry's flows.
const shared = () => enrolled({ defaults: { flows: { implement: {}, review: { schedule: '0 * * * *' } } }, personas: { alice: {}, bob: {} } });

describe('EnrolledRepoRootOps.nameOf', () => {
  test('is the entry\'s name, else the name half of its slug', () => {
    expect(EnrolledRepoRootOps.nameOf(enrolled())).toBe('widgets');
    expect(EnrolledRepoRootOps.nameOf(enrolled({ name: 'widgets-2' }))).toBe('widgets-2');
  });
});

describe('EnrolledRepoRootOps.choicesOf', () => {
  test('a persona\'s own keys replace the repo entry\'s whole, flows included', () => {
    const repo = enrolled({ defaults: { account: 'work', flows: { implement: {}, review: {} } }, personas: { alice: { flows: { review: {} } }, bob: {} } });

    expect(EnrolledRepoRootOps.choicesOf(repo, alice)).toEqual({ account: 'work', flows: { review: {} } });
    expect(EnrolledRepoRootOps.choicesOf(repo, bob)).toEqual({ account: 'work', flows: { implement: {}, review: {} } });
    expect(EnrolledRepoRootOps.choicesOf(repo, IMPLICIT)).toEqual(repo.defaults);
  });
});

describe('EnrolledRepoRootOps.entryFor', () => {
  const at = (path: string, name: string) => enrolled({ path, name });
  const enrolling = (path: string, name: Option.Option<string> = Option.none()) => ({ repo: slug, name, path });

  test('finds the entry with the slug, wherever its checkout is now', () => {
    expect(EnrolledRepoRootOps.entryFor([enrolled({ repo: RepoSlug.make('acme/other') }), enrolled({ path: '/old' })], enrolling('/new'))).toEqual(Result.succeed(Option.some(1)));
  });

  test('is none for a repo not enrolled yet', () => {
    expect(EnrolledRepoRootOps.entryFor([], enrolling('/new'))).toEqual(Result.succeed(Option.none()));
  });

  test('of several clones, takes the one named, else the one at the path', () => {
    const clones = [at('/one', 'one'), at('/two', 'two')];

    expect(EnrolledRepoRootOps.entryFor(clones, enrolling('/elsewhere', Option.some('two')))).toEqual(Result.succeed(Option.some(1)));
    expect(EnrolledRepoRootOps.entryFor(clones, enrolling('/one'))).toEqual(Result.succeed(Option.some(0)));
  });

  test('refuses to guess between clones when neither name nor path says', () => {
    const found = EnrolledRepoRootOps.entryFor([at('/one', 'one'), at('/two', 'two')], enrolling('/three'));

    expect(found).toEqual(Result.fail(new AmbiguousClone({ repo: slug, names: ['one', 'two'] })));
    expect(Result.isFailure(found) && found.failure.message).toBe('acme/widgets is enrolled as one, two; name the one this is with --name');
  });
});

describe('EnrolledRepoRootOps.reenroll', () => {
  test('replaces what the enrolment gives and keeps every other setting', () => {
    const existing = enrolled({ path: '/old', defaults: { account: 'work', flows: { implement: {} } }, personas: { alice: { flows: { review: {} } } } });
    const again = EnrolledRepoRootOps.reenroll(existing, enrolled({ path: '/new', baseBranch: 'trunk' }));

    expect(again).toEqual(enrolled({ path: '/new', baseBranch: 'trunk', defaults: { account: 'work', flows: { implement: {} } }, personas: { alice: { flows: { review: {} } } } }));
  });
});

describe('EnrolledRepoRootOps.ownFlows', () => {
  test('a persona with flows of its own owns them', () => {
    const repo = enrolled({ personas: { alice: { flows: {} }, bob: {} } });

    expect(EnrolledRepoRootOps.ownFlows(repo, alice)).toEqual({ repo, owner: alice });
  });

  test('the only persona, and the implicit one, edit the repo entry\'s', () => {
    const only = enrolled({ defaults: { flows: { implement: {} } }, personas: { alice: {} } });

    expect(EnrolledRepoRootOps.ownFlows(only, alice)).toEqual({ repo: only, owner: Option.none() });
    expect(EnrolledRepoRootOps.ownFlows(only, IMPLICIT)).toEqual({ repo: only, owner: Option.none() });
  });

  test('one of several that inherits gets its own copy first', () => {
    const { owner, repo } = EnrolledRepoRootOps.ownFlows(shared(), alice);

    expect(owner).toEqual(alice);
    expect(repo.personas).toEqual({ alice: { flows: shared().defaults.flows }, bob: {} });
    expect(repo.defaults).toEqual(shared().defaults);
  });
});

describe('EnrolledRepoRootOps.setFlow', () => {
  test('a change for one of several personas leaves the others the inherited flows', () => {
    const changed = EnrolledRepoRootOps.setFlow(shared(), alice, 'implement', false);

    expect(changed.personas).toEqual({ alice: { flows: { review: { schedule: '0 * * * *' } } }, bob: {} });
    expect(EnrolledRepoRootOps.choicesOf(changed, bob).flows).toEqual(shared().defaults.flows);
  });

  test('turning a flow off keeps its settings as enabled: false, and drops one with none', () => {
    const off = EnrolledRepoRootOps.setFlow(EnrolledRepoRootOps.setFlow(shared(), IMPLICIT, 'review', false), IMPLICIT, 'implement', false);

    expect(off.defaults.flows).toEqual({ review: { schedule: '0 * * * *', enabled: false } });
  });

  test('turning a flow on lists it, keeping its settings', () => {
    const repo = enrolled({ defaults: { flows: { review: { schedule: '0 * * * *', enabled: false } } } });
    const on = EnrolledRepoRootOps.setFlow(EnrolledRepoRootOps.setFlow(repo, IMPLICIT, 'review', true), IMPLICIT, 'implement', true);

    expect(on.defaults.flows).toEqual({ review: { schedule: '0 * * * *' }, implement: {} });
  });

  test('leaves the entry it was given as it was', () => {
    const before = shared();
    EnrolledRepoRootOps.setFlow(before, alice, 'implement', false);

    expect(before).toEqual(shared());
  });
});

describe('EnrolledRepoRootOps.setFlowSchedule', () => {
  test('overrides a listed flow\'s schedule, and clears it again', () => {
    const set = EnrolledRepoRootOps.setFlowSchedule(shared(), IMPLICIT, 'implement', Option.some('5 * * * *'));

    expect(set.defaults.flows?.implement).toEqual({ schedule: '5 * * * *' });
    expect(EnrolledRepoRootOps.setFlowSchedule(set, IMPLICIT, 'implement', Option.none()).defaults.flows?.implement).toEqual({});
  });

  test('an unlisted flow keeps the override, off', () => {
    const set = EnrolledRepoRootOps.setFlowSchedule(shared(), IMPLICIT, 'address-review', Option.some('5 * * * *'));

    expect(set.defaults.flows?.['address-review']).toEqual({ enabled: false, schedule: '5 * * * *' });
  });

  test('clearing a flow that isn\'t listed changes nothing', () => {
    expect(EnrolledRepoRootOps.setFlowSchedule(shared(), IMPLICIT, 'address-review', Option.none())).toEqual(shared());
  });
});

describe('EnrolledRepoRootOps.setAccount', () => {
  test('a persona without an entry of its own picks on the repo entry', () => {
    expect(EnrolledRepoRootOps.setAccount(enrolled(), alice, Option.none(), Option.some('work')).defaults).toEqual({ account: 'work' });
  });

  test('a persona with an entry picks on its own', () => {
    const picked = EnrolledRepoRootOps.setAccount(shared(), bob, Option.some('reviewer'), Option.some('codex-work'));

    expect(picked.personas?.bob).toEqual({ roles: { reviewer: 'codex-work' } });
    expect(picked.defaults).toEqual(shared().defaults);
  });

  test('clearing the last role drops the roles map', () => {
    const repo = enrolled({ defaults: { account: 'work', roles: { reviewer: 'codex-work' } } });

    expect(EnrolledRepoRootOps.setAccount(repo, IMPLICIT, Option.some('reviewer'), Option.none()).defaults).toEqual({ account: 'work' });
  });

  test('clearing the account keeps the roles', () => {
    const repo = enrolled({ defaults: { account: 'work', roles: { reviewer: 'codex-work' } } });

    expect(EnrolledRepoRootOps.setAccount(repo, IMPLICIT, Option.none(), Option.none()).defaults).toEqual({ roles: { reviewer: 'codex-work' } });
  });
});
