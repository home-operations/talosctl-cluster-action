import fs from "node:fs";
import { tryExec } from "./exec.js";

/**
 * Stricter than talosctl on purpose. Its own preflight only warns when /dev/kvm is
 * missing and carries on under software emulation, which for a Talos cluster means a
 * boot slow enough to burn the job's whole timeout and then fail for an unrelated
 * reason. Failing here says why.
 */
export async function assertKvm() {
  if (!fs.existsSync("/dev/kvm")) {
    throw new Error(
      "/dev/kvm is missing. talosctl would fall back to software emulation, which is far too " +
        "slow to boot a cluster inside a CI timeout. Use a runner that exposes KVM " +
        "(GitHub-hosted ubuntu-24.04 and newer do), or the docker provider, which needs no KVM.",
    );
  }
}

/**
 * The docker provider's equivalent of the KVM check: fail before any state exists
 * rather than after the provisioner has written a state directory it cannot use.
 */
export async function assertDocker() {
  const { exitCode, stderr } = await tryExec("docker", ["info"]);

  if (exitCode === 0) return;

  throw new Error(
    /permission denied/i.test(stderr)
      ? "cannot reach the Docker daemon: permission denied. The user running this action needs " +
          "to be in the `docker` group, which is already the case on GitHub-hosted runners."
      : "cannot reach the Docker daemon. The docker provider needs a running daemon; use the " +
          "qemu provider if this host has KVM but no Docker.",
  );
}

/**
 * The cluster state directory has to be writable by whoever runs the provisioner.
 *
 * A qemu run creates it as root, because that provisioner needs root for the bridge.
 * A later docker run on the same host is not root and cannot write into it, which
 * surfaces as a bare mkdir "permission denied" with nothing pointing at the cause.
 * Only relevant for a run that is not itself using sudo.
 */
export function assertStateWritable(stateRoot) {
  if (!fs.existsSync(stateRoot)) return;

  try {
    fs.accessSync(stateRoot, fs.constants.W_OK);
  } catch {
    throw new Error(
      `${stateRoot} is not writable by the current user. It was most likely created by a qemu ` +
        "cluster, which runs as root; the docker provider does not. Remove it, or chown it back " +
        "to the user running this action.",
    );
  }
}

/**
 * Refuse to build a cluster on a network another one already owns.
 *
 * The provisioner puts the bridge on the first address of the CIDR. Two clusters on
 * one host with the same CIDR share that bridge and its tap devices, so creating the
 * second disrupts the first, and destroying either tears down the network under both.
 * An ephemeral runner never hits this; a self-hosted or developer machine running two
 * clusters at once hits it immediately, and the damage is silent.
 */
export function conflictingInterface(ipAddrOutput, gateway) {
  // `ip -o -4 addr show` gives one line per address:
  //   3: docker0    inet 172.16.0.1/24 brd ... scope global docker0
  const conflict = ipAddrOutput.split("\n").find((line) => line.includes(` ${gateway}/`));
  return conflict ? (conflict.trim().split(/\s+/)[1] ?? "an existing interface") : undefined;
}

export async function assertNetworkAvailable(gateway) {
  // A container image without iproute2 has no `ip`; tryExec reports that as a value.
  const { exitCode, stdout } = await tryExec("ip", ["-o", "-4", "addr", "show"]);

  // No `ip` to ask, so nothing to conclude; let the provisioner speak for itself.
  if (exitCode !== 0) return;

  const device = conflictingInterface(stdout, gateway);
  if (!device) return;

  throw new Error(
    `${gateway} is already assigned to ${device}, so another QEMU cluster is very likely ` +
      "using this network. Two clusters sharing a CIDR share a bridge: creating this one " +
      "would disrupt the other, and destroying either would tear down both. Give this " +
      "cluster its own spec.network.cidr, or destroy the existing cluster first.",
  );
}
