# Changelog

## [0.8.0](https://github.com/dataquail/chernabog/compare/sdk-v0.7.0...sdk-v0.8.0) (2026-10-28)


### ⚠ BREAKING CHANGES

* after upgrading, an enrolled repo's implement and human-initiated flows (and any flow of its own that calls Implement.claim or Hybrid.claim) take a claim ref that only Claims.releasing lets go when the run ends. Update them with `chernabog recipes diff` / `recipes add`, or wrap the run in `Claims.releasing(Claims.issue(issue))`, then `chernabog trust` the repo. Until then, `chernabog cancel <run>` on the run a skip names deletes the claim ref it left.
* flows that let errors through no longer compile, and GitHub.merge fails with MergeRefused instead of returning MergeOutcome. Repos move their baked flows with `chernabog recipes diff`.
* remove the SDK's whole workflows and review-loop triggers; the recipes write them out ([#67](https://github.com/dataquail/chernabog/issues/67)) (#69)
* opt-in flow recipes, baked into the repo as code, chosen at init and later ([#67](https://github.com/dataquail/chernabog/issues/67)) (#68)
* the fix flow is gone, with Review.fixTrigger, Review.fixWorkflow, Review.FixItem and the fix prompt; address-review replaces them.
* the ship flow and the label-driven review loop are gone, with Review.labelVerdict, Review.reviewRound and Review.cleanUp; Review.trigger and Review.workflow now work from review requests. limits.reviewRounds defaults to 1.

### Features

* a flow with no trigger is manual, and runs only when a person names its work ([#74](https://github.com/dataquail/chernabog/issues/74)) ([#111](https://github.com/dataquail/chernabog/issues/111)) ([2e1c539](https://github.com/dataquail/chernabog/commit/2e1c5394eafe9473819a21c4174b9a13fa56ef96))
* a person's Yes, not the agent, opens the pull request on the hybrid path ([#128](https://github.com/dataquail/chernabog/issues/128)) ([5f6e7c9](https://github.com/dataquail/chernabog/commit/5f6e7c9fd8477f8e16ff2cf821ee156f1841700e))
* a plan recipe: an agent turns a spec issue into an epic of ordered sub-issues ([#140](https://github.com/dataquail/chernabog/issues/140)) ([28e264f](https://github.com/dataquail/chernabog/commit/28e264f2858673f57c5eac7a0b35a3a7c7f9a76d))
* act as several GitHub personas from one daemon ([#56](https://github.com/dataquail/chernabog/issues/56)) ([e83ddfe](https://github.com/dataquail/chernabog/commit/e83ddfed61b7ca33a58b5e73eb0a51a5d1ae68c2))
* answer a review that requests changes in the author's session, with address-review ([#54](https://github.com/dataquail/chernabog/issues/54)) ([#65](https://github.com/dataquail/chernabog/issues/65)) ([770505c](https://github.com/dataquail/chernabog/commit/770505c1f22cfda81d20148162a4e10b198e5494))
* claims are refs of their own, apart from the work branch ([#139](https://github.com/dataquail/chernabog/issues/139)) ([3fe9282](https://github.com/dataquail/chernabog/commit/3fe928220e25992096408a697641b8bff4bde5cf))
* give a flow's steps their own agents by role ([#38](https://github.com/dataquail/chernabog/issues/38)) ([3c1293e](https://github.com/dataquail/chernabog/commit/3c1293e94adbc5be78a365d2092deccbf955f11f))
* keep each persona's flow choices in machine config, keyed by repo slug ([#50](https://github.com/dataquail/chernabog/issues/50)) ([#60](https://github.com/dataquail/chernabog/issues/60)) ([9f2c65e](https://github.com/dataquail/chernabog/commit/9f2c65ea27cbbbc42adeecb59db43173b8bf1114))
* key a flow by its own label, and let a run own its pull request ([#39](https://github.com/dataquail/chernabog/issues/39)) ([80ea827](https://github.com/dataquail/chernabog/commit/80ea8274c41efc8ff90e6bb539368031c64be9c1))
* let a person's session push changes to humanOnlyPaths on the hybrid path ([#72](https://github.com/dataquail/chernabog/issues/72)) ([#73](https://github.com/dataquail/chernabog/issues/73)) ([9b0d0a3](https://github.com/dataquail/chernabog/commit/9b0d0a391f3811b815278f622534d45a84724068))
* log a Claude account in with a token from an environment variable ([#21](https://github.com/dataquail/chernabog/issues/21)) ([b566281](https://github.com/dataquail/chernabog/commit/b56628102c9a8dee19aac3e67b3ffde68c9c9234))
* opt-in flow recipes, baked into the repo as code, chosen at init and later ([#67](https://github.com/dataquail/chernabog/issues/67)) ([#68](https://github.com/dataquail/chernabog/issues/68)) ([a1d6db3](https://github.com/dataquail/chernabog/commit/a1d6db3602d5cbfdf24527ce60ca26a963f27bcf))
* PullRequest.merge, which merges only when that is safe ([#41](https://github.com/dataquail/chernabog/issues/41)) ([55559d1](https://github.com/dataquail/chernabog/commit/55559d1ea8685ced3a8644eb2f09b6da5c6a3af2))
* **recipes:** recipes as packages: @chernabog/recipes on its own cadence, company recipe packages, and flows that import a recipe ([#130](https://github.com/dataquail/chernabog/issues/130)) ([1d076c5](https://github.com/dataquail/chernabog/commit/1d076c5087bc48f18d91604878369354a1e21711))
* rehearse a flow end to end on a scratch repo, with stand-ins for the agent ([#121](https://github.com/dataquail/chernabog/issues/121)) ([c909932](https://github.com/dataquail/chernabog/commit/c909932e0fa210cafe90871d0469a37eff6efc8a))
* remove the SDK's whole workflows and review-loop triggers; the recipes write them out ([#67](https://github.com/dataquail/chernabog/issues/67)) ([#69](https://github.com/dataquail/chernabog/issues/69)) ([0c0207a](https://github.com/dataquail/chernabog/commit/0c0207a9530e8745106e528516e8690e9b9a736a))
* review through GitHub review requests, with a reviewer pool, review and re-review ([#53](https://github.com/dataquail/chernabog/issues/53)) ([#64](https://github.com/dataquail/chernabog/issues/64)) ([4599fb4](https://github.com/dataquail/chernabog/commit/4599fb415b05ac44caeb995156564bd93fb0ed62))
* route work to machines by assignee or requested reviewer ([#19](https://github.com/dataquail/chernabog/issues/19)) ([4aa9cbe](https://github.com/dataquail/chernabog/commit/4aa9cbe0652a1907e03c79f5004db184802c3595)), closes [#18](https://github.com/dataquail/chernabog/issues/18)
* run a review without relabelling, and hand off without needs-review ([#37](https://github.com/dataquail/chernabog/issues/37)) ([1f4495e](https://github.com/dataquail/chernabog/commit/1f4495e5e9cb8f46d143ecb74c773b4cbe63634c))
* start an issue with a person on the hybrid path, with a human-initiated flow a repo writes itself ([#66](https://github.com/dataquail/chernabog/issues/66)) ([0122fd8](https://github.com/dataquail/chernabog/commit/0122fd8ca4d514c804cb7cbdf36c9a3af840b9e4))
* steps to re-check a review and to consider its findings ([#40](https://github.com/dataquail/chernabog/issues/40)) ([5f45794](https://github.com/dataquail/chernabog/commit/5f457946c87029d53aa4f328513ab22ff1c99894))
* typed SDK errors; flows handle the work's errors, and setup errors stop a persona before its flows run ([#75](https://github.com/dataquail/chernabog/issues/75)) ([#78](https://github.com/dataquail/chernabog/issues/78)) ([d6cc447](https://github.com/dataquail/chernabog/commit/d6cc4472f1ce24624db8091ba21991964ac6c126))


### Bug Fixes

* keep Orca sessions alive while they run, and hand failed runs to a person ([#28](https://github.com/dataquail/chernabog/issues/28)) ([bb1902d](https://github.com/dataquail/chernabog/commit/bb1902de03f467e4362e00639c47a801212eb010))

## [0.7.0](https://github.com/dataquail/chernabog/compare/sdk-v0.6.0...sdk-v0.7.0) (2026-10-28)


### ⚠ BREAKING CHANGES

* after upgrading, an enrolled repo's implement and human-initiated flows (and any flow of its own that calls Implement.claim or Hybrid.claim) take a claim ref that only Claims.releasing lets go when the run ends. Update them with `chernabog recipes diff` / `recipes add`, or wrap the run in `Claims.releasing(Claims.issue(issue))`, then `chernabog trust` the repo. Until then, `chernabog cancel <run>` on the run a skip names deletes the claim ref it left.

### Features

* a person's Yes, not the agent, opens the pull request on the hybrid path ([#128](https://github.com/dataquail/chernabog/issues/128)) ([5f6e7c9](https://github.com/dataquail/chernabog/commit/5f6e7c9fd8477f8e16ff2cf821ee156f1841700e))
* a plan recipe: an agent turns a spec issue into an epic of ordered sub-issues ([#140](https://github.com/dataquail/chernabog/issues/140)) ([28e264f](https://github.com/dataquail/chernabog/commit/28e264f2858673f57c5eac7a0b35a3a7c7f9a76d))
* claims are refs of their own, apart from the work branch ([#139](https://github.com/dataquail/chernabog/issues/139)) ([3fe9282](https://github.com/dataquail/chernabog/commit/3fe928220e25992096408a697641b8bff4bde5cf))
* **recipes:** recipes as packages: @chernabog/recipes on its own cadence, company recipe packages, and flows that import a recipe ([#130](https://github.com/dataquail/chernabog/issues/130)) ([1d076c5](https://github.com/dataquail/chernabog/commit/1d076c5087bc48f18d91604878369354a1e21711))
* rehearse a flow end to end on a scratch repo, with stand-ins for the agent ([#121](https://github.com/dataquail/chernabog/issues/121)) ([c909932](https://github.com/dataquail/chernabog/commit/c909932e0fa210cafe90871d0469a37eff6efc8a))

## [0.6.0](https://github.com/dataquail/chernabog/compare/sdk-v0.5.0...sdk-v0.6.0) (2026-10-23)


### ⚠ BREAKING CHANGES

* flows that let errors through no longer compile, and GitHub.merge fails with MergeRefused instead of returning MergeOutcome. Repos move their baked flows with `chernabog recipes diff`.

### Features

* a flow with no trigger is manual, and runs only when a person names its work ([#74](https://github.com/dataquail/chernabog/issues/74)) ([#111](https://github.com/dataquail/chernabog/issues/111)) ([2e1c539](https://github.com/dataquail/chernabog/commit/2e1c5394eafe9473819a21c4174b9a13fa56ef96))
* let a person's session push changes to humanOnlyPaths on the hybrid path ([#72](https://github.com/dataquail/chernabog/issues/72)) ([#73](https://github.com/dataquail/chernabog/issues/73)) ([9b0d0a3](https://github.com/dataquail/chernabog/commit/9b0d0a391f3811b815278f622534d45a84724068))
* typed SDK errors; flows handle the work's errors, and setup errors stop a persona before its flows run ([#75](https://github.com/dataquail/chernabog/issues/75)) ([#78](https://github.com/dataquail/chernabog/issues/78)) ([d6cc447](https://github.com/dataquail/chernabog/commit/d6cc4472f1ce24624db8091ba21991964ac6c126))

## [0.5.0](https://github.com/dataquail/chernabog/compare/sdk-v0.4.0...sdk-v0.5.0) (2026-10-22)


### ⚠ BREAKING CHANGES

* remove the SDK's whole workflows and review-loop triggers; the recipes write them out ([#67](https://github.com/dataquail/chernabog/issues/67)) (#69)
* opt-in flow recipes, baked into the repo as code, chosen at init and later ([#67](https://github.com/dataquail/chernabog/issues/67)) (#68)
* the fix flow is gone, with Review.fixTrigger, Review.fixWorkflow, Review.FixItem and the fix prompt; address-review replaces them.
* the ship flow and the label-driven review loop are gone, with Review.labelVerdict, Review.reviewRound and Review.cleanUp; Review.trigger and Review.workflow now work from review requests. limits.reviewRounds defaults to 1.

### Features

* act as several GitHub personas from one daemon ([#56](https://github.com/dataquail/chernabog/issues/56)) ([e83ddfe](https://github.com/dataquail/chernabog/commit/e83ddfed61b7ca33a58b5e73eb0a51a5d1ae68c2))
* answer a review that requests changes in the author's session, with address-review ([#54](https://github.com/dataquail/chernabog/issues/54)) ([#65](https://github.com/dataquail/chernabog/issues/65)) ([770505c](https://github.com/dataquail/chernabog/commit/770505c1f22cfda81d20148162a4e10b198e5494))
* keep each persona's flow choices in machine config, keyed by repo slug ([#50](https://github.com/dataquail/chernabog/issues/50)) ([#60](https://github.com/dataquail/chernabog/issues/60)) ([9f2c65e](https://github.com/dataquail/chernabog/commit/9f2c65ea27cbbbc42adeecb59db43173b8bf1114))
* opt-in flow recipes, baked into the repo as code, chosen at init and later ([#67](https://github.com/dataquail/chernabog/issues/67)) ([#68](https://github.com/dataquail/chernabog/issues/68)) ([a1d6db3](https://github.com/dataquail/chernabog/commit/a1d6db3602d5cbfdf24527ce60ca26a963f27bcf))
* remove the SDK's whole workflows and review-loop triggers; the recipes write them out ([#67](https://github.com/dataquail/chernabog/issues/67)) ([#69](https://github.com/dataquail/chernabog/issues/69)) ([0c0207a](https://github.com/dataquail/chernabog/commit/0c0207a9530e8745106e528516e8690e9b9a736a))
* review through GitHub review requests, with a reviewer pool, review and re-review ([#53](https://github.com/dataquail/chernabog/issues/53)) ([#64](https://github.com/dataquail/chernabog/issues/64)) ([4599fb4](https://github.com/dataquail/chernabog/commit/4599fb415b05ac44caeb995156564bd93fb0ed62))
* start an issue with a person on the hybrid path, with a human-initiated flow a repo writes itself ([#66](https://github.com/dataquail/chernabog/issues/66)) ([0122fd8](https://github.com/dataquail/chernabog/commit/0122fd8ca4d514c804cb7cbdf36c9a3af840b9e4))

## [0.4.0](https://github.com/dataquail/chernabog/compare/sdk-v0.3.1...sdk-v0.4.0) (2026-10-20)


### Features

* give a flow's steps their own agents by role ([#38](https://github.com/dataquail/chernabog/issues/38)) ([3c1293e](https://github.com/dataquail/chernabog/commit/3c1293e94adbc5be78a365d2092deccbf955f11f))
* key a flow by its own label, and let a run own its pull request ([#39](https://github.com/dataquail/chernabog/issues/39)) ([80ea827](https://github.com/dataquail/chernabog/commit/80ea8274c41efc8ff90e6bb539368031c64be9c1))
* PullRequest.merge, which merges only when that is safe ([#41](https://github.com/dataquail/chernabog/issues/41)) ([55559d1](https://github.com/dataquail/chernabog/commit/55559d1ea8685ced3a8644eb2f09b6da5c6a3af2))
* run a review without relabelling, and hand off without needs-review ([#37](https://github.com/dataquail/chernabog/issues/37)) ([1f4495e](https://github.com/dataquail/chernabog/commit/1f4495e5e9cb8f46d143ecb74c773b4cbe63634c))
* steps to re-check a review and to consider its findings ([#40](https://github.com/dataquail/chernabog/issues/40)) ([5f45794](https://github.com/dataquail/chernabog/commit/5f457946c87029d53aa4f328513ab22ff1c99894))

## [0.3.1](https://github.com/dataquail/chernabog/compare/sdk-v0.3.0...sdk-v0.3.1) (2026-10-20)


### Bug Fixes

* keep Orca sessions alive while they run, and hand failed runs to a person ([#28](https://github.com/dataquail/chernabog/issues/28)) ([bb1902d](https://github.com/dataquail/chernabog/commit/bb1902de03f467e4362e00639c47a801212eb010))

## [0.3.0](https://github.com/dataquail/chernabog/compare/sdk-v0.2.0...sdk-v0.3.0) (2026-10-20)


### Features

* log a Claude account in with a token from an environment variable ([#21](https://github.com/dataquail/chernabog/issues/21)) ([b566281](https://github.com/dataquail/chernabog/commit/b56628102c9a8dee19aac3e67b3ffde68c9c9234))

## [0.2.0](https://github.com/dataquail/chernabog/compare/sdk-v0.1.0...sdk-v0.2.0) (2026-10-20)


### Features

* route work to machines by assignee or requested reviewer ([#19](https://github.com/dataquail/chernabog/issues/19)) ([4aa9cbe](https://github.com/dataquail/chernabog/commit/4aa9cbe0652a1907e03c79f5004db184802c3595)), closes [#18](https://github.com/dataquail/chernabog/issues/18)
