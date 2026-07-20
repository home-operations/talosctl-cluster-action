/**
 * Baseline settings for a cluster that exists for the length of one CI run.
 *
 * Everything here is a plain machine config patch, emitted *before* the caller's own
 * patches. talosctl applies patches in order with a deep merge, so a spec overrides
 * any single key by setting it in config-patches, and untouched keys survive. The one
 * exception is the kernel args, which live in the Image Factory schematic rather than
 * in a patch; those merge by key, with the spec's value winning.
 */

export const DEFAULT_PROFILE = "ephemeral";

// The console dashboard redraws continuously for nobody to watch, auditd logs kernel
// audit events nothing reads, and CPU side-channel mitigations cost real cycles in a
// guest that is destroyed at the end of the run.
const KERNEL_ARGS = ["talos.dashboard.disabled=1", "talos.auditd.disabled=1", "mitigations=off"];

// Borrowed from kind. A node's disk holds two full sets of Kubernetes images plus the
// Talos installer; if kubelet's default thresholds trip partway through a run it
// garbage-collects images and evicts pods, which reads as a flaky test rather than a
// disk problem. Nothing here is reclaimed anyway, the VM is deleted.
const KUBELET_GC = {
  name: "kubelet GC and eviction thresholds",
  patch: {
    machine: {
      kubelet: {
        extraConfig: {
          imageGCHighThresholdPercent: 100,
          evictionHard: {
            "nodefs.available": "0%",
            "nodefs.inodesFree": "0%",
            "imagefs.available": "0%",
          },
        },
      },
    },
  },
};

// talosctl never sets machine.install.image, so nodes come up on the generic
// installer. On the first `talosctl upgrade` that silently drops every extension the
// schematic baked in. Only meaningful when a schematic is in play.
const INSTALL_IMAGE = {
  name: "install image pinned to the schematic",
  patch: {
    machine: {
      install: { image: "factory.talos.dev/installer/${SCHEMATIC_ID}:${TALOS_VERSION}" },
    },
  },
};

// Trades durability for I/O, which is the right trade for a cluster that is destroyed
// at the end of the run. Talos only rejects the etcd args it manages for cluster
// membership, so this one passes through.
const ETCD_FSYNC = {
  name: "etcd fsync disabled",
  patch: { cluster: { etcd: { extraArgs: { "unsafe-no-fsync": "true" } } } },
};

// Talos logs every API request at Metadata level to /var/log/audit/kube. Nothing
// reads it here.
const AUDIT_POLICY = {
  name: "apiserver audit policy off",
  patch: {
    cluster: {
      apiServer: {
        auditPolicy: { apiVersion: "audit.k8s.io/v1", kind: "Policy", rules: [{ level: "None" }] },
      },
    },
  },
};

/** Kernel args the profile contributes to the schematic. */
export function profileKernelArgs(profile, provider = "qemu") {
  // Kernel args ride in an Image Factory schematic, which only the qemu provider
  // uses; docker runs a prebuilt Talos image and has no equivalent.
  if (profile !== "ephemeral" || provider === "docker") return [];
  return [...KERNEL_ARGS];
}

/**
 * Patches the profile contributes, by role. Emitted before the caller's own patches
 * so that theirs win.
 */
export function profilePatches(profile, { hasSchematic = false } = {}) {
  if (profile !== "ephemeral") return { cluster: [], controlplanes: [], workers: [] };

  return {
    cluster: hasSchematic ? [KUBELET_GC, INSTALL_IMAGE] : [KUBELET_GC],
    controlplanes: [ETCD_FSYNC, AUDIT_POLICY],
    workers: [],
  };
}

/** One line per thing the profile did, so a run never applies anything unannounced. */
export function describeProfile(profile, options = {}) {
  if (profile !== "ephemeral") return [];

  const { cluster, controlplanes, workers } = profilePatches(profile, options);
  const args = profileKernelArgs(profile, options.provider);

  return [
    ...(args.length ? [`kernel args: ${args.join(" ")}`] : []),
    ...[...cluster, ...controlplanes, ...workers].map((entry) => entry.name),
  ];
}
