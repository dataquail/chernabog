import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { effectAtHomeWith } from "../../../../../test/effect-test.ts";
import { execTestLayer } from "../../../../platform/exec.ts";
import { Home } from "../../../../platform/home.ts";
import { ServiceManagerClient } from "../../domain/ports/clients/service-manager.client.ts";
import {
  launchAgentPlist,
  serviceEnv,
  ServiceManagerClientLive,
  systemdUnit,
} from "./service-manager.client-live.ts";

const ran: Array<string> = [];

// systemctl answers, and remembers what it was asked; on Linux.
const effect = effectAtHomeWith(
  execTestLayer((command, args) => {
    ran.push([command, ...args].join(" "));

    return Option.liftPredicate(
      { exitCode: 0, stdout: "", stderr: "" },
      () => command === "systemctl",
    );
  }),
  "linux",
);

describe("ServiceManagerClientLive", () => {
  test("launchd runs the daemon with the installer PATH and restarts it", () => {
    const plist = launchAgentPlist(
      ["/usr/local/bin/chernabog"],
      { PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/Users/dev" },
      "/Users/dev/.config/chernabog/daemon.log",
    );

    expect(plist).toContain(
      "<string>/usr/local/bin/chernabog</string>\n    <string>daemon</string>",
    );
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("<string>/opt/homebrew/bin:/usr/bin</string>");
  });

  test("systemd quotes what needs it", () => {
    const unit = systemdUnit(
      ["/home/dev/bin/chernabog"],
      { PATH: "/home/dev/my tools:/usr/bin" },
      "/tmp/daemon.log",
    );

    expect(unit).toContain("ExecStart=/home/dev/bin/chernabog daemon");
    expect(unit).toContain('Environment="PATH=/home/dev/my tools:/usr/bin"');
    expect(unit).toContain("Restart=always");
  });

  test("the service keeps the installer PATH and HOME, and CHERNABOG_HOME only when set", () => {
    expect(serviceEnv({ PATH: "/bin", CHERNABOG_HOME: "/tmp/om" }, "/Users/dev")).toEqual({
      PATH: "/bin",
      HOME: "/Users/dev",
      CHERNABOG_HOME: "/tmp/om",
    });
    expect(serviceEnv({}, "/Users/dev")).toEqual({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/Users/dev",
    });
  });

  effect("installs a systemd user service on Linux, and removes it again", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = (yield* Home).user;
      const manager = yield* ServiceManagerClient;
      const unit = `${home}/.config/systemd/user/chernabog.service`;

      expect(
        yield* manager.start.pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        ),
      ).toBe("the daemon is not installed; run chernabog install");
      expect(yield* manager.install).toBe(unit);
      expect(yield* fs.readFileString(unit)).toContain("Restart=always");
      expect(yield* manager.installed).toBe(true);
      expect(ran).toContain("systemctl --user enable --now chernabog.service");

      expect(yield* manager.uninstall).toBe(unit);
      expect(yield* manager.installed).toBe(false);
    }).pipe(Effect.provide(ServiceManagerClientLive)),
  );
});
