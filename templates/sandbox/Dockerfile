# The image this repo's agent sessions and local gate run in, when its
# sandbox is docker or podman (.chernabog/config.yaml). It is a Containerfile
# too: Podman builds it as it is.
#
# Written by `chernabog sandbox init`, and the repo's own from then on: edit
# it, commit it and merge it. Chernabog builds the image from the copy on the
# trusted base branch, never from a worktree, and rebuilds it when this
# directory changes.
#
# Chernabog mounts the worktree and the repo's git dir at their host paths and
# passes the session's environment (the Claude token and GH_TOKEN among it) by
# name, so nothing secret belongs in here.

FROM debian:bookworm-slim

# What every session needs: git for the work, gh for pull requests and curl
# for the hooks, which reach chernabog's session API over HTTP.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git gnupg \
  && install -d -m 0755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# The repo's toolchain goes here: whatever its install and localGate commands
# need (a Node, Bun, Python, Go or Rust toolchain, system libraries, …),
# installed as root. For example:
#
#   RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
#     && apt-get install -y --no-install-recommends nodejs \
#     && rm -rf /var/lib/apt/lists/*
# ---------------------------------------------------------------------------

# The user sessions run as. Chernabog passes the person's uid and gid, so
# what the agent writes in the worktree is theirs on the host. A gid the
# image already has (macOS's staff, 20, is one) is used as it is.
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN if ! getent group "$AGENT_GID" > /dev/null; then groupadd --gid "$AGENT_GID" agent; fi \
  && useradd --uid "$AGENT_UID" --gid "$AGENT_GID" --create-home --shell /bin/bash agent

USER agent
WORKDIR /home/agent

# The Claude Code CLI, from its native installer, into ~/.local/bin. Chernabog
# rebuilds the image to update it, so it doesn't update itself.
ENV DISABLE_AUTOUPDATER=1
ENV PATH="/home/agent/.local/bin:${PATH}"
RUN curl -fsSL https://claude.ai/install.sh | bash \
  && claude --version

# The Codex CLI, for a repo whose flows run Codex: set INSTALL_CODEX=true to
# install it into ~/.local/bin, beside claude. Off by default, so a repo that
# runs only Claude doesn't download it.
ARG INSTALL_CODEX=false
RUN if [ "$INSTALL_CODEX" = "true" ]; then \
    target="$(uname -m)-unknown-linux-musl" \
    && curl -fsSL "https://github.com/openai/codex/releases/latest/download/codex-${target}.tar.gz" \
      | tar -xz -C /tmp \
    && install -m 0755 "/tmp/codex-${target}" /home/agent/.local/bin/codex \
    && rm "/tmp/codex-${target}" \
    && codex --version; \
  fi

# ---------------------------------------------------------------------------
# Toolchain steps that install into the user's home (rustup, a version
# manager, …) go here, after USER agent.
# ---------------------------------------------------------------------------
