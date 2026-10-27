import { describe, expect, test } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";

import {
  causeOf,
  eventTickAt,
  localCause,
  noteEvent,
  notificationCause,
} from "./event-tick.value-object.ts";

const at = (seconds: number) =>
  DateTime.makeUnsafe(Date.parse("2026-10-27T12:00:00Z") + seconds * 1000);

describe("event ticks", () => {
  test("a burst of events makes one tick, from the first event", () => {
    const first = noteEvent(Option.none(), "local: #7 pull request opened", at(0));
    const burst = noteEvent(Option.some(first), "local: #7 review requested", at(2));

    expect(burst.since).toEqual(at(0));
    expect(causeOf(first)).toBe("local: #7 pull request opened");
    expect(causeOf(burst)).toBe("local: #7 pull request opened (+1 more)");
  });

  test("a tick runs once the burst settles, and no sooner than the least time after the last", () => {
    const pending = noteEvent(Option.none(), "local: run ended", at(10));
    const min = Duration.seconds(30);

    expect(eventTickAt(pending, Option.none(), min)).toEqual(at(13));
    expect(eventTickAt(pending, Option.some(at(0)), min)).toEqual(at(30));
    expect(eventTickAt(pending, Option.some(at(-60)), min)).toEqual(at(13));
  });

  test("a cause names the work item it was about, when there is one", () => {
    expect(localCause("review requested", Option.some(73))).toBe("local: #73 review requested");
    expect(localCause("run ended", Option.none())).toBe("local: run ended");
    expect(notificationCause("review_requested", Option.some(73))).toBe(
      "notification: review_requested on #73",
    );
    expect(notificationCause("mention", Option.none())).toBe("notification: mention");
  });
});
