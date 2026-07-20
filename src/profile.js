/**
 * Baseline settings for a cluster that exists for the length of one CI run.
 *
 * Everything here is a plain machine config patch, emitted *before* the caller's own
 * patches. talosctl applies patches in order with a deep merge, so a spec overrides
 * any single key by setting it in config-patches, and untouched keys survive. The one
 * exception is the kernel args, which live in the Image Factory schematic rather than
 * in a patch; those merge by key, with the spec's value winning.
 */

import { emptyPatches } from "./patches.js";
import { DEFAULT_PROVIDER } from "./args.js";

export const DEFAULT_PROFILE = "ephemeral";

// The console dashboard redraws continuously for nobody to watch, auditd logs kernel
// audit events nothing reads, and CPU side-channel mitigations cost real cycles in a
// guest that is destroyed at the end of the run. init_on_alloc zeroes every allocation,
// a hardening default worth trading for speed in a guest this short-lived; it is a
// kernel-config default rather than a plain cmdline arg, and Image Factory does not
// guarantee arg order (siderolabs/talos#11310), so a bare init_on_alloc=0 can lose to
// the baked-in default. Stripping it first with -init_on_alloc makes the override stick.
const KERNEL_ARGS = [
  "talos.dashboard.disabled=1",
  "talos.auditd.disabled=1",
  "mitigations=off",
  "-init_on_alloc",
  "init_on_alloc=0",
];

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

// Kubelet pulls images one at a time by default, and a cold node spends most of its
// bring-up doing exactly that. Pulling in parallel is the one real speedup a config
// patch can still buy. The cap is deliberate: an unbounded burst against a
// rate-limited registry draws a 429, which reads as a flaky test rather than a
// throttle. Unlike the rest of the profile this is a trade, not a free win, and it
// pays off most behind a pull-through cache, which a spec can add via config-patches.
const IMAGE_PULLS = {
  name: "parallel image pulls",
  patch: {
    machine: {
      kubelet: {
        extraConfig: {
          serializeImagePulls: false,
          maxParallelImagePulls: 3,
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
export function profileKernelArgs(profile, provider = DEFAULT_PROVIDER) {
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
  if (profile !== "ephemeral") return emptyPatches();

  return {
    cluster: hasSchematic ? [KUBELET_GC, IMAGE_PULLS, INSTALL_IMAGE] : [KUBELET_GC, IMAGE_PULLS],
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
