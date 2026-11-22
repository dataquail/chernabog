// The settings every module's mutation run shares (#586, from the spike's
// findings in docs/testing/mutation-spike.md). A module's config names what it
// mutates and the tests it runs against; this sets how.

// One module's Stryker config. `name` is its folder under reports/mutation/.
// `testFiles` is always an explicit list: never discovered, never
// test/acceptance/. `timeoutMS` is added to each mutant's measured test time
// before Stryker scores it Timeout; a module whose tests wait in real time
// raises it, since under load those waits turn into false Timeout kills.
export const mutationConfig = (name, { mutate, testFiles, timeoutMS = 10000 }) => ({
  testRunner: "bun",
  appendPlugins: ["@hughescr/stryker-bun-runner", "./tools/stryker/ignore-messages.mjs"],
  ignorers: ["message-text"],
  mutate,
  testFiles,
  bun: {
    // As `bun run test` runs them.
    bunArgs: ["--timeout=15000"],
    // The dry run runs the whole selection once, in one process.
    timeout: 300000,
  },
  coverageAnalysis: "perTest",
  // Required. In Stryker's sandbox, node_modules/@chernabog/* stays a
  // symlink to the real, unmutated packages/, so every SDK mutant would
  // appear to survive. In place, Stryker rewrites the files it mutates for
  // the length of the run and restores them from .stryker-tmp/ at the end.
  inPlace: true,
  // Bun doesn't type-check, and this keeps Stryker from writing
  // `// @ts-nocheck` across the tree.
  disableTypeChecks: false,
  cleanTempDir: true,
  incremental: true,
  incrementalFile: `reports/mutation/${name}/stryker-incremental.json`,
  timeoutMS,
  ...concurrency(process.env.MUTATION_CONCURRENCY),
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: `reports/mutation/${name}/mutation.html` },
  jsonReporter: { fileName: `reports/mutation/${name}/mutation.json` },
});

// MUTATION_CONCURRENCY sets how many test processes run at once; unset, it is
// Stryker's own default.
const concurrency = (value) =>
  value === undefined || value === "" ? {} : { concurrency: Number(value) };
