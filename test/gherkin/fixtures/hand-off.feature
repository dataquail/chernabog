@driver:in-process @driver:sandbox
Feature: One persona hands work to another
  The drivers' own test feature: two personas on one machine taking turns,
  alice writing and bob reviewing, the same on every driver. It is not a
  spec: specs are test/features/*.feature.

  Background:
    Given alice and bob are personas on this machine
    And bob reviews for the team

  Scenario: alice's pull request goes to bob for review
    When someone files an issue labelled "auto:ship"
    Then alice opens a pull request for it
    And alice asks bob to review it
    And bob asks for changes on 1 line of alice's pull request

  Scenario: alice disputes bob's review, and it waits for a person
    Given alice will disagree with the changes a review asks for
    When someone files an issue labelled "auto:ship"
    Then bob asks for changes on 1 line of alice's pull request
    And alice answers the review in the session she wrote it in
    And it is handed to a person
    When the machine has nothing left to do
    Then alice pushed once
    And nobody merged it
