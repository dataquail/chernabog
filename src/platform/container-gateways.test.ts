import { describe, expect, test } from "bun:test";

import { containerGateways } from "./container-gateways.ts";

const address = (family: string, at: string, internal = false) => ({
  address: at,
  family,
  internal,
});

const interfaces = {
  lo: [address("IPv4", "127.0.0.1", true)],
  eth0: [address("IPv4", "192.168.1.20")],
  docker0: [address("IPv4", "172.17.0.1"), address("IPv6", "fe80::1")],
  podman0: [address("IPv4", "10.88.0.1")],
};

describe("containerGateways", () => {
  test("on Linux, the IPv4 address of each container bridge, and never another interface", () => {
    expect(containerGateways("linux", interfaces)).toEqual(["172.17.0.1", "10.88.0.1"]);
  });

  test("none on Linux without a bridge, nor on macOS, whose runtimes reach loopback", () => {
    expect(containerGateways("linux", { lo: interfaces.lo, eth0: interfaces.eth0 })).toEqual([]);
    expect(containerGateways("darwin", interfaces)).toEqual([]);
  });
});
