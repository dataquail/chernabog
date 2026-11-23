@driver:memory
Feature: A toy feature
  The runner's own test feature, run on the memory driver. It is not a spec:
  specs are test/features/*.feature.

  Background:
    Given alice is a persona on this machine

  Scenario: an issue is filed
    When someone files an issue labelled "auto:ship"
    Then there is 1 issue
    And the issue is labelled "auto:ship"

  Scenario Outline: several issues are filed
    When someone files <count> issues
    Then there are <count> issues
    And the issues are numbered <numbers>

    Examples:
      | count | numbers |
      | 2     | 1, 2    |
      | 3     | 1, 2, 3 |

  @driver:in-process
  Scenario: a scenario another driver runs too
    When someone files 1 issues
    Then there is 1 issue
