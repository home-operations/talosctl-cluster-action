import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseCluster,
  monitorSocketPath,
  validateSocketPath,
  SOCKET_PATH_LIMIT,
} from "../src/config.js";

const minimal = `
apiVersion: v1alpha1
kind: TalosCluster
metadata:
  name: dev
`;

describe("parseCluster", () => {
  it("accepts a minimal document with no spec at all", () => {
    const cluster = parseCluster(minimal);
    assert.equal(cluster.metadata.name, "dev");
    assert.equal(cluster.spec, undefined);
  });

  it("accepts the full documented surface", () => {
    const cluster = parseCluster(`
apiVersion: v1alpha1
kind: TalosCluster
metadata:
  name: dev
spec:
  kubernetes-version: v1.34.0
  controlplanes:
    count: 1
  workers:
    count: 2
    cpus: 2
    memory: 4GiB
  network:
    cidr: 10.5.0.0/24
  qemu:
    talos-version: v1.13.6
    disks:
      - virtio:10GiB
      - virtio:20GiB
    presets: [iso]
  config-patches:
    workers:
      - machine:
          sysctls:
            net.ipv6.conf.all.forwarding: "1"
`);
    assert.equal(cluster.spec.workers.count, 2);
    assert.equal(cluster.spec["config-patches"].workers.length, 1);
  });

  it('rejects spec.network.ipv6 with the reason, not just "unknown field"', () => {
    assert.throws(
      () => parseCluster(`${minimal}spec:\n  network:\n    cidr: 10.5.0.0/24\n    ipv6: true\n`),
      (err) => {
        assert.match(err.message, /spec\.network\.ipv6/);
        assert.match(err.message, /cluster create dev/);
        assert.match(err.message, /config-patches/);
        return true;
      },
    );
  });

  it("points per-role disks at spec.disks", () => {
    assert.throws(
      () => parseCluster(`${minimal}spec:\n  workers:\n    count: 1\n    disks: [virtio:20GiB]\n`),
      /spec\.workers\.disks.*spec\.qemu\.disks/s,
    );
  });

  // The k8s envelope invites putting spec fields at the root; say so rather than
  // reporting a bare unknown field.
  it("tells you when a spec field is at the document root", () => {
    assert.throws(
      () => parseCluster(`${minimal}workers:\n  count: 2\n`),
      /workers: belongs under spec/,
    );
  });

  it("tells you when the name is at the document root", () => {
    assert.throws(
      () => parseCluster(`${minimal}name: dev\n`),
      /name: the cluster name lives at metadata\.name/,
    );
  });

  it("points config-patches.all at the cluster key", () => {
    assert.throws(
      () => parseCluster(`${minimal}spec:\n  config-patches:\n    all:\n      - machine: {}\n`),
      /spec\.config-patches\.all.*spec\.config-patches\.cluster/s,
    );
  });

  it("reports every problem at once", () => {
    assert.throws(
      () => parseCluster(`${minimal}spec:\n  bogus: 1\n  alsoBogus: 2\n`),
      (err) => {
        assert.match(err.message, /spec\.bogus: unknown field/);
        assert.match(err.message, /spec\.alsoBogus: unknown field/);
        return true;
      },
    );
  });

  it("rejects a schematic alongside a schematic-id", () => {
    assert.throws(
      () =>
        parseCluster(
          `${minimal}spec:\n  qemu:\n    schematic-id: ${"a".repeat(64)}\n    schematic:\n      customization: {}\n`,
        ),
      /mutually exclusive/,
    );
  });

  it("requires the apiVersion, kind, and metadata envelope", () => {
    assert.throws(() => parseCluster("metadata:\n  name: dev\n"), /missing required field/);
    assert.throws(
      () => parseCluster("apiVersion: v2\nkind: TalosCluster\nmetadata:\n  name: d\n"),
      /apiVersion/,
    );
    assert.throws(
      () => parseCluster("apiVersion: v1alpha1\nkind: QemuClusterSpec\nmetadata:\n  name: d\n"),
      /kind: must be "TalosCluster"/,
    );
  });

  it("requires metadata.name", () => {
    assert.throws(
      () => parseCluster("apiVersion: v1alpha1\nkind: TalosCluster\nmetadata: {}\n"),
      /missing required field 'name'/,
    );
  });

  it("rejects a non-mapping document", () => {
    assert.throws(() => parseCluster("- a\n- b\n"), /must be a YAML mapping/);
    assert.throws(() => parseCluster("{{"), /not valid YAML/);
  });
});

describe("monitor socket path", () => {
  const cluster = {
    metadata: { name: "dev" },
    spec: { controlplanes: { count: 3 }, workers: { count: 2 } },
  };

  it("models <state>/<name>/<name>-<role>-<n>.monitor", () => {
    const socket = monitorSocketPath(cluster, "/home/runner/.talos/clusters");
    assert.equal(socket, "/home/runner/.talos/clusters/dev/dev-controlplane-3.monitor");
  });

  it("accepts a short name", () => {
    assert.ok(
      validateSocketPath(cluster, "/home/runner/.talos/clusters").length <= SOCKET_PATH_LIMIT,
    );
  });

  // The exact failure both source projects hit: a name carrying github.run_id.
  it("rejects a name that overflows the UNIX socket limit", () => {
    const long = { ...cluster, metadata: { name: "tuppr-e2e-18395720461-3cp-0w" } };
    assert.throws(
      () => validateSocketPath(long, "/home/runner/.talos/clusters"),
      (err) => {
        assert.match(err.message, /too long/);
        assert.match(err.message, /Shorten it to at most \d+ characters/);
        return true;
      },
    );
  });
});
