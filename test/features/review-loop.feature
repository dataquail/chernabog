@driver:in-process @driver:sandbox
Feature: The review loop
  alice and bob are two personas on one machine. alice writes the pull
  requests; bob is the team's reviewer. alice can review too, but never
  her own. Nobody steps in unless a scenario says a person does.

  Background:
    Given alice and bob are personas on this machine
    And alice and bob both review for the team

  @driver:ci @driver:live
  Scenario: bob asks for changes, alice fixes them, and bob merges
    When someone files an auto:ship issue
    Then alice opens a pull request for it
    And bob asks for changes on one line
    And alice fixes it
    And bob re-reviews the fix
    And bob approves the fixed pull request and merges it
    And alice never reviews her own pull request
    And it is never handed to a person

  Scenario: alice and bob each pick up their own session when they come back to it
    When someone files an auto:ship issue
    Then alice opens a pull request for it
    And bob asks for changes on one line
    And alice fixes it in the same session she wrote it in
    And bob re-reviews the fix in the same session he reviewed it in

  Scenario: alice disputes bob's review
    Given alice will disagree with the changes bob asks for
    When someone files an auto:ship issue
    Then alice opens a pull request for it
    And bob asks for changes on one line
    And alice answers the review with her reasons and pushes nothing
    And it is handed to a person
    And nobody is asked to review it again
    And it is left for a person to merge

  Scenario: a pull request a person opened
    When carol, a person, opens a pull request
    And only dave, who is not on this machine, is asked to review it
    Then nobody on this machine reviews it
    When bob is asked to review it
    Then bob reviews it
    And it is left for a person to merge
    And dave is still asked to review it
