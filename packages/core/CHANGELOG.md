# Changelog

## 1.0.0 (2026-10-30)


### ⚠ BREAKING CHANGES

* @chernabog/core is the binary's contract with every repo's flows, and each repo runs the @chernabog/sdk it pins ([#167](https://github.com/dataquail/chernabog/issues/167))

### Features

* @chernabog/core is the binary's contract with every repo's flows, and each repo runs the @chernabog/sdk it pins ([#167](https://github.com/dataquail/chernabog/issues/167)) ([4c9db37](https://github.com/dataquail/chernabog/commit/4c9db376061ce357cd9ceddfd367aa94210bfa07))
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
* **recipes:** the epic run carries a lower layer's change up its stack ([#197](https://github.com/dataquail/chernabog/issues/197)) ([d528b27](https://github.com/dataquail/chernabog/commit/d528b278b6bcc026851cf18f9eb9fd7a95590e8d))
* routing is the flow's decision, not the engine's ([#215](https://github.com/dataquail/chernabog/issues/215)) ([805af1a](https://github.com/dataquail/chernabog/commit/805af1afb5cccbd2aacfad998771aa3d032bf7cc)), closes [#204](https://github.com/dataquail/chernabog/issues/204)
* the config branch is GitHub's default, and a flow's work targets its own base ([#216](https://github.com/dataquail/chernabog/issues/216)) ([4a4ffd5](https://github.com/dataquail/chernabog/commit/4a4ffd5c0bb81aa58c232c339f07827d006258be))
