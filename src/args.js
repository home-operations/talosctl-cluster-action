/**
 * Maps a validated TalosCluster onto `talosctl cluster create <provider>` arguments.
 *
 * A flag is emitted only when the spec sets it, so anything left out keeps talosctl's
 * own default rather than a default this action invents and then has to keep in step
 * across Talos releases.
 */

export const DEFAULT_PROVIDER = "qemu";

// Only one of these is load-bearing. create_qemu.go rejects a talos version whose
// first character is not 'v' ("version string must start with a 'v'"), so withV is
// required. --kubernetes-version has no such rule: makers/common.go already does
// TrimPrefix(version, "v"), so withoutV only normalises what is echoed in the log.
// Do not delete withV thinking the pair is symmetric.
export const withV = (v) => (String(v).startsWith("v") ? String(v) : `v${v}`);
const withoutV = (v) => String(v).replace(/^v/, "");

export const providerOf = (cluster) => cluster.spec?.provider ?? DEFAULT_PROVIDER;

// talosctl's maintenance preset boots the nodes but applies no machine config, so no
// cluster ever forms behind them. main.js keys off this to skip the kubeconfig fetch
// and the KUBECONFIG/TALOSCONFIG exports, which would otherwise point later steps at
// a cluster that does not exist.
export const hasMaintenancePreset = (cluster) =>
  Boolean(cluster.spec?.qemu?.presets?.includes("maintenance"));

export function buildArgs(cluster, ctx = {}) {
  const spec = cluster.spec ?? {};
  const provider = providerOf(cluster);
  const args = ["cluster", "create", provider, "--name", cluster.metadata.name];

  const push = (flag, value) => {
    if (value !== undefined && value !== null) args.push(flag, String(value));
  };

  push("--kubernetes-version", spec["kubernetes-version"] && withoutV(spec["kubernetes-version"]));

  // Shared, except --controlplanes: docker never registers it and always runs exactly
  // one, so passing it would be an unknown-flag error rather than a no-op.
  if (provider === "qemu") push("--controlplanes", spec.controlplanes?.count);
  push("--cpus-controlplanes", spec.controlplanes?.cpus);
  push("--memory-controlplanes", spec.controlplanes?.memory);

  push("--workers", spec.workers?.count);
  push("--cpus-workers", spec.workers?.cpus);
  push("--memory-workers", spec.workers?.memory);

  // Same underlying option, different flag name per subcommand. --mtu is shared: it
  // is registered in getCommonUserFacingFlags and merely MarkHidden, so it is absent
  // from `--help` but accepted by both, and docker feeds it to the bridge as
  // com.docker.network.driver.mtu.
  push(provider === "docker" ? "--subnet" : "--cidr", spec.network?.cidr);
  push("--mtu", spec.network?.mtu);

  if (provider === "qemu") {
    const qemu = spec.qemu ?? {};

    push("--talos-version", qemu["talos-version"] && withV(qemu["talos-version"]));

    // One comma-joined flag, not repeated flags: the Disks pflag.Value replaces its
    // accumulated list on every Set, so `--disks a --disks b` silently keeps only b.
    if (qemu.disks?.length) push("--disks", qemu.disks.join(","));

    push("--schematic-id", ctx.schematicId);
    push("--image-factory-url", qemu["image-factory"]?.url);
    push("--image-factory-auth", qemu["image-factory"]?.auth);

    if (qemu.presets?.length) push("--presets", qemu.presets.join(","));
  } else {
    const docker = spec.docker ?? {};

    push("--image", docker.image);
    push("--host-ip", docker["host-ip"]);
    push("--exposed-ports", docker["exposed-ports"]);

    for (const mount of docker.mounts ?? []) args.push("--mount", mount);
  }

  // Repeated flags, one per patch. These are StringArray rather than StringSlice
  // flags, so pflag does not split on commas and a JSON patch survives intact.
  for (const patch of ctx.patches?.cluster ?? []) args.push("--config-patch", patch);
  for (const patch of ctx.patches?.controlplanes ?? [])
    args.push("--config-patch-controlplanes", patch);
  for (const patch of ctx.patches?.workers ?? []) args.push("--config-patch-workers", patch);

  push("--talosconfig-destination", ctx.talosconfig);

  return args;
}

/**
 * Node addresses the provisioner will assign. Both providers put the gateway on the
 * first address of the network and number nodes upward from the second, control
 * planes before workers.
 */
export function nodeAddresses(cluster) {
  const spec = cluster.spec ?? {};
  const cidr = spec.network?.cidr ?? "10.5.0.0/24";
  const [base] = cidr.split("/");
  const octets = base.split(".").map(Number);

  const address = (offset) => {
    const value = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) + offset;
    return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
  };

  // docker has no --controlplanes flag and always runs one; parseCluster rejects any
  // docker spec that says otherwise, so the plain default covers both providers.
  const controlplanes = spec.controlplanes?.count ?? 1;
  const workers = spec.workers?.count ?? 1;

  return {
    gateway: address(1),
    controlplanes: Array.from({ length: controlplanes }, (_, i) => address(2 + i)),
    workers: Array.from({ length: workers }, (_, i) => address(2 + controlplanes + i)),
  };
}
