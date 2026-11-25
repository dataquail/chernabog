@driver:in-process @driver:sandbox
Feature: A pull request that changes a spec waits for a person
  A spec is a behavior file under test/features that a person approved.
  alice and bob are two personas on one machine: alice writes the pull
  requests and bob reviews them. carol is a person, not a persona. A pull
  request that changes a spec goes on only once a person has approved the
  spec as it stands, and nothing a persona does stands in for that.

  Background:
    Given alice and bob are personas on this machine
    And alice and bob both review for the team

  Scenario: a pull request that changes a spec is handed to a person
    When someone files an auto:ship issue whose fix changes a spec
    Then alice opens a pull request for it
    And it is handed to a person
    And nobody on this machine reviews it
    And it is left for a person to merge

  Scenario: a spec changed on a pull request already in review is handed to a person
    When someone files an auto:ship issue
    Then alice opens a pull request for it
    And bob asks for changes on one line
    When carol, a person, changes a spec on it
    And bob is asked to review it
    Then it is handed to a person
    And it is left for a person to merge

  Scenario: a persona's approval doesn't let it go on
    When someone files an auto:ship issue whose fix changes a spec
    Then alice opens a pull request for it
    And it is handed to a person
    When bob approves it
    And someone hands it back to the personas
    And bob is asked to review it
    Then it is handed to a person again
    And it is left for a person to merge

  Scenario: handing it back without a person's approval doesn't stick
    When someone files an auto:ship issue whose fix changes a spec
    Then alice opens a pull request for it
    And it is handed to a person
    When someone hands it back to the personas
    Then it is handed to a person again
    And nobody on this machine reviews it

  Scenario: a person's approval of the spec lets the personas go on
    When someone files an auto:ship issue whose fix changes a spec
    Then alice opens a pull request for it
    And it is handed to a person
    When carol, a person, approves it and hands it back to the personas
    Then bob reviews it
    And bob approves it and merges it

  Scenario: changing the spec again needs a new approval
    Given alice will change the spec again when she fixes her pull request
    When someone files an auto:ship issue whose fix changes a spec
    Then alice opens a pull request for it
    And it is handed to a person
    When carol, a person, approves it and hands it back to the personas
    Then bob asks for changes on one line
    And alice fixes it
    And it is handed to a person again
    And bob does not review it again
    And it is left for a person to merge
