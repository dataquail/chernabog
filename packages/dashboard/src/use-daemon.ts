// The one hook the page follows the daemon through: it reads /api/events,
// holds what live.ts makes of it, asks /api/status again for events, and
// connects again, backing off, when the stream drops or the listener is gone.

import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { useEffect, useState } from "react";

import { daemonFeed, FeedFailed } from "./feed.ts";
import { hear, initial, type Live, type Message, reconnectDelay } from "./live.ts";
import { type Attempt, describeSetting, type Notice, sendSetting } from "./settings.ts";
import { loadStatus } from "./status.ts";

const ENDED = new FeedFailed({ reason: "dropped", message: "the daemon ended the event stream" });

// Follows the daemon that served the page at `origin` for as long as it runs,
// telling `onLive` each time what the page holds changes.
export const follow = (
  origin: string,
  onLive: (live: Live) => void,
): Effect.Effect<never, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const state = yield* Ref.make(initial);
    const attempts = yield* Ref.make(0);

    const told: (message: Message) => Effect.Effect<void, never, HttpClient.HttpClient> = (
      message,
    ) =>
      Effect.gen(function* () {
        const followed = yield* Ref.modify(state, (live) => {
          const next = hear(live, message);

          return [next, next.live];
        });

        yield* Effect.sync(() => {
          onLive(followed.live);
        });

        for (const delay of Option.toArray(followed.refetchIn)) {
          yield* Effect.forkChild(
            loadStatus(origin).pipe(
              Effect.option,
              Effect.delay(delay),
              Effect.flatMap((status) => told({ kind: "refetched", status })),
            ),
          );
        }
      });

    // A snapshot means the stream is up: the next drop backs off from the start.
    const connection = Stream.runForEach(daemonFeed(origin), (heard) =>
      Effect.andThen(
        Ref.set(attempts, 0).pipe(Effect.when(Effect.succeed(heard.kind === "snapshot"))),
        told(heard),
      ),
    ).pipe(
      Effect.match({
        onFailure: (failure): Message => ({ kind: "failed", failure }),
        onSuccess: (): Message => ({ kind: "failed", failure: ENDED }),
      }),
    );

    return yield* Effect.forever(
      Effect.gen(function* () {
        yield* told(yield* connection);
        yield* Effect.sleep(reconnectDelay(yield* Ref.getAndUpdate(attempts, (n) => n + 1)));
      }),
    );
  });

// What the page holds from the daemon that served it.
export const useDaemon = (origin: string): Live => {
  const [live, setLive] = useState<Live>(initial);

  useEffect(() => {
    const following = Effect.runFork(
      follow(origin, setLive).pipe(Effect.provide(FetchHttpClient.layer)),
    );

    return () => {
      Effect.runFork(Fiber.interrupt(following));
    };
  }, [origin]);

  return live;
};

// The controls' settings, sent to the daemon that served the page at
// `origin`, and what the page says of the last one. The page hears of the
// change itself on /api/events, as every other connected page does.
export const useSettings = (origin: string) => {
  const [notice, setNotice] = useState<Option.Option<Notice>>(Option.none());

  const said = (kind: Notice["kind"], text: string) => {
    setNotice(Option.some({ kind, text }));
  };

  const act = (attempt: Attempt) => {
    if (attempt.kind === "invalid") {
      said("problem", attempt.message);

      return;
    }

    Effect.runFork(
      sendSetting(origin, attempt.setting).pipe(
        Effect.match({
          onFailure: (refused) => {
            said("problem", refused.message);
          },
          onSuccess: () => {
            said("done", describeSetting(attempt.setting));
          },
        }),
        Effect.provide(FetchHttpClient.layer),
      ),
    );
  };

  return { act, notice };
};

// The time now, again each second, for what the page shows relative to it.
export const useNow = (): number => {
  const [now, setNow] = useState(() => Effect.runSync(Clock.currentTimeMillis));

  useEffect(() => {
    const ticking = Effect.runFork(
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((millis) =>
          Effect.sync(() => {
            setNow(millis);
          }),
        ),
        Effect.repeat(Schedule.spaced(Duration.seconds(1))),
      ),
    );

    return () => {
      Effect.runFork(Fiber.interrupt(ticking));
    };
  }, []);

  return now;
};
