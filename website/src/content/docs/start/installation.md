---
title: Installation
description: Install the chernabog binary with Homebrew, from a release, or from source.
---

| Method                       | Platforms                           | Upgrades                  |
| ---------------------------- | ----------------------------------- | ------------------------- |
| [Homebrew](#homebrew)        | macOS, Linux; arm64 and x64         | `brew upgrade chernabog`  |
| [Release binary](#release-binary) | macOS, Linux; arm64 and x64    | by hand                   |
| [From source](#from-source)  | anywhere Bun builds                 | by hand                   |

## Homebrew

```bash
brew install dataquail/tap/chernabog
```

The formula installs the release binary for your platform and pulls in `gh`. Each release updates it. Then [set up the machine](#set-up-the-machine).

After an upgrade, move the daemon onto the new version:

```bash
brew upgrade chernabog
chernabog stop && chernabog start
```

The daemon's service, and the hooks Chernabog writes for agents, name the binary by its `$(brew --prefix)/opt/chernabog` path rather than its versioned `Cellar` path, which `brew upgrade` deletes. They keep working across upgrades.

## Release binary

Each release attaches one self-contained binary per platform — `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64` — and a `sha256` file.

```bash
target=darwin-arm64
tag=$(gh api repos/dataquail/chernabog/releases --jq '[.[].tag_name | select(startswith("v"))][0]')
gh release download "$tag" --repo dataquail/chernabog \
  --pattern "chernabog-$tag-$target.tar.gz" --pattern "chernabog-$tag-sha256.txt"
grep -- "-$target.tar.gz" "chernabog-$tag-sha256.txt" | shasum -a 256 -c -
tar -xzf "chernabog-$tag-$target.tar.gz"
mv chernabog ~/.local/bin/
```

- **Tags.** The binary's start with `v`, the SDK's with `sdk-v`. GitHub's "latest release" is sometimes the SDK's, so the second line picks the newest `v` tag.
- **Gatekeeper.** macOS binaries are signed ad hoc, not notarized. Download with `gh` or `curl`; a browser download is blocked.

To upgrade, `chernabog stop`, install the new binary the same way, then `chernabog start`. `mv` replaces the file rather than writing over it, which macOS requires of a signed binary that is running; `cp` over it gets the process killed.

## From source

```bash
git clone https://github.com/dataquail/chernabog && cd chernabog
bun install
bun run build                        # dist/chernabog
mv dist/chernabog ~/.local/bin/
```

Every method needs `git`, `gh` logged in with the `repo` scope, and your agent's own CLI. See [Requirements](/chernabog/start/introduction/#requirements).

## Set up the machine

```bash
chernabog install
```

`install` runs `chernabog setup`, then registers the daemon as a launchd agent or systemd user unit and starts it. `setup` writes `~/.config/chernabog/config.yaml`, asking only what it has to, and is safe to run again to add a login or an account.

- **GitHub personas.** The logins `gh auth status` lists, asked without `GH_TOKEN`. With one, it's added without asking, alongside any already in machine config; with several, you pick which ones Chernabog [acts as](/chernabog/reference/configuration/#github-personas). It won't drop a login an enrolled repo still runs as. With none, runs act as `GH_TOKEN` or `gh`'s active account.
- **AI accounts.** It finds `~/.claude*` and `~/.codex*` directories that machine config doesn't have yet and asks which to add, then asks for any others, such as `~/.claude-personal` behind a `pclaude` alias, and which agent each is for when the name doesn't say. It stores the account's config directory, home-relative, and its agent, never the alias, and names the account after the directory: `~/.claude-personal` becomes `claude-personal`. Without `accounts:`, machine config has one implicit account, `work`, on `~/.claude`; the first time `setup` writes `accounts:` it keeps `work` there too.

| Flag                         | Answers                                                          |
| ---------------------------- | ---------------------------------------------------------------- |
| `--persona <a,b>`            | the GitHub logins to act as; each must be logged in to `gh`      |
| `--account <dir[:agent],…>`  | the account directories to add, such as `~/.codex-work:codex`; the agent is inferred from a name like `.codex-work` |

Both commands take both flags. Piped and without them, `setup` still takes a single `gh` login, leaves the personas as they are when there are several, and adds an account only when machine config has no `accounts:` yet and it finds exactly one.

Then [set up a repo](/chernabog/start/set-up-a-repo/).
