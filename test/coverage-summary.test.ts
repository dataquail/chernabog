import { describe, expect, test } from "bun:test";

import { declaresOnly, parseLcov, renderSummary, shortfalls, totals } from "../scripts/coverage.ts";

const LCOV = `TN:
SF:src/b.ts
FNF:4
FNH:2
DA:1,1
DA:2,0
LF:10
LH:5
end_of_record
TN:
SF:src/a.ts
FNF:2
FNH:2
LF:4
LH:4
end_of_record
TN:
SF:src/schema.ts
FNF:1
FNH:0
LF:6
LH:6
end_of_record
`;

describe("coverage summary", () => {
  const files = parseLcov(LCOV);

  test("reads each file's line and function counts from lcov.info", () => {
    expect(files).toEqual([
      { path: "src/b.ts", lines: { found: 10, hit: 5 }, functions: { found: 4, hit: 2 } },
      { path: "src/a.ts", lines: { found: 4, hit: 4 }, functions: { found: 2, hit: 2 } },
      { path: "src/schema.ts", lines: { found: 6, hit: 6 }, functions: { found: 1, hit: 0 } },
    ]);
  });

  test("totals are the mean of each file's fraction, as bun test gates on", () => {
    const { functions, lines } = totals(files);
    expect(lines).toBeCloseTo((0.5 + 1 + 1) / 3);
    expect(functions).toBeCloseTo((0.5 + 1 + 0) / 3);
  });

  test("a module whose every line ran but whose one function did not only declares", () => {
    expect(files.map(declaresOnly)).toEqual([false, false, true]);
    expect(
      declaresOnly({ path: "x.ts", lines: { found: 6, hit: 2 }, functions: { found: 1, hit: 0 } }),
    ).toBe(false);
  });

  test("renders totals against the threshold, and each file sorted by path", () => {
    expect(renderSummary(files, { lines: 0.8, functions: 0.5 })).toBe(
      [
        "## Coverage",
        "",
        "| | Measured | Threshold | |",
        "| --- | ---: | ---: | --- |",
        "| Lines | 83.33% | 80.00% | ✅ |",
        "| Functions | 50.00% | 50.00% | ✅ |",
        "",
        "<details><summary>3 files</summary>",
        "",
        "| File | Lines | Functions |",
        "| --- | ---: | ---: |",
        "| `src/a.ts` | 100.00% | 100.00% |",
        "| `src/b.ts` | 50.00% | 50.00% |",
        "| `src/schema.ts` | 100.00% | n/a |",
        "",
        "Functions is n/a for a module that only declares: Bun counts it one function that never ran, though every line did.",
        "",
        "</details>",
        "",
      ].join("\n"),
    );
  });

  test("marks a total below its threshold, and names it as a shortfall", () => {
    const summary = renderSummary(files, { lines: 0.9, functions: 0.5 });
    expect(summary).toContain("| Lines | 83.33% | 90.00% | ❌ |");
    expect(summary).toContain("| Functions | 50.00% | 50.00% | ✅ |");
    expect(shortfalls(files, { lines: 0.9, functions: 0.5 })).toEqual([
      "lines coverage is 83.33%, below the floor of 90.00%",
    ]);
    expect(shortfalls(files, { lines: 0.8, functions: 0.5 })).toEqual([]);
  });
});
