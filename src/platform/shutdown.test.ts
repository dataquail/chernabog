import { describe, expect, test } from "bun:test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { effect } from "../../test/effect-test.ts";
import {
  armShutdownDeadline,
  type ShutdownHost,
  type StdinHost,
  stopWhenStdinCloses,
} from "./shutdown.ts";

type Listener = () => void;

// A process a test signals by hand, whose timers it fires by hand.
const fakeHost = () => {
  const listeners = new Map<string, Array<Listener>>();
  const timers: Array<{ readonly millis: number; readonly fire: Listener }> = [];
  const exits: Array<number> = [];
  const warnings: Array<string> = [];

  const host: ShutdownHost = {
    on: (signal, listener) => {
      listeners.set(signal, [...(listeners.get(signal) ?? []), listener]);
    },
    off: (signal, listener) => {
      listeners.set(
        signal,
        (listeners.get(signal) ?? []).filter((one) => one !== listener),
      );
    },
    exit: (code) => {
      exits.push(code);
    },
    after: (millis, fire) => {
      timers.push({ millis, fire });
    },
    warn: (line) => {
      warnings.push(line);
    },
  };

  const signal = (name: string) => {
    for (const listener of listeners.get(name) ?? []) {
      listener();
    }
  };

  return { host, signal, timers, exits, warnings, listeners };
};

describe("armShutdownDeadline", () => {
  test("a first signal starts the deadline, and the process exits when it passes", () => {
    const fake = fakeHost();
    armShutdownDeadline(fake.host, Duration.seconds(3));

    fake.signal("SIGTERM");

    expect(fake.exits).toEqual([]);
    expect(fake.timers.map((timer) => timer.millis)).toEqual([3000]);

    for (const timer of fake.timers) {
      timer.fire();
    }

    expect(fake.exits).toEqual([143]);
    expect(fake.warnings[0]).toContain("still stopping after 3s");
  });

  test("a second Ctrl-C exits at once", () => {
    const fake = fakeHost();
    armShutdownDeadline(fake.host, Duration.seconds(3));

    fake.signal("SIGINT");
    fake.signal("SIGINT");

    expect(fake.exits).toEqual([130]);
  });

  test("disarmed, it leaves the signals alone", () => {
    const fake = fakeHost();
    const disarm = armShutdownDeadline(fake.host, Duration.seconds(3));

    disarm();
    fake.signal("SIGINT");

    expect(fake.timers).toEqual([]);
    expect([...fake.listeners.values()].flat()).toEqual([]);
  });
});

describe("stopWhenStdinCloses", () => {
  // A stdin a test closes by hand, and the stops it caused.
  const fakeStdin = () => {
    let closed: Array<() => void> = [];
    const stops: Array<string> = [];

    const host: StdinHost = {
      watch: (listener) => {
        closed.push(listener);

        return () => {
          closed = closed.filter((one) => one !== listener);
        };
      },
      stop: () => {
        stops.push("SIGTERM");
      },
    };

    const close = () => {
      for (const listener of closed) {
        listener();
      }
    };

    return { host, close, stops };
  };

  effect("stops as on SIGTERM, once, when stdin closes", () => {
    const stdin = fakeStdin();

    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* stopWhenStdinCloses(stdin.host);
          stdin.close();
          stdin.close();
        }),
      );

      expect(stdin.stops).toEqual(["SIGTERM"]);
    });
  });

  effect("stops nothing when stdin closes after the scope has", () => {
    const stdin = fakeStdin();

    return Effect.gen(function* () {
      yield* Effect.scoped(stopWhenStdinCloses(stdin.host));
      stdin.close();

      expect(stdin.stops).toEqual([]);
    });
  });
});
