import { type RunId } from "../../../../kernel/run-id.id.ts";
import { Spec, type Specification } from "../../../../kernel/specification.ts";
import { type RunRoot } from "./run.root.ts";

// Every run this machine has started.
const all: Specification<RunRoot> = Spec.all<RunRoot>();

// The run with this id.
const withId = (id: RunId): Specification<RunRoot> => Spec.eq<RunRoot, "id">("id", id);

// The runs still running: those whose workflow hasn't ended them.
const running: Specification<RunRoot> = Spec.eq<RunRoot, "status">("status", "running");

// Every run of one repo, by the name the daemon schedules it under.
const forRepo = (repo: string): Specification<RunRoot> => Spec.eq<RunRoot, "repo">("repo", repo);

export const RunSpecifications = { all, withId, running, forRepo } as const;
