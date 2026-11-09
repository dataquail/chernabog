import * as Option from "effect/Option";

export type StepSpan = {
  readonly step: string;
  readonly enteredAt: string;
  readonly finishedAt: Option.Option<string>;
};

const of = (_: {
  readonly steps: ReadonlyArray<StepSpan>;
  readonly runFinishedAt: Option.Option<string>;
  readonly now: string;
}): Option.Option<number> => Option.none();

export const ComputeTime = { of } as const;
