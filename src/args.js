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

// One disk entry: driver, a size with unit, then optional :tag= / :serial= params.
const DISK_RE = /^([a-z0-9]+):([0-9]+(?:\.[0-9]+)?)\s*([KMGT]i?B|B)?((?::[a-z]+=[^:]+)*)$/;

const UNIT_MB = {
  B: 1 / (1024 * 1024),
  KB: 1 / 1024,
  KiB: 1 / 1024,
  MB: 1,
  MiB: 1,
  GB: 1024,
  GiB: 1024,
  TB: 1024 * 1024,
  TiB: 1024 * 1024,
};

/**
 * Map spec.qemu.disks onto `cluster create dev`'s count-based disk flags.
 *
 * The dev subcommand kept the legacy disk interface: one virtio primary sized in
 * MB, plus N worker-only extra disks that share a single size but carry per-disk
 * drivers, tags, and serials. The list syntax stays expressible with two
 * constraints, both rejected here with the reason rather than silently mangled:
 * the primary must be virtio, and every extra disk must be the same size.
 */
export function translateDisks(disks) {
  const parse = (entry, position) => {
    const match = DISK_RE.exec(entry);
    if (!match) throw new Error(`spec.qemu.disks[${position}]: cannot parse '${entry}'`);

    const [, driver, size, unit = "MiB", params] = match;
    const mb = Math.round(Number(size) * UNIT_MB[unit]);
    const tag = /:tag=([^:]+)/.exec(params)?.[1] ?? "";
    const serial = /:serial=([^:]+)/.exec(params)?.[1] ?? "";

    return { driver, mb, tag, serial };
  };

  const [primary, ...extras] = disks.map(parse);

  if (primary.driver !== "virtio") {
    throw new Error(
      `spec.qemu.disks[0]: the primary disk must be virtio; '${primary.driver}' is only ` +
        "available for the extra worker disks",
    );
  }
  if (primary.tag || primary.serial) {
    throw new Error("spec.qemu.disks[0]: tag= and serial= are only available on extra disks");
  }

  const sizes = new Set(extras.map((disk) => disk.mb));
  if (sizes.size > 1) {
    throw new Error(
      "spec.qemu.disks: extra disks must all be the same size " +
        `(got ${[...sizes].join("MB, ")}MB); talosctl's dev interface sizes them together`,
    );
  }

  return {
    disk: primary.mb,
    extraDisks: extras.length,
    extraDisksSize: extras[0]?.mb,
    drivers: extras.map((disk) => disk.driver),
    tags: extras.map((disk) => disk.tag),
    serials: extras.map((disk) => disk.serial),
  };
}

export function buildArgs(cluster, ctx = {}) {
  const spec = cluster.spec ?? {};
  const provider = providerOf(cluster);

  // The qemu provider is driven through `cluster create dev`: upstream froze the
  // qemu subcommand's flag surface and points anyone needing the full set (boot
  // media paths, install image, network shaping) at dev. The action pins the
  // exact behavior the qemu subcommand had — same Factory media, same
  // maintenance-boot + API-apply lifecycle — through explicit flags.
  const args = ["cluster", "create", provider === "qemu" ? "dev" : provider];
  args.push("--name", cluster.metadata.name);

  const push = (flag, value) => {
    if (value !== undefined && value !== null) args.push(flag, String(value));
  };

  push("--kubernetes-version", spec["kubernetes-version"] && withoutV(spec["kubernetes-version"]));

  push("--workers", spec.workers?.count);

  if (provider === "qemu") {
    const qemu = spec.qemu ?? {};

    // dev renamed the control-plane resource flags; the worker ones match.
    push("--controlplanes", spec.controlplanes?.count);
    push("--cpus", spec.controlplanes?.cpus);
    push("--memory", spec.controlplanes?.memory);
    push("--cpus-workers", spec.workers?.cpus);
    push("--memory-workers", spec.workers?.memory);

    push("--cidr", spec.network?.cidr);
    push("--mtu", spec.network?.mtu);

    if (qemu.disks?.length) {
      const disks = translateDisks(qemu.disks);
      push("--disk", disks.disk);
      if (disks.extraDisks > 0) {
        push("--extra-disks", disks.extraDisks);
        push("--extra-disks-size", disks.extraDisksSize);
        push("--extra-disks-drivers", disks.drivers.join(","));
        if (disks.tags.some(Boolean)) push("--extra-disks-tags", disks.tags.join(","));
        if (disks.serials.some(Boolean)) push("--extra-disks-serials", disks.serials.join(","));
      }
    }

    // Always passed: dev defaults to "latest", and the boot asset URLs and the
    // install image pin below already embed the resolved version.
    push("--talos-version", ctx.talosVersion);

    // The boot media the qemu subcommand's preset would have chosen, as an
    // explicit Factory URL (see factory.js).
    if (ctx.bootAsset) {
      args.push(ctx.bootAsset.flag, ctx.bootAsset.url);
      if (ctx.bootAsset.secureboot) {
        // What the iso-secureboot preset sets (iso_secureboot_preset.go): TPM 2.0
        // plus TPM-keyed state/ephemeral encryption. Needs swtpm on the runner.
        args.push("--with-tpm2");
        args.push("--encrypt-state");
        args.push("--encrypt-ephemeral");
        push("--disk-encryption-key-types", "tpm");
      }
    }

    // dev defaults to the generic installer, which silently drops schematic
    // extensions on the first upgrade; the qemu subcommand pins this itself in
    // applyDefaultSettings.
    push("--install-image", ctx.installImage);

    // The dev subcommand registers --disk-preallocate with a literal default of
    // true, unlike the qemu subcommand, which kept the option's false default and
    // created sparse disks. Preallocation quietly multiplies a spec's nominal disk
    // sizes into real bytes and fills a CI runner's disk before the first node
    // boots; sparse is both the parity behavior and the only one that fits.
    args.push("--disk-preallocate=false");

    // No DiscoveryServiceConfig document is generated at all, which is how 1.14
    // configs turn the public discovery service off. A spec that wants it back
    // adds its own document via config-patches.
    args.push("--with-cluster-discovery=false");

    // Replicates the qemu subcommand's lifecycle: nodes boot to maintenance mode
    // and the config is applied over the API, never injected into the boot.
    // Under the maintenance preset nothing is applied and there is no cluster to
    // wait for.
    args.push("--skip-injecting-config");
    if (hasMaintenancePreset(cluster)) {
      args.push("--wait=false");
    } else {
      args.push("--with-apply-config");
    }
  } else {
    const docker = spec.docker ?? {};

    push("--cpus-controlplanes", spec.controlplanes?.cpus);
    push("--memory-controlplanes", spec.controlplanes?.memory);
    push("--cpus-workers", spec.workers?.cpus);
    push("--memory-workers", spec.workers?.memory);

    push("--subnet", spec.network?.cidr);
    // --mtu is registered in getCommonUserFacingFlags and merely MarkHidden;
    // docker feeds it to the bridge as com.docker.network.driver.mtu.
    push("--mtu", spec.network?.mtu);

    push("--image", docker.image);
    push("--host-ip", docker["host-ip"]);
    push("--exposed-ports", docker["exposed-ports"]);

    for (const mount of docker.mounts ?? []) args.push("--mount", mount);
  }

  // Repeated flags, one per patch. These are StringArray rather than StringSlice
  // flags, so pflag does not split on commas and a JSON patch survives intact.
  // dev and docker also disagree on the role flag names.
  const [cpFlag, workerFlag] =
    provider === "qemu"
      ? ["--config-patch-control-plane", "--config-patch-worker"]
      : ["--config-patch-controlplanes", "--config-patch-workers"];

  for (const patch of ctx.patches?.cluster ?? []) args.push("--config-patch", patch);
  for (const patch of ctx.patches?.controlplanes ?? []) args.push(cpFlag, patch);
  for (const patch of ctx.patches?.workers ?? []) args.push(workerFlag, patch);

  push(provider === "qemu" ? "--talosconfig" : "--talosconfig-destination", ctx.talosconfig);

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
