import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildArgs, hasMaintenancePreset, nodeAddresses, translateDisks } from "../src/args.js";

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
  it("drives the qemu provider through the dev subcommand", () => {
    assert.deepEqual(buildArgs(cluster()), [
      "cluster",
      "create",
      "dev",
      "--name",
      "dev",
      "--disk-preallocate=false",
      "--with-cluster-discovery=false",
      "--skip-injecting-config",
      "--with-apply-config",
    ]);
  });

  it("tolerates a document with no spec", () => {
    assert.doesNotThrow(() => buildArgs(cluster()));
  });

  it("omits flags the spec does not set, leaving talosctl defaults alone", () => {
    const args = buildArgs(cluster({}));
    for (const flag of ["--controlplanes", "--workers", "--cidr", "--disk", "--extra-disks"]) {
      assert.ok(!args.includes(flag), `expected ${flag} to be absent`);
    }
  });

  it("passes the caller-resolved talos version and normalises the kubernetes one", () => {
    const args = buildArgs(cluster({ "kubernetes-version": "v1.34.0" }), {
      talosVersion: "v1.13.7",
    });
    assert.equal(valueOf(args, "--talos-version"), "v1.13.7");
    assert.equal(valueOf(args, "--kubernetes-version"), "1.34.0");
  });

  it("maps per-role cpu and memory to the dev flag names", () => {
    const args = buildArgs(
      cluster({
        controlplanes: { count: 3, cpus: 2, memory: "2GiB" },
        workers: { count: 2, cpus: "4", memory: "5GiB" },
      }),
    );
    assert.equal(valueOf(args, "--controlplanes"), "3");
    assert.equal(valueOf(args, "--cpus"), "2");
    assert.equal(valueOf(args, "--memory"), "2GiB");
    assert.equal(valueOf(args, "--workers"), "2");
    assert.equal(valueOf(args, "--cpus-workers"), "4");
    assert.equal(valueOf(args, "--memory-workers"), "5GiB");
  });

  it("emits zero worker counts, which are meaningful", () => {
    const args = buildArgs(cluster({ workers: { count: 0 } }));
    assert.equal(valueOf(args, "--workers"), "0");
  });

  it("translates disks onto the dev disk flags", () => {
    const args = buildArgs(
      cluster({ qemu: { disks: ["virtio:8GiB", "virtio:20GiB", "nvme:20GiB:serial=abc"] } }),
    );
    assert.equal(valueOf(args, "--disk"), "8192");
    assert.equal(valueOf(args, "--extra-disks"), "2");
    assert.equal(valueOf(args, "--extra-disks-size"), "20480");
    assert.equal(valueOf(args, "--extra-disks-drivers"), "virtio,nvme");
    assert.equal(valueOf(args, "--extra-disks-serials"), ",abc");
  });

  it("emits only the primary disk flag for a single-entry list", () => {
    const args = buildArgs(cluster({ qemu: { disks: ["virtio:6GiB"] } }));
    assert.equal(valueOf(args, "--disk"), "6144");
    assert.ok(!args.includes("--extra-disks"));
  });

  it("repeats config-patch flags per role, using the dev role names", () => {
    const args = buildArgs(cluster({}), {
      patches: { cluster: ['{"a":1}', '{"b":2}'], controlplanes: ['{"c":3}'], workers: [] },
    });
    assert.deepEqual(valuesOf(args, "--config-patch"), ['{"a":1}', '{"b":2}']);
    assert.deepEqual(valuesOf(args, "--config-patch-control-plane"), ['{"c":3}']);
    assert.ok(!args.includes("--config-patch-worker"));
  });

  it("passes the boot asset, install image, and talosconfig from the caller", () => {
    const args = buildArgs(cluster({}), {
      bootAsset: {
        flag: "--iso-path",
        url: "https://factory.talos.dev/image/x/v1/metal-amd64.iso",
      },
      installImage: "factory.talos.dev/metal-installer/x:v1",
      talosconfig: "/tmp/dev/talosconfig",
    });
    assert.equal(
      valueOf(args, "--iso-path"),
      "https://factory.talos.dev/image/x/v1/metal-amd64.iso",
    );
    assert.equal(valueOf(args, "--install-image"), "factory.talos.dev/metal-installer/x:v1");
    assert.equal(valueOf(args, "--talosconfig"), "/tmp/dev/talosconfig");
  });

  // Mirrors iso_secureboot_preset.go: TPM 2.0 plus TPM-keyed disk encryption.
  it("expands the secureboot boot asset into the TPM and encryption flags", () => {
    const args = buildArgs(cluster({}), {
      bootAsset: { flag: "--iso-path", url: "https://x/secureboot.iso", secureboot: true },
    });
    for (const flag of ["--with-tpm2", "--encrypt-state", "--encrypt-ephemeral"]) {
      assert.ok(args.includes(flag), `expected ${flag}`);
    }
    assert.equal(valueOf(args, "--disk-encryption-key-types"), "tpm");
  });

  // Replicates the qemu subcommand's lifecycle: config over the API, except under
  // the maintenance preset, where nothing is applied and nothing can be waited on.
  it("applies config over the API, or waits for nothing under maintenance", () => {
    const normal = buildArgs(cluster({}));
    assert.ok(normal.includes("--skip-injecting-config"));
    assert.ok(normal.includes("--with-apply-config"));

    const maintenance = buildArgs(cluster({ qemu: { presets: ["iso", "maintenance"] } }));
    assert.ok(maintenance.includes("--skip-injecting-config"));
    assert.ok(maintenance.includes("--wait=false"));
    assert.ok(!maintenance.includes("--with-apply-config"));
  });
});

describe("translateDisks", () => {
  it("rejects a non-virtio primary disk with the reason", () => {
    assert.throws(() => translateDisks(["nvme:10GiB"]), /primary disk must be virtio/);
  });

  it("rejects mixed extra disk sizes with the reason", () => {
    assert.throws(
      () => translateDisks(["virtio:6GiB", "virtio:10GiB", "virtio:20GiB"]),
      /extra disks must all be the same size/,
    );
  });

  it("rejects tags and serials on the primary disk", () => {
    assert.throws(() => translateDisks(["virtio:6GiB:tag=x"]), /only available on extra disks/);
  });

  it("converts sizes to the MB the dev flags expect", () => {
    assert.equal(translateDisks(["virtio:6GiB"]).disk, 6144);
    assert.equal(translateDisks(["virtio:512MiB"]).disk, 512);
    assert.equal(translateDisks(["virtio:1TiB"]).disk, 1048576);
  });

  it("carries per-disk drivers, tags, and serials for the extras", () => {
    const disks = translateDisks(["virtio:6GiB", "virtio:5GiB:tag=data", "nvme:5GiB:serial=s1"]);
    assert.deepEqual(disks.drivers, ["virtio", "nvme"]);
    assert.deepEqual(disks.tags, ["data", ""]);
    assert.deepEqual(disks.serials, ["", "s1"]);
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
