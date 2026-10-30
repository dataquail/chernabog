# Changelog

## [0.2.1](https://github.com/dataquail/chernabog/compare/recipes-v0.2.0...recipes-v0.2.1) (2026-10-30)


### Bug Fixes

* **recipes:** a repo that checks its titles gets conventional commits, and CI fixes edit a failing title ([#247](https://github.com/dataquail/chernabog/issues/247)) ([6e7c51a](https://github.com/dataquail/chernabog/commit/6e7c51a9daf3aad93ea7dc3a66c8ddcf868ed7de))
* **recipes:** an epic task whose layer below merges mid-task opens on the branch that layer merged into ([#265](https://github.com/dataquail/chernabog/issues/265)) ([114033d](https://github.com/dataquail/chernabog/commit/114033db536953a9c8a399bc13e0ef31c2aa684b))

## [0.2.0](https://github.com/dataquail/chernabog/compare/recipes-v0.1.0...recipes-v0.2.0) (2026-10-30)


### ⚠ BREAKING CHANGES

* @chernabog/core is the binary's contract with every repo's flows, and each repo runs the @chernabog/sdk it pins ([#167](https://github.com/dataquail/chernabog/issues/167))

### Features

* @chernabog/core is the binary's contract with every repo's flows, and each repo runs the @chernabog/sdk it pins ([#167](https://github.com/dataquail/chernabog/issues/167)) ([4c9db37](https://github.com/dataquail/chernabog/commit/4c9db376061ce357cd9ceddfd367aa94210bfa07))
* flows declare their own settings, and core's settings are only the engine's ([#214](https://github.com/dataquail/chernabog/issues/214)) ([0037fdd](https://github.com/dataquail/chernabog/commit/0037fddf168d4144a716e301979637d13b1537e7))
* implement adopts an open pull request that already closes its issue, instead of implementing it again ([#191](https://github.com/dataquail/chernabog/issues/191)) ([425803c](https://github.com/dataquail/chernabog/commit/425803c5d190cef04eddc0bba7f5df8af680846a))
* Implement and Hybrid blocks take a base branch per item, not only repo.baseBranch ([#168](https://github.com/dataquail/chernabog/issues/168)) ([1f716ea](https://github.com/dataquail/chernabog/commit/1f716eabe15863f27173ca083a54fed355080c1e))
* **recipes:** an epic recipe that implements an epic's tasks as stacked pull requests ([#193](https://github.com/dataquail/chernabog/issues/193)) ([0fe6ebd](https://github.com/dataquail/chernabog/commit/0fe6ebd023a2ef5e0fa87b9a4209222ece449ca7))
* **recipes:** an epic with ship set lands its layers, bottom to top, once each is approved ([#220](https://github.com/dataquail/chernabog/issues/220)) ([e614164](https://github.com/dataquail/chernabog/commit/e614164a5bbbac95175d439e97dabdb0f1b93a9e))
* **recipes:** an epic's tasks implemented at once is its atOnce setting ([#221](https://github.com/dataquail/chernabog/issues/221)) ([9a8f1f2](https://github.com/dataquail/chernabog/commit/9a8f1f21a9da0ca2a68005674e8bb75556c42ba0))
* **recipes:** the epic run carries a lower layer's change up its stack ([#197](https://github.com/dataquail/chernabog/issues/197)) ([d528b27](https://github.com/dataquail/chernabog/commit/d528b278b6bcc026851cf18f9eb9fd7a95590e8d))
* routing is the flow's decision, not the engine's ([#215](https://github.com/dataquail/chernabog/issues/215)) ([805af1a](https://github.com/dataquail/chernabog/commit/805af1afb5cccbd2aacfad998771aa3d032bf7cc)), closes [#204](https://github.com/dataquail/chernabog/issues/204)
* runs whose issue or pull request goes away end as superseded (flows' stillValid, checked by the daemon) ([#160](https://github.com/dataquail/chernabog/issues/160)) ([c0bbcfb](https://github.com/dataquail/chernabog/commit/c0bbcfbcd76c5f7c1a85c15bc95b0a8e755fd858))
* **sdk:** implement holds a blocked issue, and leaves an epic run's tasks to it ([#188](https://github.com/dataquail/chernabog/issues/188)) ([4f66c12](https://github.com/dataquail/chernabog/commit/4f66c121764859caa0b31a893f09d05bdd0379b2)), closes [#177](https://github.com/dataquail/chernabog/issues/177)
* the config branch is GitHub's default, and a flow's work targets its own base ([#216](https://github.com/dataquail/chernabog/issues/216)) ([4a4ffd5](https://github.com/dataquail/chernabog/commit/4a4ffd5c0bb81aa58c232c339f07827d006258be))


### Bug Fixes

* **recipes:** an approved layer of a stack waits for the layer below, rather than going to a person ([#219](https://github.com/dataquail/chernabog/issues/219)) ([4f450ab](https://github.com/dataquail/chernabog/commit/4f450ab73f79751a630e7c30ecd0594c0726519b))
* review, address-review and merge treat a pull request stacked on another branch as a layer ([#185](https://github.com/dataquail/chernabog/issues/185)) ([9b834b8](https://github.com/dataquail/chernabog/commit/9b834b8e06b5c52a76de925183a106fbea643c82))

## 0.1.0 (2026-10-28)


### Features

* **recipes:** recipes as packages: @chernabog/recipes on its own cadence, company recipe packages, and flows that import a recipe ([#130](https://github.com/dataquail/chernabog/issues/130)) ([1d076c5](https://github.com/dataquail/chernabog/commit/1d076c5087bc48f18d91604878369354a1e21711))
