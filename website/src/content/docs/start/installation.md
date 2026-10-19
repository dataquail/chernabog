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

The formula installs the release binary for your platform and pulls in `gh`. Each release updates it. Then [set up a repo](/chernabog/start/set-up-a-repo/), which ends by registering the daemon with `chernabog install`.

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
