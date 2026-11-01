// `chernabog ui`: the dashboard in a browser. The daemon opens its 127.0.0.1
// listener when asked over its socket, and keeps it open across restarts
// until `chernabog ui stop`.

import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { execOk } from "../../platform/exec.ts";
import {
  daemonDashboard,
  daemonDashboardRotateToken,
  daemonDashboardStart,
  daemonDashboardStop,
} from "../daemon/daemon.client.ts";
import { type DashboardStart, type DashboardState } from "../daemon/daemon.protocol.ts";
import { fail } from "./cli.output.ts";

const portFlag = Flag.Int("port").pipe(
  Flag.withDescription(
    "The port on 127.0.0.1 to open the dashboard on (default: the last one asked for, else 4848)",
  ),
  Flag.optional,
);

const startRequest = (port: Option.Option<number>): DashboardStart =>
  Option.match(port, { onNone: () => ({}), onSome: (asked) => ({ port: asked }) });

const running = (state: DashboardState) => `the dashboard is running at ${state.url}`;

// What a person reads when the daemon isn't there or refuses.
const said = <A, R>(
  effect: Effect.Effect<
    A,
    { readonly _tag: "DaemonUnavailable" | "DaemonRefused"; readonly message: string },
    R
  >,
) =>
  effect.pipe(
    Effect.asVoid,
    Effect.catch((error) => fail(error.message)),
  );

// The program that opens a URL in the person's default browser.
const opener = () => {
  if (process.platform === "darwin") {
    return "open";
  }

  return "xdg-open";
};

const uiStart = Command.make("start", { port: portFlag }, ({ port }) =>
  said(
    daemonDashboardStart(startRequest(port)).pipe(
      Effect.tap((state) => Console.log(running(state))),
    ),
  ),
).pipe(Command.withDescription("Open the dashboard on 127.0.0.1, and print its URL"));

const uiStop = Command.make("stop", {}, () =>
  said(
    daemonDashboardStop.pipe(
      Effect.tap((state) =>
        Console.log(
          `the dashboard is stopped; chernabog ui start opens it on port ${state.port} again`,
        ),
      ),
    ),
  ),
).pipe(Command.withDescription("Close the dashboard's listener"));

const uiStatus = Command.make("status", {}, () =>
  said(
    daemonDashboard.pipe(
      Effect.tap((state) =>
        Console.log(
          Option.getOrElse(
            Option.liftPredicate(running(state), () => state.running),
            () => `the dashboard is not running; chernabog ui start opens it on port ${state.port}`,
          ),
        ),
      ),
    ),
  ),
).pipe(Command.withDescription("Say whether the dashboard is running, and where"));

const openInBrowser = (url: string) =>
  execOk(opener(), [url]).pipe(
    Effect.andThen(Console.log(`opened ${url}`)),
    Effect.catch((error) => fail(`couldn't open a browser (${error.message}); open ${url}`)),
  );

export const uiCommand = Command.make(
  "ui",
  {
    port: portFlag,
    print: Flag.Boolean("print").pipe(
      Flag.withDescription("Print the dashboard's URL instead of opening it in the browser"),
      Flag.withDefault(false),
    ),
    rotateToken: Flag.Boolean("rotate-token").pipe(
      Flag.withDescription(
        "Make a new token first, so the URL a browser or bookmark holds no longer opens the dashboard",
      ),
      Flag.withDefault(false),
    ),
  },
  ({ port, print, rotateToken }) =>
    said(
      Effect.gen(function* () {
        if (rotateToken) {
          yield* daemonDashboardRotateToken;
        }

        const now = yield* daemonDashboard;

        // Started if it's off, or moved to the port asked for.
        let state = now;

        if (!now.running || Option.getOrElse(port, () => now.port) !== now.port) {
          state = yield* daemonDashboardStart(startRequest(port));
        }

        if (print) {
          return yield* Console.log(state.url);
        }

        yield* openInBrowser(state.url);
      }),
    ),
).pipe(
  Command.withDescription(
    "Open the dashboard in the browser, starting it on 127.0.0.1 if it's off (start, stop, status)",
  ),
  Command.withSubcommands([uiStart, uiStop, uiStatus]),
);
