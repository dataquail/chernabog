Feature: A broken toy feature
  Each scenario fails, each for its own reason, when the runner's tests run
  broken.entry.ts. It is not a spec: specs are test/features/*.feature.

  @driver:memory
  Scenario: a step nothing defines
    When something nobody defined happens

  @driver:memory
  Scenario: a step two definitions match
    When something happens twice

  Scenario: a scenario with no driver tag
    When someone files 1 issues

  @driver:memory @driver:nonesuch
  Scenario: a scenario naming no known driver
    When someone files 1 issues

  @driver:memory
  Scenario: a step that fails
    When someone files 1 issues
    Then there are 5 issues
