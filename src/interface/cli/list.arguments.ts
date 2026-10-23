import * as Flag from "effect/cli/Flag";
import * as Option from "effect/Option";

// A comma-separated list flag, such as --flows implement,review.
export const listFlag = (name: string, description: string) =>
  Flag.String(name).pipe(
    Flag.withDescription(description),
    Flag.optional,
    Flag.map(
      Option.map((text) =>
        text
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      ),
    ),
  );

// Items as a sentence lists them, or none.
export const listed = (items: ReadonlyArray<string>) =>
  Option.getOrElse(
    Option.liftPredicate(items.join(", "), (text) => text.length > 0),
    () => "none",
  );
