# Changelog

## [0.1.5](https://github.com/home-operations/talosctl-cluster-action/compare/v0.1.4...v0.1.5) (2026-07-29)


### Features

* **deps:** update dependency oxlint (1.74.0 → 1.75.0) ([#20](https://github.com/home-operations/talosctl-cluster-action/issues/20)) ([5713a09](https://github.com/home-operations/talosctl-cluster-action/commit/5713a09919f2b5d718600b3e3bbd33f2989f4cc5))
* **npm:** update dependency oxlint (1.75.0 → 1.76.0) ([#30](https://github.com/home-operations/talosctl-cluster-action/issues/30)) ([cbeff07](https://github.com/home-operations/talosctl-cluster-action/commit/cbeff070d89db5545c37144643d37718ea3e08c6))
* **profile:** drop NTP and discovery from the ephemeral profile ([#33](https://github.com/home-operations/talosctl-cluster-action/issues/33)) ([4094272](https://github.com/home-operations/talosctl-cluster-action/commit/40942722dfb2cec4f84154216f04f6995532829d))


### Bug Fixes

* **npm:** update dependency rollup (4.62.2 → 4.62.3) ([#26](https://github.com/home-operations/talosctl-cluster-action/issues/26)) ([163659b](https://github.com/home-operations/talosctl-cluster-action/commit/163659beb459559d68995778e49ceb68bb6b2ae7))


### Documentation

* clarify the runner swapfile is host swap, not cluster swap ([#21](https://github.com/home-operations/talosctl-cluster-action/issues/21)) ([96d6216](https://github.com/home-operations/talosctl-cluster-action/commit/96d621627f991879699aeef6d8dd47fd55441aa6))


### Build System

* **mise:** add actionlint and refresh the lockfile ([#24](https://github.com/home-operations/talosctl-cluster-action/issues/24)) ([f3dbd32](https://github.com/home-operations/talosctl-cluster-action/commit/f3dbd32e2f00f69d0dd0f6329e78256128ed0bcf))


### Continuous Integration

* gate pull requests on a single Build Success check ([#23](https://github.com/home-operations/talosctl-cluster-action/issues/23)) ([2e65a09](https://github.com/home-operations/talosctl-cluster-action/commit/2e65a093c6c17112b5d73894986db7b234944dc2))
* **github-action:** Update action jdx/mise-action (v4.2.1 → v4.2.2) ([#28](https://github.com/home-operations/talosctl-cluster-action/issues/28)) ([864985c](https://github.com/home-operations/talosctl-cluster-action/commit/864985c08b760443147b1102b5d24b346b411495))
* **github-action:** Update action jdx/mise-action (v4.2.2 → v4.2.3) ([#31](https://github.com/home-operations/talosctl-cluster-action/issues/31)) ([97ec647](https://github.com/home-operations/talosctl-cluster-action/commit/97ec6476485f48d1914f925271606bd41d02c3da))
* lint workflows with the shared composite action ([#25](https://github.com/home-operations/talosctl-cluster-action/issues/25)) ([b3eff9f](https://github.com/home-operations/talosctl-cluster-action/commit/b3eff9fa89c9b706e4e22e7d2912cf540d7fecd1))
* skip release-please PRs in checks and drop nightly e2e ([#22](https://github.com/home-operations/talosctl-cluster-action/issues/22)) ([67a92fc](https://github.com/home-operations/talosctl-cluster-action/commit/67a92fca89f25fba934a5c6c0d9ae6bade034b5c))


### Miscellaneous Chores

* **github-release:** Update Talos Group ([#17](https://github.com/home-operations/talosctl-cluster-action/issues/17)) ([8914d43](https://github.com/home-operations/talosctl-cluster-action/commit/8914d43b248297b9d797319dd16ecfca9bda22dd))
* **mise:** Update tool oxfmt (0.59.0 → 0.60.0) ([#19](https://github.com/home-operations/talosctl-cluster-action/issues/19)) ([a542e02](https://github.com/home-operations/talosctl-cluster-action/commit/a542e023da1fb5386cae441ffd34be605624bb4f))
* **mise:** Update tool oxfmt (0.60.0 → 0.61.0) ([#29](https://github.com/home-operations/talosctl-cluster-action/issues/29)) ([1e7d92a](https://github.com/home-operations/talosctl-cluster-action/commit/1e7d92ab4a61699e06fb7a5cead3200d6d8c7217))
* **mise:** Update tool zizmor (1.27.0 → 1.28.0) ([#18](https://github.com/home-operations/talosctl-cluster-action/issues/18)) ([57ddf1e](https://github.com/home-operations/talosctl-cluster-action/commit/57ddf1e10e5520300d20f3bceb7e596837344a17))
* **renovate:** group Talos updates ([#15](https://github.com/home-operations/talosctl-cluster-action/issues/15)) ([467fba0](https://github.com/home-operations/talosctl-cluster-action/commit/467fba06fcd52bd0b4ea2848d3d8cc693b391142))
* standardize release-please changelog sections ([#32](https://github.com/home-operations/talosctl-cluster-action/issues/32)) ([da00858](https://github.com/home-operations/talosctl-cluster-action/commit/da00858bbdae24f2a4afd8930bfcdab5c62a47a1))

## [0.1.4](https://github.com/home-operations/talosctl-cluster-action/compare/v0.1.3...v0.1.4) (2026-07-21)


### Features

* support leaving nodes in maintenance mode ([#11](https://github.com/home-operations/talosctl-cluster-action/issues/11)) ([f3009f0](https://github.com/home-operations/talosctl-cluster-action/commit/f3009f08437a9d743baa0ba5bfee080b3ae12a31))

## [0.1.3](https://github.com/home-operations/talosctl-cluster-action/compare/v0.1.2...v0.1.3) (2026-07-20)


### Features

* **deps:** update node.js (v24.0.0 → v24.18.0) ([#5](https://github.com/home-operations/talosctl-cluster-action/issues/5)) ([221da8b](https://github.com/home-operations/talosctl-cluster-action/commit/221da8be8ea80423675c74bafc9d797af5d49495))
* **profile:** parallel image pulls and init_on_alloc=0 ([#7](https://github.com/home-operations/talosctl-cluster-action/issues/7)) ([29b21ff](https://github.com/home-operations/talosctl-cluster-action/commit/29b21ff1f5f26f07546f75071d2ae9e6c4913366))

## [0.1.2](https://github.com/home-operations/talosctl-cluster-action/compare/v0.1.1...v0.1.2) (2026-07-20)


### Bug Fixes

* load br_netfilter so the docker provider's CNI comes up ([#2](https://github.com/home-operations/talosctl-cluster-action/issues/2)) ([f81f365](https://github.com/home-operations/talosctl-cluster-action/commit/f81f3655e46a22e0ec09cd8e9394331708aff7c6))

## [0.1.1](https://github.com/home-operations/talosctl-cluster-action/compare/v0.1.0...v0.1.1) (2026-07-20)


### Features

* talosctl cluster action for qemu and docker ([d36609a](https://github.com/home-operations/talosctl-cluster-action/commit/d36609abae6d5dad519d1dce6f1cc2c537b9175e))


### Styles

* indent markdown at 2 to match embedded yaml ([02cf5cc](https://github.com/home-operations/talosctl-cluster-action/commit/02cf5cce190b6b96bd55f0323a3a2e4ee50f7fd5))


### Code Refactoring

* dedupe command probing and add a JS linter ([630c5cc](https://github.com/home-operations/talosctl-cluster-action/commit/630c5cc41e235c3f5cebd483f9a6bd56037efe43))
