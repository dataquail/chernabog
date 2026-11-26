// The addresses beside loopback that a container runtime's host gateway
// reaches on this machine, for the hub's session API to bind as well (ADR 24,
// "The listener"). On macOS, Docker Desktop and `podman machine` forward
// host.docker.internal and host.containers.internal to the host's loopback,
// so there are none. On Linux, Docker's `host-gateway` is the docker0
// bridge's address, and rootful Podman's is its bridge's (podman0, or
// cni-podman0 before netavark): each bridge that exists gives its IPv4
// address, never every interface. Rootless Podman's host gateway depends on
// its network mode, and is #717's to settle.

import { networkInterfaces } from "node:os";

import * as Option from "effect/Option";

export const CONTAINER_BRIDGES: ReadonlyArray<string> = ["docker0", "podman0", "cni-podman0"];

// What the gateways are read from: each interface's addresses, by name, as
// os.networkInterfaces() lists them.
export type Interfaces = Readonly<
  Partial<
    Record<
      string,
      ReadonlyArray<{
        readonly address: string;
        readonly family: string;
        readonly internal: boolean;
      }>
    >
  >
>;

export const containerGateways = (
  platform: string = process.platform,
  interfaces: Interfaces = networkInterfaces(),
): ReadonlyArray<string> => {
  if (platform !== "linux") {
    return [];
  }

  return CONTAINER_BRIDGES.flatMap((bridge) =>
    Option.getOrElse(Option.fromUndefinedOr(interfaces[bridge]), () => [])
      .filter((address) => address.family === "IPv4" && !address.internal)
      .map((address) => address.address),
  );
};
