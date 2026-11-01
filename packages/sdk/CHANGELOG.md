# Changelog

## [0.9.0](https://github.com/dataquail/chernabog/compare/sdk-v0.8.1...sdk-v0.9.0) (2026-11-01)


### Features

* hold an approved merge while CI on the base branch is red, rather than handing the pull request to a person ([#292](https://github.com/dataquail/chernabog/issues/292)) ([0ec429b](https://github.com/dataquail/chernabog/commit/0ec429b4ababedae53b6ee0ba4a0546a0e0cfe8a))


### Bug Fixes

* **recipes:** a re-review requests changes only for a blocking finding, and fixes keep the pull request's description current ([#337](https://github.com/dataquail/chernabog/issues/337)) ([c545d57](https://github.com/dataquail/chernabog/commit/c545d571df549c91806f00882e66086f2c5b8e36))
* the pre-commit hook runs the fast checks, not the tests, so an agent's commit lands before it answers ([#199](https://github.com/dataquail/chernabog/issues/199)) ([e4b56a8](https://github.com/dataquail/chernabog/commit/e4b56a89d13f29e4e9765a632a4ecd52979c8d3f)), closes [#198](https://github.com/dataquail/chernabog/issues/198)

## [0.8.1](https://github.com/dataquail/chernabog/compare/sdk-v0.8.0...sdk-v0.8.1) (2026-10-30)


### Bug Fixes

* **recipes:** a repo that checks its titles gets conventional commits, and CI fixes edit a failing title ([#247](https://github.com/dataquail/chernabog/issues/247)) ([6e7c51a](https://github.com/dataquail/chernabog/commit/6e7c51a9daf3aad93ea7dc3a66c8ddcf868ed7de))
* **recipes:** an epic task whose layer below merges mid-task opens on the branch that layer merged into ([#265](https://github.com/dataquail/chernabog/issues/265)) ([114033d](https://github.com/dataquail/chernabog/commit/114033db536953a9c8a399bc13e0ef31c2aa684b))

## [0.8.0](https://github.com/dataquail/chernabog/compare/sdk-v0.7.0...sdk-v0.8.0) (2026-10-30)


### ⚠ BREAKING CHANGES

* @chernabog/core is the binary's contract with every repo's flows, and each repo runs the @chernabog/sdk it pins ([#167](https://github.com/dataquail/chernabog/issues/167))

### Features

* @chernabog/core is the binary's contract with every repo's flows, and each repo runs the @chernabog/sdk it pins ([#167](https://github.com/dataquail/chernabog/issues/167)) ([4c9db37](https://github.com/dataquail/chernabog/commit/4c9db376061ce357cd9ceddfd367aa94210bfa07))
* a run names the subjects it touched, instead of the engine recording its pull request ([#210](https://github.com/dataquail/chernabog/issues/210)) ([799e427](https://github.com/dataquail/chernabog/commit/799e427c7aac4edec0e6b833b1ebdbc30bad232a))
* a trigger can report an item as held, with a reason, and status shows it ([#183](https://github.com/dataquail/chernabog/issues/183)) ([ac588bf](https://github.com/dataquail/chernabog/commit/ac588bf6790ce91e96f937249ca207b8c1dfd5b8))
* CI is read as checks and statuses, the SDK decides the verdict, and cancel leaves labels to markers ([#217](https://github.com/dataquail/chernabog/issues/217)) ([caf8574](https://github.com/dataquail/chernabog/commit/caf85743f1fac8432f205baddfb26fe308a7e02c))
* claims are leases: the daemon renews its runs' claims, an expired one can be taken over, and a run that lost its claim ends as lost ([#169](https://github.com/dataquail/chernabog/issues/169)) ([7d90433](https://github.com/dataquail/chernabog/commit/7d90433ba3db386135d7dbdefcb299ad030fa2bc))
* Epic.tasks works out which of an epic's tasks are ready, the base each stacks on, and why the rest wait ([#187](https://github.com/dataquail/chernabog/issues/187)) ([36ff85f](https://github.com/dataquail/chernabog/commit/36ff85f187b1f566c534c8009808d4dc2a53a864))
* flows declare their own settings, and core's settings are only the engine's ([#214](https://github.com/dataquail/chernabog/issues/214)) ([0037fdd](https://github.com/dataquail/chernabog/commit/0037fddf168d4144a716e301979637d13b1537e7))
* implement adopts an open pull request that already closes its issue, instead of implementing it again ([#191](https://github.com/dataquail/chernabog/issues/191)) ([425803c](https://github.com/dataquail/chernabog/commit/425803c5d190cef04eddc0bba7f5df8af680846a))
* Implement and Hybrid blocks take a base branch per item, not only repo.baseBranch ([#168](https://github.com/dataquail/chernabog/issues/168)) ([1f716ea](https://github.com/dataquail/chernabog/commit/1f716eabe15863f27173ca083a54fed355080c1e))
* markers: a run registers what it put on an item, and the daemon takes it off however the run ends ([#164](https://github.com/dataquail/chernabog/issues/164)) ([fdca485](https://github.com/dataquail/chernabog/commit/fdca4854162d396cec044d9589fc6352c0207600))
* **recipes:** an epic recipe that implements an epic's tasks as stacked pull requests ([#193](https://github.com/dataquail/chernabog/issues/193)) ([0fe6ebd](https://github.com/dataquail/chernabog/commit/0fe6ebd023a2ef5e0fa87b9a4209222ece449ca7))
* **recipes:** an epic with ship set lands its layers, bottom to top, once each is approved ([#220](https://github.com/dataquail/chernabog/issues/220)) ([e614164](https://github.com/dataquail/chernabog/commit/e614164a5bbbac95175d439e97dabdb0f1b93a9e))
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
* **sdk:** addressing a review stops for a person when the author leaves edits uncommitted ([#194](https://github.com/dataquail/chernabog/issues/194)) ([657528d](https://github.com/dataquail/chernabog/commit/657528dfc6288a348a27585cab9f11f964e6d2a6)), closes [#192](https://github.com/dataquail/chernabog/issues/192)

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
