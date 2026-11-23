@driver:memory
Feature: A toy feature that won't parse
  It is not a spec: specs are test/features/*.feature.

  Scenario: a step table with rows of different widths
    When someone files 1 issues
      | one | two |
      | three |
