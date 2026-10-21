// Which adapter a step runs its agent with. A persona can give a role its own
// account in machine config (roles: { reviewer: codex-work }), and a flow can
// name roles in config (flows.<flow>.agents, such as { reviewer: codex }). A
// step given { role } runs with the persona's pick for it, then the flow's,
// then the flow's agent, then the repo's.

import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Record from 'effect/Record';

import { Repo, Run } from './services.ts';

// What a step that runs an agent can be told: the role it plays in the flow.
export type RoleOptions = { readonly role?: string };

// The adapter for a role in this run's flow; none means the repo's own agent.
export const adapterFor = (role: Option.Option<string>) =>
  Effect.gen(function* () {
    const repo = yield* Repo;
    const run = yield* Run;
    const roles = Record.get(repo.flowRoleAgents ?? {}, run.flow);
    const forRole = Option.flatMap(role, (name) => Option.orElse(Record.get(repo.roleAgents ?? {}, name), () => Option.flatMap(roles, Record.get(name))));

    return Option.orElse(forRole, () => Record.get(repo.flowAgents, run.flow));
  });
