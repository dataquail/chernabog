import { describe, expect, test } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import {
  decideTick,
  describeElsewhere,
  freeSlots,
  nextTick,
  routeItems,
  spreadMinute,
  withinHours,
} from "../src/schedule.ts";
import { stableExecutable } from "../src/self.ts";
import { launchAgentPlist, serviceEnv, systemdUnit } from "../src/service.ts";

const local = DateTime.zoneMakeLocal();

// A wall-clock time today, in this machine's zone.
const at = (clock: string) =>
  DateTime.toUtc(
    DateTime.makeZonedUnsafe(`2026-10-17T${clock}:00`, {
      timeZone: local,
      adjustForTimeZone: true,
    }),
  );

const localMinute = (time: DateTime.Utc) => DateTime.toParts(DateTime.setZone(time, local)).minute;

describe("schedules", () => {
  test("repos spread across the hour", () => {
    expect([0, 1, 2].map((index) => spreadMinute(index, 3))).toEqual([0, 20, 40]);
  });

  test("the next tick follows the cron expression, seconds included", () => {
    expect(Option.map(nextTick("17 * * * *", at("10:20")), localMinute)).toEqual(Option.some(17));
    expect(
      Option.map(
        nextTick("*/2 * * * * *", DateTime.makeUnsafe("2026-10-17T10:00:01Z")),
        DateTime.formatIso,
      ),
    ).toEqual(Option.some("2026-10-17T10:00:02.000Z"));
    expect(nextTick("not a schedule", at("10:00"))).toEqual(Option.none());
  });

  test("hours are local, and a range may wrap midnight", () => {
    expect(withinHours("09:00-18:00", at("12:30"))).toBe(true);
    expect(withinHours("09:00-18:00", at("18:00"))).toBe(false);
    expect(withinHours("22:00-07:00", at("23:15"))).toBe(true);
    expect(withinHours("22:00-07:00", at("06:59"))).toBe(true);
    expect(withinHours("22:00-07:00", at("12:00"))).toBe(false);
  });
});

describe("machine limits", () => {
  const open = {
    enabled: true,
    flowOff: Option.none<string>(),
    paused: false,
    quietHours: Option.none<string>(),
    activeHours: Option.none<string>(),
    now: at("12:00"),
  };

  test("a tick goes ahead unless something holds it back, and says what", () => {
    expect(decideTick(open).go).toBe(true);
    expect(decideTick({ ...open, paused: true })).toEqual({ go: false, reason: "paused" });
    expect(decideTick({ ...open, quietHours: Option.some("11:00-13:00") })).toEqual({
      go: false,
      reason: "quiet hours (11:00-13:00)",
    });
    expect(decideTick({ ...open, activeHours: Option.some("13:00-17:00") })).toEqual({
      go: false,
      reason: "outside active hours (13:00-17:00)",
    });
    expect(decideTick({ ...open, flowOff: Option.some("flow turned off") })).toEqual({
      go: false,
      reason: "flow turned off",
    });
  });

  test("free slots are the smaller of the flow and the machine limit", () => {
    expect(
      freeSlots({
        activeForFlow: 0,
        flowConcurrency: 2,
        activeOnMachine: 1,
        machineConcurrency: 2,
      }),
    ).toBe(1);
    expect(
      freeSlots({
        activeForFlow: 1,
        flowConcurrency: 1,
        activeOnMachine: 1,
        machineConcurrency: 4,
      }),
    ).toBe(0);
  });
});

describe("routing by assignee and requested reviewer", () => {
  const issue = (key: string, assignees: ReadonlyArray<string>) => ({ key, data: {}, assignees });

  // issue-3 comes from a trigger that says nothing about assignees.
  const issues = [
    issue("issue-1", ["alice"]),
    issue("issue-2", []),
    { key: "issue-3", data: {} },
    issue("issue-4", ["Bob", "Alice"]),
  ];

  const pulls = [
    { key: "pr-5", data: {}, assignees: ["carol"], reviewers: ["alice"] },
    { key: "pr-6", data: {}, assignees: [], reviewers: [] },
  ];

  const keys = (routed: ReturnType<typeof routeItems>) => ({
    mine: routed.mine.map((found) => found.key),
    elsewhere: routed.elsewhere.map((found) => found.key),
  });

  const routing = (
    assignee: Option.Option<ReadonlyArray<string>>,
    reviewRequested: Option.Option<ReadonlyArray<string>> = Option.none(),
  ) => ({ assignee, reviewRequested });

  test("without a filter, anything starts", () => {
    expect(keys(routeItems(issues, routing(Option.none()), Option.some("carol")))).toEqual({
      mine: ["issue-1", "issue-2", "issue-3", "issue-4"],
      elsewhere: [],
    });
  });

  test("@me is this machine, none is nobody, and a login is that person", () => {
    expect(
      keys(routeItems(issues, routing(Option.some(["@me", "none"])), Option.some("bob"))),
    ).toEqual({ mine: ["issue-2", "issue-3", "issue-4"], elsewhere: ["issue-1"] });
    expect(keys(routeItems(issues, routing(Option.some(["@me"])), Option.some("ALICE")))).toEqual({
      mine: ["issue-1", "issue-4"],
      elsewhere: ["issue-2", "issue-3"],
    });
    expect(keys(routeItems(issues, routing(Option.some(["Alice"])), Option.some("carol")))).toEqual(
      { mine: ["issue-1", "issue-4"], elsewhere: ["issue-2", "issue-3"] },
    );
  });

  test("with no known login, @me matches no one", () => {
    expect(keys(routeItems(issues, routing(Option.some(["@me", "none"])), Option.none()))).toEqual({
      mine: ["issue-2", "issue-3"],
      elsewhere: ["issue-1", "issue-4"],
    });
  });

  test("requested reviewers route pull requests, and every filter set must pass", () => {
    expect(
      keys(routeItems(pulls, routing(Option.none(), Option.some(["@me"])), Option.some("alice"))),
    ).toEqual({ mine: ["pr-5"], elsewhere: ["pr-6"] });
    expect(
      keys(
        routeItems(
          pulls,
          routing(Option.some(["@me"]), Option.some(["@me"])),
          Option.some("alice"),
        ),
      ),
    ).toEqual({ mine: [], elsewhere: ["pr-5", "pr-6"] });
    expect(describeElsewhere(routing(Option.some(["@me"]), Option.some(["@me"])))(pulls[1])).toBe(
      "pr-6 (assignee: none; review requested: none)",
    );
    expect(describeElsewhere(routing(Option.none(), Option.some(["@me"])))(pulls[0])).toBe(
      "pr-5 (review requested: alice)",
    );
  });
});

describe("the service", () => {
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

  test("a Homebrew binary is named by its opt path, which survives an upgrade", () => {
    expect(stableExecutable("/opt/homebrew/Cellar/chernabog/0.3.0/bin/chernabog")).toBe(
      "/opt/homebrew/opt/chernabog/bin/chernabog",
    );
    expect(
      stableExecutable("/home/linuxbrew/.linuxbrew/Cellar/chernabog/0.4.0_1/bin/chernabog"),
    ).toBe("/home/linuxbrew/.linuxbrew/opt/chernabog/bin/chernabog");
    expect(stableExecutable("/Users/dev/.local/bin/chernabog")).toBe(
      "/Users/dev/.local/bin/chernabog",
    );
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
});
