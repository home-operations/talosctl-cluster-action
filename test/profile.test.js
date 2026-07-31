import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  profileKernelArgs,
  profilePatches,
  describeProfile,
  DEFAULT_PROFILE,
} from "../src/profile.js";
import { concatPatches } from "../src/patches.js";
import { withKernelArgs } from "../src/schematic.js";

describe("profile", () => {
  it("defaults to ephemeral", () => {
    assert.equal(DEFAULT_PROFILE, "ephemeral");
  });

  it("applies nothing at all when set to none", () => {
    assert.deepEqual(profileKernelArgs("none"), []);
    assert.deepEqual(profilePatches("none"), { cluster: [], controlplanes: [], workers: [] });
    assert.deepEqual(describeProfile("none"), []);
  });

  it("turns off the things nothing in CI reads", () => {
    assert.deepEqual(profileKernelArgs("ephemeral"), [
      "talos.dashboard.disabled=1",
      "talos.auditd.disabled=1",
      "mitigations=off",
      "-init_on_alloc",
      "init_on_alloc=0",
    ]);
  });

  // Talos enforces these two by exact value in pkg/kernel/kspp and refuses to finish the
  // systemRequirements phase without them, so negating either bricks the node at boot.
  // Verified the hard way: a node booted without them logs "KSPP kernel parameter ... is
  // required" and the create times out waiting for an API that never comes up.
  it("never negates a KSPP-enforced kernel parameter", () => {
    const args = profileKernelArgs("ephemeral");
    assert.ok(!args.includes("-pti"));
    assert.ok(!args.includes("-slab_nomerge"));
  });

  it("turns on bounded parallel image pulls", () => {
    const cluster = JSON.stringify(profilePatches("ephemeral").cluster);
    assert.match(cluster, /"serializeImagePulls":false/);
    assert.match(cluster, /"maxParallelImagePulls":3/);
  });

  // Both are valid in a worker's cluster/machine section as well as a control plane's,
  // so they ride the all-node patch rather than being split per role.
  it("turns off time sync and cluster discovery on every node", () => {
    const cluster = JSON.stringify(profilePatches("ephemeral").cluster);
    assert.match(cluster, /"time":\{"disabled":true\}/);
    assert.match(cluster, /"discovery":\{"enabled":false\}/);
  });

  it("puts etcd and audit settings on control planes only", () => {
    // Talos rejects an etcd section on a worker, so these cannot ride the all-node
    // patch.
    const patches = profilePatches("ephemeral");
    const cp = JSON.stringify(patches.controlplanes);
    assert.match(cp, /unsafe-no-fsync/);
    assert.match(cp, /auditPolicy/);
    assert.doesNotMatch(JSON.stringify(patches.cluster), /unsafe-no-fsync/);
    assert.deepEqual(patches.workers, []);
  });

  // The install image pin is not a profile patch: the action passes
  // --install-image itself, the way `cluster create qemu` pins it internally.
  it("never patches the install image", () => {
    assert.doesNotMatch(JSON.stringify(profilePatches("ephemeral")), /install/);
  });

  it("names everything it applied, so nothing is silent", () => {
    const lines = describeProfile("ephemeral");
    assert.match(lines.join("\n"), /kernel args/);
    assert.match(lines.join("\n"), /kubelet/);
    assert.match(lines.join("\n"), /parallel image pulls/);
    assert.match(lines.join("\n"), /etcd/);
    assert.match(lines.join("\n"), /time sync/);
    assert.match(lines.join("\n"), /discovery/);
    assert.equal(lines.length, 7);
  });
});

// The whole override story: profile patches go first, so talosctl's ordered deep
// merge lets the caller's win per key. Verified against real talosctl behaviour.
describe("profile is overridable", () => {
  it("puts caller patches after profile patches in every role", () => {
    const merged = concatPatches(
      { cluster: ["PROFILE"], controlplanes: ["PROFILE"], workers: [] },
      { cluster: ["USER"], controlplanes: ["USER"], workers: ["USER"] },
    );
    assert.deepEqual(merged.cluster, ["PROFILE", "USER"]);
    assert.deepEqual(merged.controlplanes, ["PROFILE", "USER"]);
    assert.deepEqual(merged.workers, ["USER"]);
  });

  it("keeps every role key even when both sides are empty", () => {
    assert.deepEqual(concatPatches({}, {}), { cluster: [], controlplanes: [], workers: [] });
  });
});

// Kernel args live in the schematic, not in a patch, so they cannot be overridden by
// a later --config-patch. Merging by key gives the same override story.
describe("kernel arg merge", () => {
  it("adds the profile args to a schematic that has none", () => {
    const merged = withKernelArgs({ customization: {} }, ["mitigations=off"]);
    assert.deepEqual(merged.customization.extraKernelArgs, ["mitigations=off"]);
  });

  it("lets the schematic win on a key the profile also sets", () => {
    const merged = withKernelArgs({ customization: { extraKernelArgs: ["mitigations=auto"] } }, [
      "mitigations=off",
      "talos.auditd.disabled=1",
    ]);
    assert.deepEqual(merged.customization.extraKernelArgs, [
      "talos.auditd.disabled=1",
      "mitigations=auto",
    ]);
  });

  it("preserves the rest of the schematic", () => {
    const merged = withKernelArgs(
      { customization: { systemExtensions: { officialExtensions: ["siderolabs/drbd"] } } },
      ["mitigations=off"],
    );
    assert.deepEqual(merged.customization.systemExtensions.officialExtensions, ["siderolabs/drbd"]);
    assert.deepEqual(merged.customization.extraKernelArgs, ["mitigations=off"]);
  });

  it("synthesises a schematic when the spec has none but the profile has args", () => {
    const merged = withKernelArgs(undefined, ["mitigations=off"]);
    assert.deepEqual(merged.customization.extraKernelArgs, ["mitigations=off"]);
  });

  it("leaves an absent schematic absent when there is nothing to add", () => {
    assert.equal(withKernelArgs(undefined, []), undefined);
  });
});
