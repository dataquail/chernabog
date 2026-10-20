# Changelog

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
