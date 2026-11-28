# Changelog

## [2.0.0](https://github.com/dataquail/chernabog/compare/core-v1.4.0...core-v2.0.0) (2026-11-28)


### ⚠ BREAKING CHANGES

* **core:** PhaseTransition.from is a PhaseRead ({phase, version}), not a Phase; `progress anomalies --acknowledge` takes the records to acknowledge, `<item>@<version>`, repeated.
* **core:** Backfill.survey and Ledger.survey are effects, not functions of logins; a repo lists its personas under `personas:`.
* **sdk:** a flow parks with Phases.park, not awaitSignal; Plan.awaitAnswer takes the spec; Plan.propose no longer records proposed; epic.park requires epic and progress; a binary refuses an SDK from before this release.

### Features

* **ci:** a plan job reserves the items it starts, so two plans for one step start one run job ([#520](https://github.com/dataquail/chernabog/issues/520)) ([32d0e79](https://github.com/dataquail/chernabog/commit/32d0e79a75f5c58f9866e7edc495cc440826f4ec))
* **config:** a repo names its GitHub Apps, which flows act as and a pool names as app:reviewer ([#531](https://github.com/dataquail/chernabog/issues/531)) ([35b5275](https://github.com/dataquail/chernabog/commit/35b5275f6ac7a8f095235f4a614c8d1076eb52bc))
* **core:** a phase record says when it was written and carries data for the next run ([#529](https://github.com/dataquail/chernabog/issues/529)) ([0631dda](https://github.com/dataquail/chernabog/commit/0631ddaaa7527874433f079cbccd94fe93684889))
* **core:** one persona set, from the repo's committed config ([#551](https://github.com/dataquail/chernabog/issues/551)) ([428d916](https://github.com/dataquail/chernabog/commit/428d91654598db220c4997f35858f82ca73511ea))
* **core:** Progress.advance compares and sets on the version the writer read ([#554](https://github.com/dataquail/chernabog/issues/554)) ([9924472](https://github.com/dataquail/chernabog/commit/9924472c2e04a3db791f8682e0601e3ba9ebdfbc))
* **core:** the ledger stores blobs written in the same commit as the record that names them ([#597](https://github.com/dataquail/chernabog/issues/597)) ([695950c](https://github.com/dataquail/chernabog/commit/695950cc50beac3dcbfda4a347e1e8dfd1d2a6d6))
* **runs:** the daemon runs no flow itself, and the foreground run, rehearse and ci run fold their own journal ([#696](https://github.com/dataquail/chernabog/issues/696)) ([8f35a08](https://github.com/dataquail/chernabog/commit/8f35a08546ca0ac495dd1f191cef66c72e0b7670))
* **sandbox:** a per-repo sandbox setting, none, docker or podman, carried in the launch spec ([#733](https://github.com/dataquail/chernabog/issues/733)) ([aff22d9](https://github.com/dataquail/chernabog/commit/aff22d9ea7c6f4d83b06dbae3e0f11a661614b1d))
* **sdk:** a park is always a record ([#550](https://github.com/dataquail/chernabog/issues/550)) ([5411cca](https://github.com/dataquail/chernabog/commit/5411cca5b4b0940b8bb315f416509a1a525476ac))
* **sdk:** a pull request that changes a feature file is handed to a person ([#596](https://github.com/dataquail/chernabog/issues/596)) ([821dbd1](https://github.com/dataquail/chernabog/commit/821dbd12767745d2326209c09575f8993e9f47c4))
* **sdk:** one projector writes the status labels from the ledger; no flow writes one directly ([#632](https://github.com/dataquail/chernabog/issues/632)) ([c05d742](https://github.com/dataquail/chernabog/commit/c05d742acbd231de3d4e54e2e0f6adb6b9b12af9))


### Bug Fixes

* **claims:** keep a reader from moving a claim back over a takeover ([#706](https://github.com/dataquail/chernabog/issues/706)) ([d733c4e](https://github.com/dataquail/chernabog/commit/d733c4e92392a2eaf0911f48f392c50c91d44f8c)), closes [#703](https://github.com/dataquail/chernabog/issues/703)
* **claims:** read a renewal that races the run's own release as released, not lost ([#739](https://github.com/dataquail/chernabog/issues/739)) ([6be5304](https://github.com/dataquail/chernabog/commit/6be530426a83e1a194d40c0243bb0119ec95514f)), closes [#732](https://github.com/dataquail/chernabog/issues/732)
* **core:** a lane's wake no longer restarts the steps running on its other lanes ([#673](https://github.com/dataquail/chernabog/issues/673)) ([b83367a](https://github.com/dataquail/chernabog/commit/b83367ac16cc63d65482ebfbf79e607876ef5386)), closes [#615](https://github.com/dataquail/chernabog/issues/615)
* **core:** start a step at once, so a sleeping sibling lane can't suspend the run first ([#708](https://github.com/dataquail/chernabog/issues/708)) ([c2fd4a4](https://github.com/dataquail/chernabog/commit/c2fd4a40503efb895fe00e6fae4334862711749d)), closes [#675](https://github.com/dataquail/chernabog/issues/675)
* one phase thread that isn't a record holds only its own item ([#572](https://github.com/dataquail/chernabog/issues/572)) ([11b07c8](https://github.com/dataquail/chernabog/commit/11b07c8ae3d223772e250a20c5075d523cd7b8c9))
* **sdk:** a plan parked in a CI job is taken up again once a person answers it, or nobody does in time ([#532](https://github.com/dataquail/chernabog/issues/532)) ([5184586](https://github.com/dataquail/chernabog/commit/51845865e3b6fcc064b4380be501a5d6bc6e0c5c))
* **sdk:** the author's session and a claim's facts come from the record, not comment markers ([#628](https://github.com/dataquail/chernabog/issues/628)) ([27fea09](https://github.com/dataquail/chernabog/commit/27fea0910d596c85af62bb1b73a59dd25145d618))
* **sdk:** the posted plan lives in the ledger; its comment is only for people ([#608](https://github.com/dataquail/chernabog/issues/608)) ([0784228](https://github.com/dataquail/chernabog/commit/078422842ef2fd6a264ebc1558495b858fb98769))

## [1.4.0](https://github.com/dataquail/chernabog/compare/core-v1.3.0...core-v1.4.0) (2026-11-16)


### Features

* **sdk:** a CI job's wait for CI parks on a record instead of polling ([#514](https://github.com/dataquail/chernabog/issues/514)) ([c9b1003](https://github.com/dataquail/chernabog/commit/c9b10037ec4402f4650858bfbd9d773a867965f4))

## [1.3.0](https://github.com/dataquail/chernabog/compare/core-v1.2.0...core-v1.3.0) (2026-11-10)


### Features

* **core:** a Progress port for an item's phase, with a fake and the contract every adapter passes ([#450](https://github.com/dataquail/chernabog/issues/450)) ([6dfbe96](https://github.com/dataquail/chernabog/commit/6dfbe9625b62a41853646918b3962eee19b1ac65))
* **runs:** record an item's phase on protected branches, with doctor's ruleset check ([#453](https://github.com/dataquail/chernabog/issues/453)) ([ff56487](https://github.com/dataquail/chernabog/commit/ff564870e6ffef5ba0bb4b0ca2ef8795388d707b))

## [1.2.0](https://github.com/dataquail/chernabog/compare/core-v1.1.0...core-v1.2.0) (2026-11-08)


### Features

* **runs:** record where in its plan each step of a run ran, its branches and its ends ([#432](https://github.com/dataquail/chernabog/issues/432)) ([15a60fa](https://github.com/dataquail/chernabog/commit/15a60fa642c1a23bf6826734265545466375a263))


### Bug Fixes

* **rehearsals:** clean up the issues and claim refs a rehearsal's run made ([#414](https://github.com/dataquail/chernabog/issues/414)) ([747276a](https://github.com/dataquail/chernabog/commit/747276a1c7e1838625865b8c2ee6cf52eccb4334))

## [1.1.0](https://github.com/dataquail/chernabog/compare/core-v1.0.0...core-v1.1.0) (2026-11-04)


### Features

* **markers:** a marker can declare how to renew it, and the daemon renews every held marker that does ([#356](https://github.com/dataquail/chernabog/issues/356)) ([06d8996](https://github.com/dataquail/chernabog/commit/06d8996adde311d5435ce7193a9f457c65437352))
* **runs:** steps' ends and outcomes, a flow's lanes, and run log lines tagged with their step ([#351](https://github.com/dataquail/chernabog/issues/351)) ([871584c](https://github.com/dataquail/chernabog/commit/871584c555c2674a5c7b5afe2c82795516a032ef))

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
