---
title: Sandbox
description: Run a repo's agent sessions and local gate in a Docker or Podman container on your own machine, what that protects, and how to set it up.
---

On your own machine an agent session runs as you. Without a sandbox, Claude can read `~/.ssh`, `~/.config/chernabog`, your other repos and anything else your account can, and the local gate then runs the code the agent just wrote on the host. A repo's [`sandbox`](/chernabog/reference/configuration/#sandbox) setting, `docker` or `podman`, runs each agent session, and the repo's `install` and `localGate` commands, in a container built from the repo's own image instead. [ADR 24](https://github.com/dataquail/chernabog/blob/main/docs/adr/0024-local-sessions-run-in-a-sandbox.md) has the why.

This is about runs on your computer. [GitHub Actions](/chernabog/operate/github-actions/) runners already isolate a run. macOS and Linux are supported; on Windows `docker` and `podman` refuse.

## What it protects against

The threat is **accidents and prompt injection**: an agent that was told, by a crafted issue or a file it read, or decided by itself, to read your keys, another repo or the chernabog home. It isn't hostile code built to escape a container; the container is the runtime's ordinary isolation, not a hardened one.

A container sees only:

- **the worktree** and **the repo's common git dir**, read-write, at the same paths as on the host, so git, chernabog and Orca all agree where things are. The git dir's `config` and `hooks/` are mounted read-only on top, so an agent can't plant a hook or a `core.fsmonitor` that would run on the host the next time anyone runs git there, and chernabog's own git calls on the host in a sandboxed repo's worktrees run with hooks off;
- **a Claude config dir of the session's own**, under the chernabog home, where Claude writes its transcripts, and the session's settings file, read-only;
- **its own routes of chernabog's session API**, with a token that reaches nothing else and stops working when the session ends.

Nothing else of your home is mounted, and none of your own environment variables reach it.

What stays reachable, on purpose:

- **The credentials passed in**: the account's Claude token and the persona's `GH_TOKEN` (and, for Codex, the account's ChatGPT login). An injected agent can use them, as it could without a sandbox.
- **The network**, which is open: an agent can send anything it can read anywhere. Filtering outbound traffic is later work.
- **The worktree and the git dir**: the agent's work. What you run by hand in the worktree afterwards is the agent's code, as it always was.

## Install a runtime

Pick the one you have, or would rather have. The repo decides which a person may choose (`allowedSandboxes`), and you choose within that.

### macOS

Containers run in a Linux VM, and a container can mount only what the VM shares. Chernabog mounts the repo's worktrees, which live under `~/.config/chernabog/worktrees/`, and the repo's git dir, which is in your checkout, so the VM must share both.

- **Docker**: install [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/) and start it. Under **Settings > Resources > File sharing**, share your home (or the folders above your checkouts and `~/.config/chernabog`), then apply and restart. Another VM your `docker` CLI talks to, such as Colima's, works if it shares the same folders.
- **Podman**: `brew install podman`, then create its machine sharing those folders and start it:

  ```sh
  podman machine init --volume "$HOME:$HOME"
  podman machine start
  ```

  A machine's shares are fixed when it's made. To share another folder, `podman machine rm`, then `init` it again with every `--volume` it should have.

Both name the host for a container themselves (`host.docker.internal`, `host.containers.internal`), which is how a session reaches chernabog.

### Linux

- **Docker**: install [Docker Engine](https://docs.docker.com/engine/install/), `sudo systemctl start docker`, and add yourself to the `docker` group. Chernabog adds `--add-host=host.docker.internal:host-gateway` to each container and listens on the bridge's address as well as loopback, so a firewall must let the bridge (`docker0`) reach chernabog's port.
- **Podman**: install it from your distribution ([podman.io](https://podman.io/docs/installation)). Rootless Podman runs each container with `--userns=keep-id`; if `podman info` complains after an upgrade, `podman system migrate`. A firewall must let `podman0` reach chernabog's port.

Either way, files the agent writes in the worktree are yours on the host: Podman by `--userns=keep-id`, Docker by running as your uid and gid.

## Turn it on

In the repo's `.chernabog/config.yaml`, set the default and what's allowed:

```yaml
sandbox: podman
allowedSandboxes: [docker, podman]
```

A person picks their own within `allowedSandboxes`, in machine config: `sandbox` on the repo's entry (or one of its personas), or machine config's own `sandbox` for every repo. [Configuration](/chernabog/reference/configuration/#sandbox) has the order. A team that requires a container leaves `none` out of `allowedSandboxes`; a machine that chooses it then fails the repo with a config error, rather than running on the host.

A sandbox that can't start refuses the run, saying what's missing and how to fix it. Nothing falls back to running on the host.

## Write the image

Each repo owns its image. There's no published base image: the template is copied into the repo, which edits it from then on.

```sh
chernabog sandbox init
```

writes `.chernabog/sandbox/Dockerfile` (Podman builds it as a Containerfile as it is), and refuses to write over one that's there. The template is Debian with git, gh, curl (which the session's hooks use to reach chernabog) and the Claude Code CLI, a user `agent` whose uid and gid come from the `AGENT_UID` and `AGENT_GID` build arguments, and two marked places for the repo's toolchain:

- **as root**, before the user is made: whatever the repo's `install` and `localGate` commands need, such as a Node, Bun, Python, Go or Rust toolchain and system libraries;
- **as `agent`**, at the end: toolchains that install into the user's home, such as rustup or a version manager.

A repo whose flows run Codex sets the `INSTALL_CODEX` argument to `true`, which installs the Codex CLI beside `claude`.

Keep secrets out of it: chernabog passes the tokens a session needs through its environment, never into the image.

Commit the Dockerfile and merge it to the base branch, then [trust](/chernabog/operate/trust/) the new tree. Chernabog builds the image from the copy on the trusted base branch, never from a worktree, so an agent that edits the Dockerfile doesn't change its own sandbox until a person merges and trusts the change. It builds before the first session that needs it, passing your uid and gid, tags it `chernabog-sandbox/<owner>-<name>:<hash>` from the directory's contents and those ids, and builds again whenever the directory changes. A build that fails refuses the session, quoting its error, with the last 200 lines of its output in the run's log. Old tags aren't removed: `<runtime> image prune` or `<runtime> rmi` clears them.

The local gate and `install` run in the same image, so they produce Linux artefacts in the worktree, `node_modules` included. If you switch a repo back to `none`, reinstall.

## Give Claude a token

A container can't read the macOS Keychain or your Claude login, so each Claude account a sandboxed repo runs needs a long-lived token from `claude setup-token`. Run it as that account, and hand what it prints to chernabog:

```sh
claude setup-token | chernabog accounts set-token work
```

or run `chernabog accounts set-token work` and paste it when asked; it's never taken as an argument. Chernabog keeps it at `~/.config/chernabog/keys/claude/<account>.token`, readable only by you, and passes it to the session as `CLAUDE_CODE_OAUTH_TOKEN`, with the persona's `GH_TOKEN` (for the implicit persona, `gh`'s own login's). Each is passed by name, so neither value is on a command line. A session whose account has no token is refused, naming the command.

Codex needs no extra step: its sandboxed calls use the ChatGPT login `codex login` keeps for the account, and refuse an account signed in with an API key or the keyring.

## Check it with doctor

`chernabog doctor` checks each repo with a sandbox ahead of time, and says how to fix each check that fails. A check that fails leaves out the ones that need it.

| Check | When it fails |
| ----- | ------------- |
| the runtime is installed | install Docker Desktop or Docker Engine, or Podman (on macOS, `brew install podman`, then `podman machine init` and `podman machine start`) |
| on macOS with Podman, its machine is running | `podman machine start`, or `podman machine init` first if `podman machine list` shows none |
| `<runtime> info` answers (on macOS, Docker's VM is running) | start Docker Desktop or your VM; on Linux start the docker service, or see what `podman info` says |
| `.chernabog/sandbox/Dockerfile` is on the base branch and the image builds | `chernabog sandbox init`, then commit and merge it; or fix the Dockerfile until `<runtime> build` passes. Doctor builds the image as a session would, so the next session reuses it |
| on macOS, the VM shares the folders the repo's worktrees and git dir live in | share them in Docker Desktop's file sharing, or recreate Podman's machine with `--volume` for each |
| a container from the image reaches chernabog's session API | on macOS, the VM must forward `host.docker.internal` or `host.containers.internal`; on Linux a firewall must let the bridge reach chernabog's port; and the image needs `curl`. Doctor opens a listener of its own as the daemon does, and asks it with `curl` from the container |
| each Claude account a sandboxed session signs in with has its token | `claude setup-token` as that account, into `chernabog accounts set-token <account>` |

## What it looks like

The same as without one. The launcher still owns the terminal: Orca (or tmux) runs `chernabog __launch` as before, and with a sandbox the process that starts is `docker run -it --rm --init …` or `podman run -it --rm --init …` in the foreground. So an Orca tab on the worktree shows the agent's live TUI, you can type into it, and a session [with a person](/chernabog/agents/launchers/#with-a-person) is sandboxed just like an unattended one. Hooks, questions and the final answer go through the session API either way, so they work the same.

Claude runs sandboxed only under an interactive launcher; with the `headless` launcher, a sandboxed repo's Claude sessions refuse. Codex runs headless in its container under any launcher. opencode and custom adapters refuse in a sandboxed repo.

## Cleaning up

Every container is labelled with its run and session (`chernabog.run`, `chernabog.session`). Closing the terminal removes the session's container. `chernabog cancel` removes a run's containers by label, except those of sessions it leaves open, and the daemon removes, at its start and every minute, any container whose run has ended and whose `__launch` is gone. Nothing removes a container by name. The local gate's containers are removed when each command ends.
