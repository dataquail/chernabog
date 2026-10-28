# Changelog

## [0.10.0](https://github.com/dataquail/chernabog/compare/v0.9.0...v0.10.0) (2026-10-28)


### ⚠ BREAKING CHANGES

* after upgrading, an enrolled repo's implement and human-initiated flows (and any flow of its own that calls Implement.claim or Hybrid.claim) take a claim ref that only Claims.releasing lets go when the run ends. Update them with `chernabog recipes diff` / `recipes add`, or wrap the run in `Claims.releasing(Claims.issue(issue))`, then `chernabog trust` the repo. Until then, `chernabog cancel <run>` on the run a skip names deletes the claim ref it left.
* engines.chernabog in .chernabog/package.json is refused, as is a manifest without an @chernabog/sdk pin; run chernabog recipes upgrade. An older chernabog refuses machine config and state.db once this one has stamped them; restore the copy in ~/.config/chernabog/backups/ to roll back.

### Features

* a person's Yes, not the agent, opens the pull request on the hybrid path ([#128](https://github.com/dataquail/chernabog/issues/128)) ([5f6e7c9](https://github.com/dataquail/chernabog/commit/5f6e7c9fd8477f8e16ff2cf821ee156f1841700e))
* a plan recipe: an agent turns a spec issue into an epic of ordered sub-issues ([#140](https://github.com/dataquail/chernabog/issues/140)) ([28e264f](https://github.com/dataquail/chernabog/commit/28e264f2858673f57c5eac7a0b35a3a7c7f9a76d))
* a resolve-conflicts recipe, and review/re-review leave a conflicting approval to it ([#118](https://github.com/dataquail/chernabog/issues/118)) ([4a1cd50](https://github.com/dataquail/chernabog/commit/4a1cd50da7cc3156069c9544e67f6747a0fba785))
* a run's changes here and a persona's GitHub notifications tick flows right away, not on the next cron tick ([#141](https://github.com/dataquail/chernabog/issues/141)) ([ad9ef65](https://github.com/dataquail/chernabog/commit/ad9ef65eae0352021a27e1f54b3e14340ee61c01))
* cancel a run in flight with chernabog cancel ([#119](https://github.com/dataquail/chernabog/issues/119)) ([926ead3](https://github.com/dataquail/chernabog/commit/926ead37a46aa2ed173c93dc884691e7ff80a82f))
* chernabog decides which repos' flows it runs, and state and runs survive an upgrade ([#124](https://github.com/dataquail/chernabog/issues/124)) ([ad7132d](https://github.com/dataquail/chernabog/commit/ad7132d6de135420f9c6690b0aa70cb0b6935727))
* claims are refs of their own, apart from the work branch ([#139](https://github.com/dataquail/chernabog/issues/139)) ([3fe9282](https://github.com/dataquail/chernabog/commit/3fe928220e25992096408a697641b8bff4bde5cf))
* **recipes:** recipes as packages: @chernabog/recipes on its own cadence, company recipe packages, and flows that import a recipe ([#130](https://github.com/dataquail/chernabog/issues/130)) ([1d076c5](https://github.com/dataquail/chernabog/commit/1d076c5087bc48f18d91604878369354a1e21711))
* rehearse a flow end to end on a scratch repo, with stand-ins for the agent ([#121](https://github.com/dataquail/chernabog/issues/121)) ([c909932](https://github.com/dataquail/chernabog/commit/c909932e0fa210cafe90871d0469a37eff6efc8a))
* **tui:** tabs by project and persona, runs you can scan by issue and PR, a run's step history and work threads ([#127](https://github.com/dataquail/chernabog/issues/127)) ([2a5c035](https://github.com/dataquail/chernabog/commit/2a5c035b82a3f67a8444384aae77383382fe5cef))


### Bug Fixes

* the release PR's SDK bump moves the SDK range this binary runs, and its tests pass before npm has it ([#131](https://github.com/dataquail/chernabog/issues/131)) ([7daa1b8](https://github.com/dataquail/chernabog/commit/7daa1b8b05607da21d75425e6d74c1420d7b7818))

## [0.9.0](https://github.com/dataquail/chernabog/compare/v0.8.0...v0.9.0) (2026-10-23)


### ⚠ BREAKING CHANGES

* flows that let errors through no longer compile, and GitHub.merge fails with MergeRefused instead of returning MergeOutcome. Repos move their baked flows with `chernabog recipes diff`.

### Features

* a flow with no trigger is manual, and runs only when a person names its work ([#74](https://github.com/dataquail/chernabog/issues/74)) ([#111](https://github.com/dataquail/chernabog/issues/111)) ([2e1c539](https://github.com/dataquail/chernabog/commit/2e1c5394eafe9473819a21c4174b9a13fa56ef96))
* enroll as a plan and an apply, and every machine-config write through the enrolled repo ([#93](https://github.com/dataquail/chernabog/issues/93)) ([925e97d](https://github.com/dataquail/chernabog/commit/925e97d1135e742d129d8193aae8ca692a3dd6e6))
* let a person's session push changes to humanOnlyPaths on the hybrid path ([#72](https://github.com/dataquail/chernabog/issues/72)) ([#73](https://github.com/dataquail/chernabog/issues/73)) ([9b0d0a3](https://github.com/dataquail/chernabog/commit/9b0d0a391f3811b815278f622534d45a84724068))
* pause and resume as use-cases over an enrolled-repos repository, keyed by slug ([#84](https://github.com/dataquail/chernabog/issues/84)) ([e629c96](https://github.com/dataquail/chernabog/commit/e629c96cf81eae52c46648267ad82dca6f8649ac))
* recipes and init's scaffold as a module, `recipes add` asking between a list and an add ([#94](https://github.com/dataquail/chernabog/issues/94)) ([c647baf](https://github.com/dataquail/chernabog/commit/c647baf7b097e6e534100837cc830d3dac6c5456))
* setup as a plan and an apply over the machine module, the CLI asking between ([#92](https://github.com/dataquail/chernabog/issues/92)) ([9bf3f08](https://github.com/dataquail/chernabog/commit/9bf3f08dc423bf924b3bd12eece6092d58d9f5a5))
* show review requests no machine here serves, in doctor, enroll and status ([#76](https://github.com/dataquail/chernabog/issues/76)) ([#79](https://github.com/dataquail/chernabog/issues/79)) ([bb136fc](https://github.com/dataquail/chernabog/commit/bb136fc3c6afe99c8d7ad9710ff9d484211a7564))
* status and logs as adapters over use-cases, each with --json ([#90](https://github.com/dataquail/chernabog/issues/90)) ([bb22fd9](https://github.com/dataquail/chernabog/commit/bb22fd9621e4844f81612e144d9855289136e200))
* stopping takes at most 3 seconds, and a second Ctrl-C exits at once ([#106](https://github.com/dataquail/chernabog/issues/106)) ([2b7fbbd](https://github.com/dataquail/chernabog/commit/2b7fbbd8b14f2c4a32c26d64636d873bc1033e14))
* trust as its own module, with the trust command over its use-case ([#85](https://github.com/dataquail/chernabog/issues/85)) ([2270d3b](https://github.com/dataquail/chernabog/commit/2270d3ba80df2e8a145db882949630404497db9d))
* typed SDK errors; flows handle the work's errors, and setup errors stop a persona before its flows run ([#75](https://github.com/dataquail/chernabog/issues/75)) ([#78](https://github.com/dataquail/chernabog/issues/78)) ([d6cc447](https://github.com/dataquail/chernabog/commit/d6cc4472f1ce24624db8091ba21991964ac6c126))


### Bug Fixes

* a start a crash interrupts is finished at the next startup ([#105](https://github.com/dataquail/chernabog/issues/105)) ([ce18884](https://github.com/dataquail/chernabog/commit/ce1888418e727f463608f09f2883f8a5ded0dd64))
* changes to machine config, paused.json and trust.json take turns ([#109](https://github.com/dataquail/chernabog/issues/109)) ([fa77dd4](https://github.com/dataquail/chernabog/commit/fa77dd4d4344badd8bf53109e202c869afa9c763))
* replace state files whole, so an interrupted write can't empty them ([#108](https://github.com/dataquail/chernabog/issues/108)) ([cb4693e](https://github.com/dataquail/chernabog/commit/cb4693eedbdef93505e31dc6fe06e314d501ca4c))
* restart the daemon once per trusted tree, not every five minutes while a repo fails to load ([#77](https://github.com/dataquail/chernabog/issues/77)) ([#81](https://github.com/dataquail/chernabog/issues/81)) ([a30b72e](https://github.com/dataquail/chernabog/commit/a30b72ec2b4445b53aa9d1ada2d0a9f48d3ef6cd))
* the engine's lock can't be deleted by a process starting alongside it ([#110](https://github.com/dataquail/chernabog/issues/110)) ([47cb0a8](https://github.com/dataquail/chernabog/commit/47cb0a8f09e760d1057516ca8f5a59975b2313bb))

## [0.8.0](https://github.com/dataquail/chernabog/compare/v0.7.0...v0.8.0) (2026-10-22)


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
* set up personas at install, and choose flows per persona at enrollment ([#51](https://github.com/dataquail/chernabog/issues/51)) ([#61](https://github.com/dataquail/chernabog/issues/61)) ([9a31b2f](https://github.com/dataquail/chernabog/commit/9a31b2f1378274bf159d6c8b3237e8ec6659cc97))
* show how a repo's flows differ from the current recipes, with chernabog recipes diff ([#67](https://github.com/dataquail/chernabog/issues/67)) ([#70](https://github.com/dataquail/chernabog/issues/70)) ([33ed21b](https://github.com/dataquail/chernabog/commit/33ed21b86cdca23485618b6915991c8b1ce3abec))
* start an issue with a person on the hybrid path, with a human-initiated flow a repo writes itself ([#66](https://github.com/dataquail/chernabog/issues/66)) ([0122fd8](https://github.com/dataquail/chernabog/commit/0122fd8ca4d514c804cb7cbdf36c9a3af840b9e4))
* **tui:** override a persona's flows, schedules and accounts in the live view ([#52](https://github.com/dataquail/chernabog/issues/52)) ([#63](https://github.com/dataquail/chernabog/issues/63)) ([b0b6357](https://github.com/dataquail/chernabog/commit/b0b6357484d1348173c616658e46d548a4dfd7f4))


### Bug Fixes

* **engine:** list an ambiguous run id's matches in sorted order ([#59](https://github.com/dataquail/chernabog/issues/59)) ([e39a190](https://github.com/dataquail/chernabog/commit/e39a1909b6070efe8708c25c624364b89ad2bde5))

## [0.7.0](https://github.com/dataquail/chernabog/compare/v0.6.1...v0.7.0) (2026-10-20)


### Features

* give a flow's steps their own agents by role ([#38](https://github.com/dataquail/chernabog/issues/38)) ([3c1293e](https://github.com/dataquail/chernabog/commit/3c1293e94adbc5be78a365d2092deccbf955f11f))
* key a flow by its own label, and let a run own its pull request ([#39](https://github.com/dataquail/chernabog/issues/39)) ([80ea827](https://github.com/dataquail/chernabog/commit/80ea8274c41efc8ff90e6bb539368031c64be9c1))
* PullRequest.merge, which merges only when that is safe ([#41](https://github.com/dataquail/chernabog/issues/41)) ([55559d1](https://github.com/dataquail/chernabog/commit/55559d1ea8685ced3a8644eb2f09b6da5c6a3af2))
* run a review without relabelling, and hand off without needs-review ([#37](https://github.com/dataquail/chernabog/issues/37)) ([1f4495e](https://github.com/dataquail/chernabog/commit/1f4495e5e9cb8f46d143ecb74c773b4cbe63634c))
* steps to re-check a review and to consider its findings ([#40](https://github.com/dataquail/chernabog/issues/40)) ([5f45794](https://github.com/dataquail/chernabog/commit/5f457946c87029d53aa4f328513ab22ff1c99894))


### Bug Fixes

* pick up a repo enrolled while the daemon runs, without a manual restart ([#31](https://github.com/dataquail/chernabog/issues/31)) ([bcf17dd](https://github.com/dataquail/chernabog/commit/bcf17dd3b34de4a07eca53204d8830037879c268))

## [0.6.1](https://github.com/dataquail/chernabog/compare/v0.6.0...v0.6.1) (2026-10-20)


### Bug Fixes

* keep Orca sessions alive while they run, and hand failed runs to a person ([#28](https://github.com/dataquail/chernabog/issues/28)) ([bb1902d](https://github.com/dataquail/chernabog/commit/bb1902de03f467e4362e00639c47a801212eb010))

## [0.6.0](https://github.com/dataquail/chernabog/compare/v0.5.0...v0.6.0) (2026-10-20)


### Features

* log a Claude account in with a token from an environment variable ([#21](https://github.com/dataquail/chernabog/issues/21)) ([b566281](https://github.com/dataquail/chernabog/commit/b56628102c9a8dee19aac3e67b3ffde68c9c9234))


### Bug Fixes

* read the Claude login on Linux, and accept a usage window not yet running ([#20](https://github.com/dataquail/chernabog/issues/20)) ([0520bd2](https://github.com/dataquail/chernabog/commit/0520bd2b9deb41c43ecb1b1c9242e52370b3675b))

## [0.5.0](https://github.com/dataquail/chernabog/compare/v0.4.0...v0.5.0) (2026-10-20)


### Features

* choose which flows run on this machine when enrolling ([#10](https://github.com/dataquail/chernabog/issues/10)) ([4fe7d7b](https://github.com/dataquail/chernabog/commit/4fe7d7b9e6d542cd79b7de7eacd325164200038f))
* name the GitHub users whose machines run a repo's flows ([#15](https://github.com/dataquail/chernabog/issues/15)) ([33503b5](https://github.com/dataquail/chernabog/commit/33503b595e79cbe109aef6564ee22e005279ce9d))
* route work to machines by assignee or requested reviewer ([#19](https://github.com/dataquail/chernabog/issues/19)) ([4aa9cbe](https://github.com/dataquail/chernabog/commit/4aa9cbe0652a1907e03c79f5004db184802c3595)), closes [#18](https://github.com/dataquail/chernabog/issues/18)
* show runners in enroll's flow picker and in doctor ([#16](https://github.com/dataquail/chernabog/issues/16)) ([c5d8cb7](https://github.com/dataquail/chernabog/commit/c5d8cb7c4b7c58b4f8e8411820a9889e5c9259e7))
* turn a flow off or on from the live view ([#12](https://github.com/dataquail/chernabog/issues/12)) ([075e5d7](https://github.com/dataquail/chernabog/commit/075e5d7c468df9d435ac5724e46cd2221755ab57))


### Bug Fixes

* let local.yaml's schedule beat every schedule the team sets ([#9](https://github.com/dataquail/chernabog/issues/9)) ([ee79a51](https://github.com/dataquail/chernabog/commit/ee79a51111c62ce4defd3f57d3e3a04ec65da79f))
* restart the daemon on an edit to local.yaml ([#11](https://github.com/dataquail/chernabog/issues/11)) ([63bc682](https://github.com/dataquail/chernabog/commit/63bc682de63e39dce2b57b8aa6f497615c0d0cc4))

## [0.4.0](https://github.com/dataquail/chernabog/compare/v0.3.0...v0.4.0) (2026-10-19)


### Features

* install with Homebrew ([#5](https://github.com/dataquail/chernabog/issues/5)) ([fc4e34d](https://github.com/dataquail/chernabog/commit/fc4e34d394056ff14e92e92e302c9278842803d4))
