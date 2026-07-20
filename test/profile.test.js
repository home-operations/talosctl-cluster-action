import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  profileKernelArgs,
  profilePatches,
  describeProfile,
  DEFAULT_PROFILE,
} from "../src/profile.js";
import { concatPatches, resolvePatch, substitutions } from "../src/patches.js";
import { withKernelArgs } from "../src/schematic.js";
import { parseCluster } from "../src/config.js";
import { withV } from "../src/args.js";

// Through parseCluster so the fixture cannot drift into a shape the schema rejects.
const cluster = parseCluster(
  "apiVersion: v1alpha1\nkind: TalosCluster\nmetadata:\n  name: dev\nspec:\n  qemu:\n    talos-version: v1.13.6\n",
);

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
    ]);
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

  it("pins the install image only when a schematic is in play", () => {
    const without = JSON.stringify(profilePatches("ephemeral", { hasSchematic: false }).cluster);
    const with_ = JSON.stringify(profilePatches("ephemeral", { hasSchematic: true }).cluster);
    assert.doesNotMatch(without, /install/);
    assert.match(with_, /factory\.talos\.dev\/installer/);
  });

  const pinnedImage = (vars) => {
    const [, installImage] = profilePatches("ephemeral", { hasSchematic: true }).cluster;
    return JSON.parse(resolvePatch(installImage.patch, { vars })).machine.install.image;
  };

  it("resolves the pinned image against the registered schematic", () => {
    const vars = substitutions({ schematicId: "abc123", cluster, talosVersion: "v1.13.6" });
    assert.equal(pinnedImage(vars), "factory.talos.dev/installer/abc123:v1.13.6");
  });

  // The flag is v-normalised, and the pinned image has to be too: the Image Factory
  // publishes no unprefixed tag, so an unprefixed pin fails at first upgrade.
  it("pins a v-prefixed tag even when the spec omits the v", () => {
    const vars = substitutions({
      schematicId: "abc123",
      cluster,
      talosVersion: withV("1.13.6"),
    });
    assert.equal(pinnedImage(vars), "factory.talos.dev/installer/abc123:v1.13.6");
  });

  it("falls back to talosctl's own version when the spec omits one", () => {
    const bare = { ...cluster, spec: {} };
    const vars = substitutions({ schematicId: "abc", cluster: bare, talosVersion: "v1.13.6" });
    assert.equal(pinnedImage(vars), "factory.talos.dev/installer/abc:v1.13.6");
  });

  it("names everything it applied, so nothing is silent", () => {
    const lines = describeProfile("ephemeral", { hasSchematic: true });
    assert.match(lines.join("\n"), /kernel args/);
    assert.match(lines.join("\n"), /kubelet/);
    assert.match(lines.join("\n"), /etcd/);
    assert.equal(lines.length, 5);
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
