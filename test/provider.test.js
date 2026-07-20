import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildArgs, nodeAddresses, providerOf, DEFAULT_PROVIDER } from "../src/args.js";
import { parseCluster } from "../src/config.js";
import { profileKernelArgs, profilePatches } from "../src/profile.js";
import { meetsMinimum, MINIMUM_TALOS_VERSION } from "../src/talosctl.js";

const cluster = (spec) => ({
  apiVersion: "v1alpha1",
  kind: "TalosCluster",
  metadata: { name: "dev" },
  spec,
});

const valueOf = (args, flag) => args[args.indexOf(flag) + 1];
const envelope = "apiVersion: v1alpha1\nkind: TalosCluster\nmetadata:\n  name: dev\n";

describe("provider selection", () => {
  it("defaults to qemu", () => {
    assert.equal(DEFAULT_PROVIDER, "qemu");
    assert.equal(providerOf(cluster({})), "qemu");
    assert.equal(buildArgs(cluster({}))[2], "qemu");
  });

  it("targets the docker subcommand when asked", () => {
    assert.equal(buildArgs(cluster({ provider: "docker" }))[2], "docker");
  });
});

describe("docker argument mapping", () => {
  const docker = (spec) => buildArgs(cluster({ provider: "docker", ...spec }));

  // Same underlying NetworkCIDR option, different flag name per subcommand.
  it("maps the network to --subnet, not --cidr", () => {
    const args = docker({ network: { cidr: "10.6.0.0/24" } });
    assert.equal(valueOf(args, "--subnet"), "10.6.0.0/24");
    assert.ok(!args.includes("--cidr"));
  });

  // docker never registers --controlplanes; passing it is an unknown-flag error.
  it("never emits --controlplanes", () => {
    const args = docker({ controlplanes: { count: 1, cpus: 2, memory: "2GiB" } });
    assert.ok(!args.includes("--controlplanes"));
    assert.equal(valueOf(args, "--cpus-controlplanes"), "2");
    assert.equal(valueOf(args, "--memory-controlplanes"), "2GiB");
  });

  it("emits the docker-only flags", () => {
    const args = docker({
      docker: {
        image: "ghcr.io/siderolabs/talos:v1.13.6",
        "host-ip": "127.0.0.1",
        "exposed-ports": "8080:80/tcp",
        mounts: ["type=bind,source=/tmp,target=/tmp", "type=tmpfs,target=/run"],
      },
    });
    assert.equal(valueOf(args, "--image"), "ghcr.io/siderolabs/talos:v1.13.6");
    assert.equal(valueOf(args, "--host-ip"), "127.0.0.1");
    assert.equal(valueOf(args, "--exposed-ports"), "8080:80/tcp");
    assert.equal(args.filter((a) => a === "--mount").length, 2);
  });

  it("never emits qemu-only flags", () => {
    const args = docker({ network: { cidr: "10.6.0.0/24" } });
    for (const flag of ["--disks", "--schematic-id", "--presets", "--talos-version"]) {
      assert.ok(!args.includes(flag), `expected ${flag} to be absent`);
    }
  });

  // --mtu is registered in getCommonUserFacingFlags and merely MarkHidden, so it is
  // missing from `--help` but accepted by both subcommands, and docker passes it to
  // the bridge as com.docker.network.driver.mtu. Deriving "docker has no --mtu" from
  // help output is what made this wrong the first time.
  it("emits --mtu, which is hidden on both subcommands rather than qemu-only", () => {
    assert.equal(valueOf(docker({ network: { mtu: 1400 } }), "--mtu"), "1400");
    assert.equal(valueOf(buildArgs(cluster({ network: { mtu: 1400 } })), "--mtu"), "1400");
  });

  it("counts exactly one control plane when numbering addresses", () => {
    const addresses = nodeAddresses(
      cluster({ provider: "docker", network: { cidr: "10.6.0.0/24" }, workers: { count: 2 } }),
    );
    assert.deepEqual(addresses.controlplanes, ["10.6.0.2"]);
    assert.deepEqual(addresses.workers, ["10.6.0.3", "10.6.0.4"]);
  });
});

describe("provider-aware validation", () => {
  it("rejects a block belonging to the other provider", () => {
    assert.throws(
      () => parseCluster(`${envelope}spec:\n  provider: docker\n  qemu:\n    presets: [iso]\n`),
      /spec\.qemu is set but spec\.provider is 'docker'/,
    );
    assert.throws(
      () => parseCluster(`${envelope}spec:\n  provider: qemu\n  docker:\n    image: talos\n`),
      /spec\.docker is set but spec\.provider is 'qemu'/,
    );
  });

  it("rejects more than one control plane on docker", () => {
    assert.throws(
      () => parseCluster(`${envelope}spec:\n  provider: docker\n  controlplanes:\n    count: 3\n`),
      /only supported by the qemu provider/,
    );
    assert.doesNotThrow(() =>
      parseCluster(`${envelope}spec:\n  provider: docker\n  controlplanes:\n    count: 1\n`),
    );
  });

  it("points a provider field written straight under spec at its block", () => {
    assert.throws(
      () => parseCluster(`${envelope}spec:\n  disks: [virtio:10GiB]\n`),
      /spec\.disks: belongs under spec\.qemu/,
    );
    assert.throws(
      () => parseCluster(`${envelope}spec:\n  image: talos\n`),
      /spec\.image: belongs under spec\.docker/,
    );
  });

  it("rejects an unknown provider", () => {
    assert.throws(
      () => parseCluster(`${envelope}spec:\n  provider: firecracker\n`),
      /spec\.provider: must be one of qemu, docker/,
    );
  });
});

describe("profile under docker", () => {
  // Kernel args ride in an Image Factory schematic, which docker does not use.
  it("skips the kernel args but keeps the machine config settings", () => {
    assert.deepEqual(profileKernelArgs("ephemeral", "docker"), []);
    assert.ok(profileKernelArgs("ephemeral", "qemu").length > 0);

    const patches = profilePatches("ephemeral", { provider: "docker", hasSchematic: false });
    assert.match(JSON.stringify(patches.cluster), /imageGCHighThresholdPercent/);
    assert.match(JSON.stringify(patches.controlplanes), /unsafe-no-fsync/);
    // No schematic means nothing to pin an install image to.
    assert.doesNotMatch(JSON.stringify(patches.cluster), /install/);
  });
});

// v1.12 introduced the qemu/docker subcommands, but the floor is v1.13: the action
// emits --image-factory-auth and accepts :tag=/:serial= disk parameters, neither of
// which v1.12 understands. Gating on v1.12 would admit users straight into the bare
// cobra errors this check exists to prevent.
describe("talosctl minimum version", () => {
  it("requires the release that supports every flag the action emits", () => {
    assert.equal(MINIMUM_TALOS_VERSION, "1.13.0");
  });

  it("rejects releases older than that, including the subcommand release itself", () => {
    for (const v of ["v1.12.0", "1.12.9", "v1.11.0", "v1.9.3", "0.14.0"]) {
      assert.equal(meetsMinimum(v), false, v);
    }
  });

  it("accepts that release and newer", () => {
    for (const v of ["v1.13.0", "1.13.6", "v1.14.0", "v2.0.0"]) {
      assert.equal(meetsMinimum(v), true, v);
    }
  });

  it("does not block a version it cannot parse", () => {
    for (const v of ["", undefined, "dev", "unknown"]) {
      assert.equal(meetsMinimum(v), true, String(v));
    }
  });

  it("handles pre-release and build suffixes", () => {
    assert.equal(meetsMinimum("v1.13.0-alpha.1"), true);
    assert.equal(meetsMinimum("v1.12.0-beta.2"), false);
  });
});
