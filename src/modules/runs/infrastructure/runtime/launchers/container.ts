// How `chernabog __launch` runs a sandboxed session's agent (ADR 24, "The
// container"): `docker run` or `podman run`, in the foreground on the
// launcher's terminal, so Orca and tmux show the agent's TUI unchanged. The
// worktree, the repo's common git dir and the session's own mounts sit at
// their host paths, the container gets exactly the spec's environment, each
// variable passed by name so no value is on a command line, and it carries
// the run's and session's labels, by which a hangup on the terminal (and
// cancel, and the sweep) remove it.

import type { SandboxName } from "@chernabog/core";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const RUN_LABEL = "chernabog.run";
export const SESSION_LABEL = "chernabog.session";

// The host a container reaches its hub's session API at, by sandbox; an
// unsandboxed session reaches it at loopback.
export const sessionApiHostFor = (sandbox: SandboxName, loopback: string) => {
  if (sandbox === "docker") {
    return "host.docker.internal";
  }

  if (sandbox === "podman") {
    return "host.containers.internal";
  }

  return loopback;
};

// Until each repo's image is built (#719), the image a sandboxed session runs
// in is named on the host by this variable.
export const SANDBOX_IMAGE_ENV = "CHERNABOG_SANDBOX_IMAGE";

export const ContainerMount = Schema.Struct({
  path: Schema.String,
  readOnly: Schema.optionalKey(Schema.Boolean),
});

export type ContainerMount = typeof ContainerMount.Type;

// What a launch spec adds for a sandboxed session.
export const ContainerSpec = Schema.Struct({
  image: Schema.String,
  // Each at its host path inside the container: a read-only one goes over
  // the read-write one it is under, so it comes after it.
  mounts: Schema.Array(ContainerMount),
  labels: Schema.Record(Schema.String, Schema.String),
});

export type ContainerSpec = typeof ContainerSpec.Type;

// What `__launch` knows of the machine it runs on.
export type ContainerHost = {
  readonly platform: string;
  readonly uid: Option.Option<number>;
  readonly gid: Option.Option<number>;
  // Whether its stdin is a terminal, for -t: a runtime refuses a TTY it hasn't got.
  readonly tty: boolean;
};

export type ContainerCommand = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
};

// Commits come out owned by the person: rootless Podman maps them to the
// container's user with keep-id, and Docker runs as their uid and gid, which
// the image's build arguments give its user too (#719). As root, neither
// needs mapping.
const userArgs = (runtime: "docker" | "podman", host: ContainerHost) => {
  const ids = Option.all([host.uid, host.gid]).pipe(Option.filter(([uid]) => uid !== 0));

  return Option.match(ids, {
    onNone: () => [],
    onSome: ([uid, gid]) => {
      if (runtime === "podman") {
        return ["--userns=keep-id"];
      }

      return ["--user", `${uid}:${gid}`];
    },
  });
};

// On Linux, Docker names the host's gateway only when asked; Docker Desktop
// and Podman name theirs themselves.
const hostArgs = (runtime: "docker" | "podman", host: ContainerHost) => {
  if (runtime === "docker" && host.platform === "linux") {
    return ["--add-host=host.docker.internal:host-gateway"];
  }

  return [];
};

const ttyArgs = (host: ContainerHost) => {
  if (host.tty) {
    return ["-it"];
  }

  return ["-i"];
};

const mountArg = (mount: ContainerMount) => {
  if (mount.readOnly === true) {
    return `${mount.path}:${mount.path}:ro`;
  }

  return `${mount.path}:${mount.path}`;
};

export const containerRunArgs = (
  runtime: "docker" | "podman",
  agent: ContainerCommand,
  container: ContainerSpec,
  host: ContainerHost,
): ReadonlyArray<string> => [
  "run",
  ...ttyArgs(host),
  "--rm",
  "--init",
  ...Object.entries(container.labels).flatMap(([name, value]) => ["--label", `${name}=${value}`]),
  ...container.mounts.flatMap((mount) => ["--volume", mountArg(mount)]),
  "--workdir",
  agent.cwd,
  ...Object.keys(agent.env).flatMap((name) => ["--env", name]),
  ...userArgs(runtime, host),
  ...hostArgs(runtime, host),
  container.image,
  agent.command,
  ...agent.args,
];

// The containers a session runs, by its label, for `rm -f`.
export const sessionContainersArgs = (sessionId: string): ReadonlyArray<string> => [
  "ps",
  "-aq",
  "--filter",
  `label=${SESSION_LABEL}=${sessionId}`,
];

// The containers labelled with the run `runId`, or with any run, for `rm -f`
// and the sweep (#721).
export const runContainersArgs = (runId: Option.Option<string>): ReadonlyArray<string> => [
  "ps",
  "-aq",
  "--filter",
  Option.match(runId, {
    onNone: () => `label=${RUN_LABEL}`,
    onSome: (id) => `label=${RUN_LABEL}=${id}`,
  }),
];

// Each container's id, run label and session label, a line each, tab-separated:
// Docker and Podman both answer `inspect` with the container's labels under
// .Config.Labels, where a missing one is empty.
export const containerLabelsArgs = (ids: ReadonlyArray<string>): ReadonlyArray<string> => [
  "inspect",
  "--format",
  `{{.Id}}\t{{index .Config.Labels "${RUN_LABEL}"}}\t{{index .Config.Labels "${SESSION_LABEL}"}}`,
  ...ids,
];

export type ContainerLabels = {
  readonly id: string;
  readonly runId: string;
  readonly sessionId: Option.Option<string>;
};

// What `inspect` with containerLabelsArgs printed, less any container with no
// run label.
export const parseContainerLabels = (stdout: string): ReadonlyArray<ContainerLabels> =>
  stdout.split("\n").flatMap((line) => {
    const [id = "", runId = "", sessionId = ""] = line.trim().split("\t");

    if (id.length === 0 || runId.length === 0) {
      return [];
    }

    return [{ id, runId, sessionId: Option.liftPredicate(sessionId, (named) => named.length > 0) }];
  });

// A path `--volume` can't name: its `:` separates the host path from the rest.
export const unmountable = (path: string) => path.includes(":");
