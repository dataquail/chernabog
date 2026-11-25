@driver:container
Feature: A session runs in a sandbox
  alice is a persona on this machine, and the repo she works on runs its
  agent sessions in a container: its sandbox is docker or podman, and its
  image is built from the repo's own sandbox directory. The agent sees its
  worktree, the repo's common git dir and its own session's directory, at
  the same paths as on the host, and nothing else of the machine. It
  reaches chernabog only through its session's routes on the hub. A sandbox
  that can't start refuses the run rather than running the agent on the
  host, and a run that ends leaves no container behind.

  Background:
    Given alice is a persona on this machine
    And the repo runs its sessions in a sandbox

  Scenario: a sandboxed session finishes through the session API
    When someone files an auto:ship issue
    Then alice's session runs in a container labelled with its run
    And alice opens a pull request for it
    And her session's stop and answer reached chernabog through its session's routes
    And no container of the run is left once it ends

  Scenario: a sandboxed agent can't read outside its mounts
    Given the machine holds a secret file outside the worktree
    And alice will try to read the secret file
    When someone files an auto:ship issue
    Then alice's session runs in a container labelled with its run
    And alice cannot read the secret file
    And alice opens a pull request for it

  Scenario: a session's token reaches only its own session
    Given alice will try to call another session's routes and the daemon's commands
    When someone files an auto:ship issue
    Then both calls are refused
    And alice opens a pull request for it

  Scenario: a run refuses when the sandbox's runtime is missing
    Given the machine has no container runtime
    When someone files an auto:ship issue
    Then the run is refused, saying the runtime is missing and how to fix it
    And no agent session runs on the host
    And no pull request is opened

  Scenario: cancelling a sandboxed run leaves no container behind
    Given alice's session will wait until it is stopped
    When someone files an auto:ship issue
    Then alice's session runs in a container labelled with its run
    When someone cancels the run
    Then the run ends as cancelled
    And no container of the run is left
