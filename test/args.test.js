import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildArgs, hasMaintenancePreset, nodeAddresses } from "../src/args.js";

const cluster = (spec) => ({
  apiVersion: "v1alpha1",
  kind: "TalosCluster",
  metadata: { name: "dev" },
  ...(spec === undefined ? {} : { spec }),
});

/** Value that follows `flag`, or undefined. */
const valueOf = (args, flag) => args[args.indexOf(flag) + 1];
const valuesOf = (args, flag) => args.flatMap((arg, i) => (arg === flag ? [args[i + 1]] : []));

describe("buildArgs", () => {
  it("always targets the qemu subcommand with a name", () => {
    assert.deepEqual(buildArgs(cluster()), ["cluster", "create", "qemu", "--name", "dev"]);
  });

  it("tolerates a document with no spec", () => {
    assert.doesNotThrow(() => buildArgs(cluster()));
  });

  it("omits flags the spec does not set, leaving talosctl defaults alone", () => {
    const args = buildArgs(cluster({}));
    for (const flag of ["--controlplanes", "--workers", "--cidr", "--disks", "--presets"]) {
      assert.ok(!args.includes(flag), `expected ${flag} to be absent`);
    }
  });

  // talosctl is asymmetric here and gets this wrong silently if you are not.
  it("normalises the v prefix per flag", () => {
    const args = buildArgs(
      cluster({ qemu: { "talos-version": "1.13.6" }, "kubernetes-version": "v1.34.0" }),
    );
    assert.equal(valueOf(args, "--talos-version"), "v1.13.6");
    assert.equal(valueOf(args, "--kubernetes-version"), "1.34.0");
  });

  it("leaves already-normalised versions alone", () => {
    const args = buildArgs(
      cluster({ qemu: { "talos-version": "v1.13.6" }, "kubernetes-version": "1.34.0" }),
    );
    assert.equal(valueOf(args, "--talos-version"), "v1.13.6");
    assert.equal(valueOf(args, "--kubernetes-version"), "1.34.0");
  });

  it("maps per-role cpu and memory to their own flags", () => {
    const args = buildArgs(
      cluster({
        controlplanes: { count: 3, cpus: 2, memory: "2GiB" },
        workers: { count: 2, cpus: "4", memory: "5GiB" },
      }),
    );
    assert.equal(valueOf(args, "--controlplanes"), "3");
    assert.equal(valueOf(args, "--cpus-controlplanes"), "2");
    assert.equal(valueOf(args, "--memory-controlplanes"), "2GiB");
    assert.equal(valueOf(args, "--workers"), "2");
    assert.equal(valueOf(args, "--cpus-workers"), "4");
    assert.equal(valueOf(args, "--memory-workers"), "5GiB");
  });

  it("emits zero worker counts, which are meaningful", () => {
    const args = buildArgs(cluster({ workers: { count: 0 } }));
    assert.equal(valueOf(args, "--workers"), "0");
  });

  // The Disks pflag.Value replaces on every Set, so repeated flags would drop all
  // but the last disk.
  it("joins disks into a single flag", () => {
    const args = buildArgs(cluster({ qemu: { disks: ["virtio:8GiB", "virtio:20GiB"] } }));
    assert.deepEqual(valuesOf(args, "--disks"), ["virtio:8GiB,virtio:20GiB"]);
  });

  it("repeats config-patch flags per role", () => {
    const args = buildArgs(cluster({}), {
      patches: { cluster: ['{"a":1}', '{"b":2}'], controlplanes: ['{"c":3}'], workers: [] },
    });
    assert.deepEqual(valuesOf(args, "--config-patch"), ['{"a":1}', '{"b":2}']);
    assert.deepEqual(valuesOf(args, "--config-patch-controlplanes"), ['{"c":3}']);
    assert.ok(!args.includes("--config-patch-workers"));
  });

  it("passes the resolved schematic id and talosconfig destination", () => {
    const args = buildArgs(cluster({}), {
      schematicId: "abc123",
      talosconfig: "/tmp/dev/talosconfig",
    });
    assert.equal(valueOf(args, "--schematic-id"), "abc123");
    assert.equal(valueOf(args, "--talosconfig-destination"), "/tmp/dev/talosconfig");
  });
});

describe("hasMaintenancePreset", () => {
  it("detects the maintenance preset among the boot presets", () => {
    assert.equal(
      hasMaintenancePreset(cluster({ qemu: { presets: ["iso", "maintenance"] } })),
      true,
    );
  });

  it("is false without it", () => {
    assert.equal(hasMaintenancePreset(cluster()), false);
    assert.equal(hasMaintenancePreset(cluster({})), false);
    assert.equal(hasMaintenancePreset(cluster({ qemu: {} })), false);
    assert.equal(hasMaintenancePreset(cluster({ qemu: { presets: ["iso"] } })), false);
  });
});

describe("nodeAddresses", () => {
  it("numbers nodes upward from the second address, control planes first", () => {
    const addresses = nodeAddresses(
      cluster({
        network: { cidr: "10.5.0.0/24" },
        controlplanes: { count: 3 },
        workers: { count: 2 },
      }),
    );
    assert.equal(addresses.gateway, "10.5.0.1");
    assert.deepEqual(addresses.controlplanes, ["10.5.0.2", "10.5.0.3", "10.5.0.4"]);
    assert.deepEqual(addresses.workers, ["10.5.0.5", "10.5.0.6"]);
  });

  it("matches the talosctl default CIDR when the spec omits one", () => {
    const addresses = nodeAddresses(
      cluster({ controlplanes: { count: 1 }, workers: { count: 0 } }),
    );
    assert.equal(addresses.gateway, "10.5.0.1");
    assert.deepEqual(addresses.controlplanes, ["10.5.0.2"]);
    assert.deepEqual(addresses.workers, []);
  });

  it("carries across an octet boundary", () => {
    const addresses = nodeAddresses(
      cluster({
        network: { cidr: "10.5.0.250/23" },
        controlplanes: { count: 1 },
        workers: { count: 6 },
      }),
    );
    assert.deepEqual(addresses.workers.at(-1), "10.5.1.2");
  });
});
