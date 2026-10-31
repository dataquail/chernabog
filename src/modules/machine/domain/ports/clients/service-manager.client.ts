import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type ServiceFailed } from "../../machine-setup/machine-setup.errors.ts";

// The daemon as a service of this machine's service manager: a launchd agent
// on macOS, a systemd user service on Linux, which restarts it on exit.
export type ServiceManagerClientService = {
  // Registers the daemon and starts it; the path of what it registered.
  readonly install: Effect.Effect<string, ServiceFailed>;
  // Stops it and removes it; the path it removed.
  readonly uninstall: Effect.Effect<string, ServiceFailed>;
  readonly installed: Effect.Effect<boolean>;
  // Rewrites the unit a former chernabog installed, from this same program
  // and home, to what this one installs; the path it rewrote, or none when
  // nothing is installed, it is current, or it isn't this program's.
  readonly refresh: Effect.Effect<Option.Option<string>, ServiceFailed>;
  readonly start: Effect.Effect<void, ServiceFailed>;
  // Stops the daemon until the next start or login.
  readonly stop: Effect.Effect<void, ServiceFailed>;
};

export class ServiceManagerClient extends Context.Service<
  ServiceManagerClient,
  ServiceManagerClientService
>()("ServiceManagerClient") {}
