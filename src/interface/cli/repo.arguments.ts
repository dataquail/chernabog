import * as Argument from 'effect/cli/Argument';
import * as Flag from 'effect/cli/Flag';

// How a command names an enrolled repo.
export const repoFlag = Flag.String('repo').pipe(Flag.withDescription('An enrolled repo, by name or owner/name'));

export const repoArgument = Argument.String('repo').pipe(Argument.withDescription('An enrolled repo, by name or owner/name'));

export const optionalRepo = Argument.String('repo').pipe(Argument.withDescription('An enrolled repo; all of them when left out'), Argument.optional);
