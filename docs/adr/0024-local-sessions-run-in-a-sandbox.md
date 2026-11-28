# 24. Local agent sessions run in a Docker or Podman sandbox, and reach the hub through a session API

Status: accepted, 2026-11-25. Epic [#711](https://github.com/dataquail/chernabog/issues/711)
(#712 to #729). Builds on [ADR 23](0023-runs-execute-in-spokes.md) (the hub,
its spokes, and how a run ends) and [ADR 17](0017-state-changing-commands-go-through-the-daemon.md)
(`POST /commands/:tag` on the daemon's socket). Decisions 1 to 11 are the
epic's, as its owner wrote them. Where the epic leaves something open, this
record settles it and says so with **(settled here)**; each such point is a
reviewer's to overturn before the task that builds it starts.

## Context

On a person's own machine an agent session runs as that person. Codex runs
in its own workspace sandbox (`sandbox_mode="workspace-write"`). Claude runs
with `--permission-mode auto` and no sandbox at all: it can read `~/.ssh`,
`~/.config/chernabog`, every other repo and anything else the user can. The
local gate then runs the code the agent just wrote, on the host,
unsandboxed.

GitHub Actions and remote compute already isolate a run, so they are out of
scope. This record is about the run on a person's computer.

Today an interactive session talks to chernabog through files. The launcher
(Orca, tmux, a person's own) runs `chernabog __launch <spec.json>`
(`launchers/shim.ts`), which starts the agent in the foreground on the
launcher's terminal with exactly the spec's environment. Claude's Stop hook
is `chernabog __stop-hook --dir <session dir>` and its AskUserQuestion hook
`chernabog __question-hook --dir <session dir>`, host processes that read
and write the session dir (`session-files.ts`): `answer.json`, which the
agent writes, `done`, `blocks`, `draft.json` and `reminded`. The spoke waits
for `done`. None of that works from a container: the binary isn't there,
and neither is the session dir.

## How it fits together

```
launcher terminal (Orca tab, tmux pane)
  └─ chernabog __launch spec.json            host, the person's user
       └─ docker|podman run -it --rm --init  host CLI; the container runs in the runtime's VM on macOS
            └─ claude …                      inside: worktree, common git dir, session mounts
                 │  hooks, answer, allowlisted commands
                 ▼  HTTP over TCP, bearer token
            host.docker.internal | host.containers.internal | 127.0.0.1
                 ▼
            hub's session API  ──reads/writes──▶  session dir  ◀──polls done──  spoke
```

- **The launcher still owns the terminal.** Orca or tmux runs
  `chernabog __launch` as today. With a sandbox, the process `__launch`
  starts is `docker run -it --rm --init …` or `podman run -it --rm --init …`
  in the foreground, so the launcher shows the agent's TUI exactly as now
  and a hangup on the terminal ends the container. The container never
  reaches the launcher.
- **The agent reaches chernabog over HTTP, not files.** The hooks and the
  answer become calls to a session-scoped HTTP API on the hub (decisions 6
  and 8), over TCP. A container reaches the host at
  `host.containers.internal` (Podman) or `host.docker.internal` (Docker). A
  unix socket doesn't cross the VM boundary of `podman machine` or Docker
  Desktop on macOS, so the daemon's socket is no use here.
- **The worktree and the repo's common git dir are mounted at the same path
  inside as outside.** A worktree's `.git` file names its git dir by
  absolute path, and the hub's git checks, the spoke and Orca all name the
  worktree by its host path. Mounting both at the same path keeps every one
  of them agreeing with the agent about where things are.
- **Each repo owns its image.** `chernabog sandbox init` writes a template
  Dockerfile into `.chernabog/sandbox/`, which the repo edits to add its
  toolchain. Chernabog builds and caches it locally. There is no published
  base image (decision 11).

## Decisions

1. **Providers are `none | docker | podman`, set per repo as `sandbox`,
   independent of `launcher`.** So `orca` with `podman` works, as does
   `headless` with `docker`. macOS and Linux are supported.

   **Windows is out of scope**, because the same-path mount doesn't hold
   there. A worktree's `.git` file and the common git dir's `worktrees/*/gitdir`
   hold Windows paths (`C:\Users\…`), which aren't paths in a Linux
   container, and a WSL2 checkout is seen from Windows under another path
   again. No mount makes the host's and the container's paths the same, so
   git, the hub and the launcher would each see a different worktree. A
   later epic has to answer that.

   **Where the setting lives (settled here).** It is resolved as the
   launcher is (`resolveLauncher` in `repo-config.ts`):
   - **Repo config** (`.chernabog/config.yaml`, read from the trusted tree)
     holds `sandbox`, the repo's default, and `allowedSandboxes`, the
     providers a machine may choose. Unset `sandbox` is `none`; unset
     `allowedSandboxes` allows any of the three.
   - **Machine config** may choose, in this order: the repo's entry
     (`repos.<repo>.sandbox`, or its persona's entry, beside `launcher`),
     then machine config's own `sandbox`, then the repo's default.
   - A choice outside `allowedSandboxes` fails the repo with a config error
     naming the layer that chose it, as a launcher outside
     `allowedLaunchers` does. Nothing falls back.

   So a team that requires a sandbox writes
   `allowedSandboxes: [docker, podman]`, and each person picks the runtime
   they have. The resolved provider is carried in the launch spec (#716).
   A machine choosing differs from the launcher only in its default: an
   unset launcher is `headless`, an unset sandbox `none`.

2. **A sandbox that can't start refuses the run.** The runtime missing or
   not running, the image failing to build, the account having no Claude
   token (decision 7): each refuses the run, saying what is missing and how
   to fix it. Nothing falls back to `none`. `chernabog doctor` checks the
   same things ahead of time (#723).

3. **Sessions with a person present are sandboxed like unattended ones.**
   `withPerson` changes how a session finishes, not where it runs.

4. **Claude first.** Codex in a container is its own task (#724), because
   its own workspace sandbox tends to fail when nested inside one. Until it
   lands, a repo whose sandbox isn't `none` refuses a Codex session (by
   decision 2) rather than running it on the host. opencode and custom
   adapters refuse the same way **(settled here)**.

   **(#724 settles:** Codex runs in the container too, with its own sandbox
   off (`sandbox_mode="danger-full-access"`). Codex's `workspace-write`
   sandbox is Landlock and seccomp on Linux, and needs what a container's
   default seccomp profile and capabilities deny, so nested in one it fails
   the commands it runs; turning it on would mean widening the container
   (`--privileged`, `seccomp=unconfined`), which weakens the sandbox that
   matters. The container already holds only the worktree, the common git
   dir and the session's own files, and the network is open by decision 5,
   so Codex's sandbox would add nothing inside it.

   Codex runs headless (`codex exec`), so its adapter runs the container
   itself, `<runtime> run -i --rm --init` with the prompt on stdin, under
   any launcher, rather than `__launch` on a terminal. It gets the same
   mounts, labels, user mapping and hangup handling (its adapter removes the
   session's containers by label however the call ends), with
   `CODEX_HOME` a dir of the session's own, `codex/` in its session dir,
   read-write at its host path, in place of Claude's config dir: its
   threads' rollouts stay there, for `codex exec resume` and for what a
   call spent (ADR 18). The call's schema and last-message files sit in a
   scratch dir of the session dir, mounted too.

   Codex's credentials go as Claude's do (decision 7), through the env and
   by name. Codex has no long-lived token like `claude setup-token`'s: its
   ChatGPT login is the `auth.json` that `codex login` keeps in the
   account's `CODEX_HOME`. So the session's env carries that file's
   contents as `CHERNABOG_CODEX_LOGIN`, read from the account on this
   machine at each call rather than a copy kept in the chernabog home,
   which would go stale as Codex refreshes it. The container's entry
   (`sh -c`) writes it into the session's `CODEX_HOME` as `auth.json`,
   0600, unsets the variable and execs `codex`, so the commands Codex runs
   don't have it in their env. When the call ends, a login Codex refreshed
   in there is written back to the account's `auth.json`, only if it is
   the same account's and newer, because a refresh retires the refresh
   token the host holds; then the session's copy is removed. An account
   whose login isn't a ChatGPT one in that file (an API key's, or one kept
   in the keyring) is refused, naming `codex login`. Two calls of one
   account that both refresh at once can still race, as two machines
   sharing a login do.**)**

5. **The network is open in v1**, as in Sandcastle. Filtering outbound
   traffic is a later epic.

6. **The session API serves every session, sandboxed or not.** An
   unsandboxed session reaches it at `127.0.0.1`. The file-based hooks,
   `__stop-hook`, `__question-hook` and the session-dir files only they
   used, are retired (#714), leaving one protocol. A hook needs nothing
   from the `chernabog` binary: it is Claude Code's HTTP hook if the
   installed Claude has one, otherwise a command hook that is a `curl`
   call, so the template image installs `curl`. Headless sessions
   (`claude -p`) use no hooks and don't change.

7. **Claude's credentials** are a `claude setup-token` token per chernabog
   account, stored in the chernabog home, readable only by its owner, and
   passed through the launch spec's env as `CLAUDE_CODE_OAUTH_TOKEN`, with
   the persona's `GH_TOKEN` (#720). A sandboxed session can't read the
   macOS Keychain. Nothing goes into the image, and neither token is ever
   on a command line: `__launch` passes each variable to the runtime by
   name (`--env NAME`), so the values come from its own environment and
   never show in `ps`. The spec file stays owner-only, as today.

   For Codex's, see decision 4.

   **(#720 settles:** the token is at `keys/claude/<account>.token` in the
   chernabog home, 0600 in a 0700 directory, written by
   `chernabog accounts set-token <account>`, which reads it from stdin, or
   asks for it hidden in a terminal, and never takes it as an argument. An
   account's `oauthTokenEnv` doesn't stand in for it. A session whose
   account has no token is refused, naming the command. Of the persona's
   variables the session gets `GH_TOKEN` and the git config that answers
   github.com with it, not `GITHUB_TOKEN`; the implicit persona's is `gh`'s
   own login's token, which a container can't reach otherwise.**)**

8. **The session API lives on the hub** (ADR 23). It never exposes
   `POST /commands/:tag`. Each session gets its own token, scoped to its
   routes and revoked when the session ends. Its routes, its token scheme
   and how the hub tells that a session has ended are settled below, under
   _The session API_.

9. **Containers carry a run-id label.** Each is labelled
   `chernabog.run=<run id>` and `chernabog.session=<session id>`. Cancel,
   a bound's ending and the hub's reap (ADR 23, decisions 4, 5 and 7)
   remove a run's containers by label (`<runtime> rm -f` over
   `ps -a --filter label=chernabog.run=<id>`), never by name. The sweep
   removes any labelled container whose run has ended (#721).

10. **The local gate runs in the repo's image** when the repo has a
    sandbox, with the worktree and common git dir mounted as for the agent
    and no credentials or session mounts (#722). **So does the repo's
    `install` command (settled here):** a gate in a Linux container can't
    use `node_modules` (or any native build) that `install` produced on a
    macOS host, and running `install`'s scripts on the host would run code
    the repo can change outside the sandbox.

11. **No published base image** for now. The template is copied into each
    repo, and the repo's Dockerfile is the image.

### The session API (settled here)

The epic fixes that the API is on the hub, never reaches `POST /commands/:tag`,
and gives each session a token. These are the routes and the token scheme
#713 builds.

**The listener.** A TCP listener of its own, apart from the daemon's unix
socket and the dashboard's listener, opened whenever the hub starts (every
interactive session needs it, decision 6), on a port the OS picks. Its
router holds only the session routes: unlike the dashboard's listener, it
forwards nothing to the socket, so `/commands/…`, `/dashboard/…` and the
dashboard's `/api/…` don't exist on it rather than being filtered. It binds
`127.0.0.1`. Where a container runtime's host gateway doesn't reach the
host's loopback (Docker on Linux, whose `host-gateway` is the bridge's
address; rootless Podman on Linux, depending on its network mode), it also
binds the narrowest address that gateway reaches, never every interface.
Which address that is per runtime is #713's and #717's to find on Linux.
The token, not the address, is what guards the routes. A request with an
`Origin` header (a browser) is refused.

The process that is a run's hub serves its sessions: the daemon's hub for
its spokes, and the foreground `run` and `rehearse`, which are their own
hub (ADR 23, decision 9), open the same listener in-process. `ci run` under
Actions runs no interactive session and opens none.

**What a session is told.** Its launch spec's env carries
`CHERNABOG_SESSION_URL`, the base URL of its own routes,
`http://<host>:<port>/runs/<run id>/sessions/<session id>`, with `<host>`
`127.0.0.1`, `host.docker.internal` or `host.containers.internal` by the
resolved sandbox, and `CHERNABOG_SESSION_TOKEN`. They replace
`CHERNABOG_SESSION` (the session dir). The token goes only in an
`Authorization: Bearer` header, never in a URL, so no access log holds it.

**How a session uses them (#714).** Its settings file's hooks are Claude
Code's HTTP hooks (`"type": "http"`) on its stop and question routes, with
`Authorization: Bearer $CHERNABOG_SESSION_TOKEN` interpolated from the env
(`allowedEnvVars`), so the settings file holds no token. The prompt gives
the agent a `curl … -X PUT "$CHERNABOG_SESSION_URL/answer"` command that
reads the answer from a heredoc; a `422` makes curl fail with the reason.
Until #715 moves `chernabog open-pr` onto the API, a session with a person
also keeps `CHERNABOG_SESSION`, which `open-pr` finds the session dir by.
The hub hands a spoke the listener's port and the run's key in its
hand-over file, written owner-only. A process that is its own hub answers
only the runs it started and hasn't ended. A run with no session API (the
hub couldn't open one, or a key wasn't handed over) refuses an interactive
session, saying so.

**The routes**, each under `/runs/:run/sessions/:session`:

| Route                   | Takes                                                           | Does                                                                                                                                                                                             |
| ----------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST …/stop`           | Claude's Stop hook input                                        | What `__stop-hook` decides today, case for case, including the git checks of `stop-hook.ts`; answers Claude's hook output (a block with its reason, or nothing)                                  |
| `POST …/question`       | Claude's `PreToolUse`/`PostToolUse` input for `AskUserQuestion` | What `__question-hook` does today (`open-pr-question.ts`); answers the hook output                                                                                                               |
| `PUT …/answer`          | the answer, as JSON                                             | Checks it against the call's schema (`checkAnswer`) and stores it where the stop route and the spoke read it; a `422` with the reason when it doesn't match, so the agent can fix it             |
| `POST …/commands/:name` | the command's arguments, as JSON                                | One of the allowlisted things an agent may ask of chernabog (#715): what the bundled prompts and recipes tell an agent to run, such as `open-pr --draft`, and nothing else; a test pins the list |

Whether a session works with a person is read from its own launch record
(`LaunchRecord.withPerson`), never taken from the request, so an agent can't
claim a person's leniency.

The routes act on the session dir in the chernabog home, as the hooks did:
the hub writes the answer, `done`, `blocks`, `draft.json` and `reminded`,
and the spoke goes on waiting for `done` as it does today. So the spoke still
opens no socket and the hub still learns of a run only from what it reads
on disk (ADR 23, decision 8). Only the writer moves, from a hook process to
the hub.

**The token.** Each hub start draws a random 256-bit key, held only in its
memory. A run's key is `HMAC-SHA256(hub key, run id)`, given to the run's
spoke in its hand-over file (owner-only, deleted with it). A session's token
is `base64url(HMAC-SHA256(run key, session id))`, minted by the spoke when it
writes the session's launch spec. The hub checks a request by deriving the
token from the path's run and session ids and comparing it in constant time.
That way:

- a token reaches only its own session's routes, because a token for one
  session id is never another's, and the listener has no other routes. The
  session's launch record also names the run that launched it, and the hub
  checks it against the path's run, so a run's key reaches no other run's
  sessions;
- the spoke mints a token without telling the hub, which ADR 23 forbids,
  and the hub needs no store of tokens;
- **a token is revoked when its session ends** (decision 8), checked on
  disk on every request, so the hub still stores no tokens. A session has
  ended once the `__launch` that runs it has: its `agent.pid` is gone
  (`__launch` removes it as it exits) or names no live process. The hub
  checks that the PID's command line names the session's own launch spec,
  as the agent adapter already does before it trusts a launcher, so a
  reused PID doesn't keep a session alive. Closing a session by its
  launcher handle, a hangup on its terminal and the agent exiting all end
  its `__launch`, so each revokes the token.
  A new call that resumes the same session starts a new `__launch`, and
  the session's token works again while it runs: it is the same session.
- **the run ending revokes too.** The hub also refuses every route of a run
  that isn't live (no running run with a live spoke, or a foreground run
  that isn't this process's), so a person's session that the reap spares
  (ADR 23, decision 7) can't reach the API for a run that has ended. A hub
  restart draws a new key and kills every token at once, which matches
  decision 7 of ADR 23 (spokes die with the hub).

A hook refused because its session or run has ended lets Claude stop:
nothing waits on it any more.

### The container (#717, #718, #719)

- **Mounts.** The worktree and the common git dir, read-write, at their
  host paths. On top of the common git dir, its `config` and `hooks/`
  read-only **(settled here)** (below), each where it exists. A Claude
  config dir of the session's own, `claude/` in its session directory under
  the chernabog home, read-write at its host path, set as Claude's
  `CLAUDE_CONFIG_DIR` **(settled here)**: Claude writes its transcripts
  there, where the hub's idle bound and the adapter's token usage (ADR 18,
  ADR 23 decision 4) read them on the host. Its settings file, read-only at
  its host path. **(#717 amends:** only the `claude/` dir and the settings
  file, not the whole session directory, so the agent can't write `done` or
  `answer.json` past the answer route's check, nor read its spec. The
  config dir is seeded with onboarding done and the worktree trusted, as a
  runner's `~/.claude.json` is.**)** Nothing else of the home.
- **Env.** Exactly the spec's env, passed by name (`--env NAME`), the
  values in the runtime CLI's own environment. **(#717 amends:** a
  sandboxed session's spec env holds none of the host's variables: its
  PATH and HOME name nothing in the image. It holds the repo's and
  persona's (less the PATH a repo pins), the account's token, the session
  API's URL and token, and `GIT_AUTHOR_*`/`GIT_COMMITTER_*` from the host's
  git config in the worktree, since the person's `~/.gitconfig` isn't
  mounted. #720 narrows it to what decision 7 allows.**)** **(#720
  amends:** of the repo's and persona's, only the persona's `GH_TOKEN` and
  its git credential config, so nothing a repo adds and no other
  credential.**)**
- **User.** Commits come out owned by the person: `--userns=keep-id` for
  rootless Podman, and the image's uid/gid build arguments for Docker.
  **(#717 amends:** Docker also runs with `--user <uid>:<gid>`, so an image
  built without them still writes as the person; as root, neither maps.**)**
- **The hub's address.** Docker on Linux gets
  `--add-host=host.docker.internal:host-gateway`, and the hub binds the
  bridge's address as well (#713). Docker Desktop and Podman name the host
  themselves. Rootless Podman on Linux reaching the hub's loopback depends
  on its network mode, and is for #729 to verify on Linux.
- **A hangup.** The runtime's CLI dies with the terminal, but a container
  outlives its client, so `__launch` catches SIGHUP and SIGTERM and removes
  the session's containers by its label before it exits.
- **Image.** Built from `.chernabog/sandbox/` in the tree the hub trusted
  (ADR 23's `--tree`), never from the worktree, so an agent that edits the
  Dockerfile doesn't change its own sandbox until the change is merged and
  trusted **(settled here)**. Cached under a tag named for the repo and a
  hash of the directory's contents, and rebuilt when that hash changes.
  Until #719 builds it, the image is the one `CHERNABOG_SANDBOX_IMAGE`
  names in the hub's environment, and a session is refused without one.
  A repo whose flows run Codex needs `codex` (and `sh`) on the image's
  `PATH`: the template `sandbox init` writes (#718) carries the Codex CLI
  as an optional step, off unless the repo turns it on **(#724 settles)**.

## Threat model

**Accidents and prompt injection**, not hostile code built to escape a
container. The sandbox keeps an agent that was told, or decided, to read
`~/.ssh`, another repo or the chernabog home from reaching them, and keeps
the gate's run of the agent's code off the host.

What stays reachable, on purpose:

- **The credentials passed in**: Claude's token or Codex's ChatGPT login,
  and the persona's `GH_TOKEN`. An injected agent can use them, as it can today.
- **The network**, open in v1 (decision 5), so an agent can send what it
  can read anywhere.
- **The worktree and the common git dir**, read-write: the agent's work.
- **Its own session API routes**, and nothing else of the hub's.

**Code that runs on the host later (settled here).** The common git dir is
shared with every worktree of the repo, including a person's own checkout,
and git runs code it names: `config` (`core.hooksPath`, `core.fsmonitor`,
`core.sshCommand`, filters) and `hooks/`. A container that could write them
would run code on the host the next time anyone ran git there. So both are
mounted read-only over the read-write common git dir, and chernabog's own
git calls on the host in a sandboxed repo's worktrees (the hub's checks,
the push) run with hooks off (`-c core.hooksPath=/dev/null`). A repo's
hooks still run inside the container, where the agent and the gate do.
What a person runs by hand in the worktree afterwards is the agent's code,
as it always was.

## Rejected

- **Sandcastle itself, or a sandbox inside the launcher.** The container
  would have to own the terminal, or the launcher learn about containers.
  Wrapping the process `__launch` starts keeps every launcher unchanged.
- **A unix socket mounted into the container.** It doesn't cross the VM of
  Docker Desktop or `podman machine` on macOS.
- **Mounting the session dir and keeping the file hooks.** It would need the
  `chernabog` binary inside the image, built for Linux, and leave two
  protocols. One API for every session (decision 6) is what the hooks
  become anyway.
- **Forwarding the session routes through the dashboard's listener, or
  filtering the socket's router.** Both start from everything and take
  away. A router that holds only session routes can't be wrong about
  `/commands/:tag`.
- **Tokens the hub stores.** The spoke would have to tell the hub about a
  session as it starts, and ADR 23 has spokes push nothing; a token the
  hub learned only from a folded journal could be refused for the seconds
  before the fold. A derived token needs neither.
- **Falling back to `none`** when the runtime is missing (decision 2), and
  **letting a machine choose `none`** when the repo allows only containers.
  A team's requirement that runs aren't on the host would then hold only
  where nothing went wrong.
- **A published base image** (decision 11), for now.

## Consequences

- An interactive session needs the hub's listener to finish. A hub that
  can't open it refuses interactive runs, as decision 2 refuses a sandbox
  that can't start.
- A sandboxed repo pays an image build the first time and whenever its
  sandbox directory changes, and every session pays a container start.
- The local gate and `install` produce Linux artefacts in the worktree for
  a sandboxed repo. A person who switches the repo back to `none` reinstalls.
- Windows stays where it is: no sandbox, and `docker`/`podman` refuse there.
- The tasks build it: the session API (#713), the hooks and answer over it
  (#714), the agent's commands over it (#715), the setting (#716), the
  container (#717), `sandbox init` (#718), the image (#719), credentials
  (#720), container cleanup (#721), the gate (#722), `doctor` (#723), Codex
  (#724), the behavior spec and its run (#725, #726, #727), the website
  (#728) and verification (#729). Each one that departs from this record
  amends it, as #667 did ADR 23.
