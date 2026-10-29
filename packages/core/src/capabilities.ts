// What a capability port's methods do to the world, as the port declares it.
// A write another person or run sees is declared with how the run's log names
// it; every other member says why it isn't one. The engine fences and reports
// every write a port declares, and names none of them, so a port that gains a
// write, or a new port, is fenced and reported by declaring it.

import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";

// A write another person or run sees, as the run's log names it.
export type Write<A> = {
  // Before it is made: the fence stops a run that lost its work "before pushing auto/issue-3".
  readonly doing: string;
  // Once made: "pushed auto/issue-3", the change other flows act on.
  readonly done: string;
  // The issue or pull request it changed, if one, from what it returned.
  readonly item: (result: A) => Option.Option<number>;
};

// A write that changes `item`, or nothing numbered.
export const write = <A>(
  doing: string,
  done: string,
  item: Option.Option<number> = Option.none(),
): Option.Option<Write<A>> => Option.some({ doing, done, item: () => item });

// Why a member isn't a write: it reads; it changes only this machine (a
// worktree, a local branch, a commit no ref names yet); it takes, renews or
// lets go of a claim, which the fence itself reads, so it is never fenced; or
// it hands the work to a process whose own writes aren't seen here, as an
// agent's session or a flow's own git command.
export type Other = "read" | "local" | "claim" | "delegated";

// Wraps one method of a port as a write, described by its arguments; one
// call it describes as none, such as a GET through GitHub.request, reads.
export type Guard = <Args extends ReadonlyArray<unknown>, A, E, R>(
  method: (...args: Args) => Effect.Effect<A, E, R>,
  describe: (...args: Args) => Option.Option<Write<A>>,
) => (...args: Args) => Effect.Effect<A, E, R>;

// What the engine does around each declared write: its fence, its report.
export type Around = <A, E, R>(
  described: Write<A>,
  call: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R>;

// A port whose writes can be wrapped, whatever its service.
export type Guarded = {
  // `context` with the port's service, if it has one, making each write it declares through `around`.
  readonly guarding: <R>(context: Context.Context<R>, around: Around) => Context.Context<R>;
};

export type Capability<S, W extends Partial<S>> = Guarded & {
  // The port's writes: each method another person or run sees, through `guard`.
  readonly writes: (service: S, guard: Guard) => W;
  // Every other member of the port, and why it isn't a write.
  readonly others: { readonly [K in Exclude<keyof S, keyof W>]: Other };
};

// Declares a port's writes and, for every other member, why it isn't one. A
// member left out of both doesn't compile.
export const declare = <I, S, W extends Partial<S>>(
  port: Context.Key<I, S>,
  writes: (service: S, guard: Guard) => W,
  others: { readonly [K in Exclude<keyof S, keyof W>]: Other },
): Capability<S, W> => ({
  writes,
  others,
  guarding: (context, around) =>
    Option.match(Context.getOption(context, port), {
      onNone: () => context,
      onSome: (service) =>
        Context.add(context, port, {
          ...service,
          ...writes(
            service,
            (method, describe) =>
              (...args) =>
                Option.match(describe(...args), {
                  onNone: () => method(...args),
                  onSome: (described) => around(described, method(...args)),
                }),
          ),
        }),
    }),
});

// `context` with every write of every capability in it made through `around`.
export const guardingAll = <R>(
  context: Context.Context<R>,
  capabilities: ReadonlyArray<Guarded>,
  around: Around,
): Context.Context<R> =>
  capabilities.reduce((guarded, capability) => capability.guarding(guarded, around), context);
