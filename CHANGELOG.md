# Changelog

## [0.11.1](https://github.com/dataquail/chernabog/compare/v0.11.0...v0.11.1) (2026-10-30)


### Bug Fixes

* a GitHub 5xx is tried again for about 30 seconds, on the API and on a push, rather than ending the run or going to a person ([#260](https://github.com/dataquail/chernabog/issues/260)) ([6509a7e](https://github.com/dataquail/chernabog/commit/6509a7e4e36e7e3672363345856bb993b6eba815)), closes [#254](https://github.com/dataquail/chernabog/issues/254)
* **recipes:** a repo that checks its titles gets conventional commits, and CI fixes edit a failing title ([#247](https://github.com/dataquail/chernabog/issues/247)) ([6e7c51a](https://github.com/dataquail/chernabog/commit/6e7c51a9daf3aad93ea7dc3a66c8ddcf868ed7de))
* **recipes:** an epic task whose layer below merges mid-task opens on the branch that layer merged into ([#265](https://github.com/dataquail/chernabog/issues/265)) ([114033d](https://github.com/dataquail/chernabog/commit/114033db536953a9c8a399bc13e0ef31c2aa684b))
* three tests no longer race the runner, and cleanup survives a claim branch deleted under it ([#223](https://github.com/dataquail/chernabog/issues/223)) ([130da9b](https://github.com/dataquail/chernabog/commit/130da9b8f5b7002291c65101b3c10273158bdcbc))

## [0.11.0](https://github.com/dataquail/chernabog/compare/v0.10.0...v0.11.0) (2026-10-30)


### ⚠ BREAKING CHANGES

* @chernabog/core is the binary's contract with every repo's flows, and each repo runs the @chernabog/sdk it pins ([#167](https://github.com/dataquail/chernabog/issues/167))

### Features

* @chernabog/core is the binary's contract with every repo's flows, and each repo runs the @chernabog/sdk it pins ([#167](https://github.com/dataquail/chernabog/issues/167)) ([4c9db37](https://github.com/dataquail/chernabog/commit/4c9db376061ce357cd9ceddfd367aa94210bfa07))
* a notification about an issue or pull request checks its runs' stillValid within seconds ([#165](https://github.com/dataquail/chernabog/issues/165)) ([3b3e5ce](https://github.com/dataquail/chernabog/commit/3b3e5cea64f7d1cb4a9b1ce9882b6a94d4f15f3b))
* a run names the subjects it touched, instead of the engine recording its pull request ([#210](https://github.com/dataquail/chernabog/issues/210)) ([799e427](https://github.com/dataquail/chernabog/commit/799e427c7aac4edec0e6b833b1ebdbc30bad232a))
* a trigger can report an item as held, with a reason, and status shows it ([#183](https://github.com/dataquail/chernabog/issues/183)) ([ac588bf](https://github.com/dataquail/chernabog/commit/ac588bf6790ce91e96f937249ca207b8c1dfd5b8))
* CI is read as checks and statuses, the SDK decides the verdict, and cancel leaves labels to markers ([#217](https://github.com/dataquail/chernabog/issues/217)) ([caf8574](https://github.com/dataquail/chernabog/commit/caf85743f1fac8432f205baddfb26fe308a7e02c))
* CI state for a commit or a branch, and ciState counts every check when branch rules are refused ([#190](https://github.com/dataquail/chernabog/issues/190)) ([d288d93](https://github.com/dataquail/chernabog/commit/d288d93cd234e76e4f0d40ede3a3c9746dd2b50a))
* claims are leases: the daemon renews its runs' claims, an expired one can be taken over, and a run that lost its claim ends as lost ([#169](https://github.com/dataquail/chernabog/issues/169)) ([7d90433](https://github.com/dataquail/chernabog/commit/7d90433ba3db386135d7dbdefcb299ad030fa2bc))
* Epic.tasks works out which of an epic's tasks are ready, the base each stacks on, and why the rest wait ([#187](https://github.com/dataquail/chernabog/issues/187)) ([36ff85f](https://github.com/dataquail/chernabog/commit/36ff85f187b1f566c534c8009808d4dc2a53a864))
* fencing and change reporting cover every write a capability declares, without the engine naming methods ([#211](https://github.com/dataquail/chernabog/issues/211)) ([8632c19](https://github.com/dataquail/chernabog/commit/8632c19c178ab023c554ddeac6c47fb549bdc459)), closes [#205](https://github.com/dataquail/chernabog/issues/205)
* flows declare their own settings, and core's settings are only the engine's ([#214](https://github.com/dataquail/chernabog/issues/214)) ([0037fdd](https://github.com/dataquail/chernabog/commit/0037fddf168d4144a716e301979637d13b1537e7))
* implement adopts an open pull request that already closes its issue, instead of implementing it again ([#191](https://github.com/dataquail/chernabog/issues/191)) ([425803c](https://github.com/dataquail/chernabog/commit/425803c5d190cef04eddc0bba7f5df8af680846a))
* Implement and Hybrid blocks take a base branch per item, not only repo.baseBranch ([#168](https://github.com/dataquail/chernabog/issues/168)) ([1f716ea](https://github.com/dataquail/chernabog/commit/1f716eabe15863f27173ca083a54fed355080c1e))
* markers: a run registers what it put on an item, and the daemon takes it off however the run ends ([#164](https://github.com/dataquail/chernabog/issues/164)) ([fdca485](https://github.com/dataquail/chernabog/commit/fdca4854162d396cec044d9589fc6352c0207600))
* **recipes:** an epic recipe that implements an epic's tasks as stacked pull requests ([#193](https://github.com/dataquail/chernabog/issues/193)) ([0fe6ebd](https://github.com/dataquail/chernabog/commit/0fe6ebd023a2ef5e0fa87b9a4209222ece449ca7))
* **recipes:** an epic with ship set lands its layers, bottom to top, once each is approved ([#220](https://github.com/dataquail/chernabog/issues/220)) ([e614164](https://github.com/dataquail/chernabog/commit/e614164a5bbbac95175d439e97dabdb0f1b93a9e))
* **recipes:** an epic's tasks implemented at once is its atOnce setting ([#221](https://github.com/dataquail/chernabog/issues/221)) ([9a8f1f2](https://github.com/dataquail/chernabog/commit/9a8f1f21a9da0ca2a68005674e8bb75556c42ba0))
* **recipes:** the epic run carries a lower layer's change up its stack ([#197](https://github.com/dataquail/chernabog/issues/197)) ([d528b27](https://github.com/dataquail/chernabog/commit/d528b278b6bcc026851cf18f9eb9fd7a95590e8d))
* routing is the flow's decision, not the engine's ([#215](https://github.com/dataquail/chernabog/issues/215)) ([805af1a](https://github.com/dataquail/chernabog/commit/805af1afb5cccbd2aacfad998771aa3d032bf7cc)), closes [#204](https://github.com/dataquail/chernabog/issues/204)
* runs whose issue or pull request goes away end as superseded (flows' stillValid, checked by the daemon) ([#160](https://github.com/dataquail/chernabog/issues/160)) ([c0bbcfb](https://github.com/dataquail/chernabog/commit/c0bbcfbcd76c5f7c1a85c15bc95b0a8e755fd858))
* **sdk:** an approval survives a head that only merged in its base ([#184](https://github.com/dataquail/chernabog/issues/184)) ([8a6c44f](https://github.com/dataquail/chernabog/commit/8a6c44f66cb9c082499c5325396117004fe3721e))
* **sdk:** implement holds a blocked issue, and leaves an epic run's tasks to it ([#188](https://github.com/dataquail/chernabog/issues/188)) ([4f66c12](https://github.com/dataquail/chernabog/commit/4f66c121764859caa0b31a893f09d05bdd0379b2)), closes [#177](https://github.com/dataquail/chernabog/issues/177)
* **sdk:** Stack.refreshLayer brings a layer whose base moved up to date and adjusts it, outside the review rounds ([#189](https://github.com/dataquail/chernabog/issues/189)) ([205ab4c](https://github.com/dataquail/chernabog/commit/205ab4c2f4314585baf3ae81e751385b3e400d2f))
* **sdk:** Stack.syncBase merges a layer's moved base in, including a squash-merged layer below ([#186](https://github.com/dataquail/chernabog/issues/186)) ([1487c3f](https://github.com/dataquail/chernabog/commit/1487c3f69a5fae456f84f1bd5f0b72df2ab3d5bb))
* the config branch is GitHub's default, and a flow's work targets its own base ([#216](https://github.com/dataquail/chernabog/issues/216)) ([4a4ffd5](https://github.com/dataquail/chernabog/commit/4a4ffd5c0bb81aa58c232c339f07827d006258be))


### Bug Fixes

* a worktree left by an earlier run is reset to the claimed branch, so implement's push no longer fails with stale info ([#159](https://github.com/dataquail/chernabog/issues/159)) ([9552a27](https://github.com/dataquail/chernabog/commit/9552a27ae3562b6f82f56adc447e8b8e6279f24a))
* **recipes:** an approved layer of a stack waits for the layer below, rather than going to a person ([#219](https://github.com/dataquail/chernabog/issues/219)) ([4f450ab](https://github.com/dataquail/chernabog/commit/4f450ab73f79751a630e7c30ecd0594c0726519b))
* review, address-review and merge treat a pull request stacked on another branch as a layer ([#185](https://github.com/dataquail/chernabog/issues/185)) ([9b834b8](https://github.com/dataquail/chernabog/commit/9b834b8e06b5c52a76de925183a106fbea643c82))
* runs preparing worktrees at once no longer collide on the checkout's git locks ([#212](https://github.com/dataquail/chernabog/issues/212)) ([#213](https://github.com/dataquail/chernabog/issues/213)) ([d4ee04b](https://github.com/dataquail/chernabog/commit/d4ee04b7403c77d27e935436101f0bc6e0d41ed4))
* **sdk:** addressing a review stops for a person when the author leaves edits uncommitted ([#194](https://github.com/dataquail/chernabog/issues/194)) ([657528d](https://github.com/dataquail/chernabog/commit/657528dfc6288a348a27585cab9f11f964e6d2a6)), closes [#192](https://github.com/dataquail/chernabog/issues/192)

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
