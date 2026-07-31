import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "@actions/core";
import { exec } from "@actions/exec";

import {
  bootAssetsDir,
  bootAssetsKey,
  preseedBootAssets,
  restoreBootAssets,
  saveBootAssets,
} from "./cache.js";
import { bootAsset, installerImage } from "./factory.js";
import { loadCluster, validateSocketPath } from "./config.js";
import { buildArgs, hasMaintenancePreset, nodeAddresses, providerOf, withV } from "./args.js";
import {
  concatPatches,
  resolveProfilePatches,
  resolvePatches,
  substitutions,
  unresolved,
} from "./patches.js";
import { registerSchematic, schematicDocument, toYaml, withKernelArgs } from "./schematic.js";
import { waitForMaintenanceNodes } from "./maintenance.js";
import { assertSupportedTargetVersion, assertUsableVersion, resolveTalosctl } from "./talosctl.js";
import { assertDocker, assertKvm, assertNetworkAvailable, assertStateWritable } from "./host.js";
import { describeProfile, profileKernelArgs, profilePatches, DEFAULT_PROFILE } from "./profile.js";

const bool = (name) => core.getBooleanInput(name);

export async function run() {
  const configPath = path.resolve(core.getInput("config", { required: true }));
  const baseDir = path.dirname(configPath);

  const cluster = loadCluster(configPath);
  const name = cluster.metadata.name;
  core.info(`Loaded ${cluster.kind} '${name}' from ${configPath}`);

  const provider = providerOf(cluster);
  const isQemu = provider === "qemu";
  core.info(`Provider: ${provider}`);

  const stateRoot = path.join(os.homedir(), ".talos", "clusters");

  // Only the QEMU provisioner puts a monitor socket beside the cluster state, and
  // only it needs KVM and root.
  if (isQemu) {
    // Checked before anything is provisioned: too long a name surfaces minutes later
    // as a QEMU startup error naming the socket, not the name that caused it.
    validateSocketPath(cluster, stateRoot);
    await assertKvm();
  } else {
    await assertDocker();
    assertStateWritable(stateRoot);
  }

  // Before any node exists: a CIDR collision damages the cluster already on that
  // network, and tearing this one down afterwards would take that one with it.
  const addresses = nodeAddresses(cluster);
  await assertNetworkAvailable(addresses.gateway);

  const talosctl = await resolveTalosctl(core.getInput("talosctl"));
  core.info(`Using talosctl at ${talosctl}`);

  const clientVersion = await assertUsableVersion(talosctl);

  const profile = cluster.spec?.profile ?? DEFAULT_PROFILE;
  const qemu = cluster.spec?.qemu ?? {};
  const factoryAuth = qemu["image-factory"]?.auth;

  // Ends up in argv as --image-factory-auth, and @actions/exec echoes the whole
  // command line. Register it so the runner masks it wherever it surfaces.
  if (factoryAuth) core.setSecret(factoryAuth);

  let schematicId = isQemu ? qemu["schematic-id"] : undefined;
  const kernelArgs = profileKernelArgs(profile, provider);

  // A pre-registered id is opaque, so the profile's kernel args cannot be folded into
  // it. Say so rather than dropping them quietly.
  if (schematicId && kernelArgs.length) {
    core.warning(
      `spec.qemu.schematic-id is a pre-registered schematic, so the '${profile}' profile's ` +
        `kernel args (${kernelArgs.join(" ")}) were not applied. Use spec.qemu.schematic to ` +
        "have them merged in, or set spec.profile: none.",
    );
  }

  if (isQemu && !schematicId) {
    const document = withKernelArgs(schematicDocument(cluster, baseDir), kernelArgs);
    if (document) {
      schematicId = await registerSchematic(toYaml(document), {
        factoryUrl: qemu["image-factory"]?.url,
        auth: factoryAuth,
      });
      core.info(`Image Factory schematic: ${schematicId}`);
    }
  }

  // v-prefixed here, not just on the flag: this value also fills ${TALOS_VERSION} in
  // the profile's install-image pin, and the Factory publishes no unprefixed tag.
  const talosVersion = withV(qemu["talos-version"] ?? clientVersion);
  // The version the nodes will run, not just the binary: a pre-1.14 node rejects
  // the typed config documents the profile emits.
  if (isQemu) assertSupportedTargetVersion(talosVersion);

  const vars = substitutions({ schematicId, cluster, talosVersion, gateway: addresses.gateway });

  // Profile first: talosctl applies patches in order with a deep merge, so the
  // caller's patches override the profile key by key and leave the rest standing.
  const patches = concatPatches(
    resolveProfilePatches(profilePatches(profile, provider), { vars }),
    resolvePatches(cluster, { baseDir, vars }),
  );

  for (const line of describeProfile(profile)) {
    core.info(`profile ${profile}: ${line}`);
  }

  // The dev subcommand takes boot media as URLs rather than a schematic id, so
  // the action builds the same Factory references the qemu subcommand's presets
  // would have (see factory.js), and pins the install image the way the qemu
  // subcommand's applyDefaultSettings does.
  const factoryUrl = qemu["image-factory"]?.url;
  const asset = isQemu
    ? bootAsset({ presets: qemu.presets, factoryUrl, schematicId, talosVersion })
    : undefined;
  const installImage = isQemu
    ? installerImage({ factoryUrl, schematicId, talosVersion, secureboot: asset.secureboot })
    : undefined;

  // dev has no --image-factory-auth; a private factory's boot media is fetched by
  // the action itself, with credentials in headers rather than argv, into the
  // URL-keyed cache talosctl checks before downloading anything.
  if (isQemu && factoryAuth) {
    await preseedBootAssets([asset.url], factoryAuth);
  }

  for (const patch of [...patches.cluster, ...patches.controlplanes, ...patches.workers]) {
    const missing = unresolved(patch);
    if (missing.length) {
      core.warning(
        `config patch references unknown variable(s): ${[...new Set(missing)].join(", ")}. ` +
          `Known variables are ${Object.keys(vars).join(", ")}.`,
      );
    }
  }

  // Restored before create so talosctl's own URL-keyed cache lookup finds the
  // assets instead of downloading them. Only the qemu provisioner downloads boot
  // media; under docker there is nothing to cache.
  const cacheAssets = bool("cache") && isQemu;
  if (bool("cache") && !isQemu) {
    core.info(
      "cache: true has no effect under the docker provider, which downloads no boot assets",
    );
  }
  const assetsKey = cacheAssets
    ? bootAssetsKey({
        talosVersion,
        schematicId,
        presets: qemu.presets,
        factoryUrl: qemu["image-factory"]?.url,
      })
    : undefined;
  const restoredKey = cacheAssets ? await restoreBootAssets(assetsKey) : undefined;

  const configDir = path.resolve(
    // `||` not `??`: an empty RUNNER_TEMP would make path.join return a bare relative
    // name, which resolves against the checkout and drops cluster PKI in the repo.
    core.getInput("config-dir") || path.join(process.env.RUNNER_TEMP || os.tmpdir(), name),
  );
  fs.mkdirSync(configDir, { recursive: true });

  const talosconfig = path.join(configDir, "talosconfig");
  const kubeconfig = path.join(configDir, "kubeconfig");

  const args = buildArgs(cluster, {
    patches,
    talosconfig,
    talosVersion,
    bootAsset: asset,
    installImage,
  });

  // The QEMU provisioner's first preflight check is `os.Geteuid() != 0`, so root is
  // not a nicety there, it is a hard gate. `-E` matters as much as the elevation:
  // sudo resets HOME, and cluster state lives at $HOME/.talos/clusters. A runner
  // already running as root needs neither.
  const elevate = isQemu && process.geteuid() !== 0;

  // Saved before create, not after: a run that fails partway still leaves nodes and a
  // network behind, and the post step has to be able to tear them down.
  core.saveState("cleanup", String(bool("cleanup")));
  core.saveState("cluster-name", name);
  core.saveState("talosctl", talosctl);
  core.saveState("sudo", String(elevate));

  // The provisioner writes generated machine configs, which embed cluster PKI, into
  // the working directory, so it runs in configDir rather than the checkout.
  if (elevate) {
    await exec("sudo", ["-E", talosctl, ...args], { cwd: configDir });
    // Everything the provisioner wrote is owned by root; later steps are not. The
    // boot asset cache is included so the runner user, and any cache step, can
    // manage it after the run.
    const rootOwned = [configDir, bootAssetsDir()].filter((dir) => fs.existsSync(dir));
    await exec("sudo", ["chown", "-R", `${process.getuid()}:${process.getgid()}`, ...rootOwned]);
  } else {
    await exec(talosctl, args, { cwd: configDir });
  }

  if (cacheAssets) await saveBootAssets(assetsKey, restoredKey);

  const endpoint = addresses.controlplanes[0];

  // The maintenance preset leaves the nodes unconfigured, so there is no cluster to
  // fetch a kubeconfig from, and the generated talosconfig's certs match machine
  // configs that were never applied. Exporting either would point later steps, or the
  // caller's own bootstrap tooling, at a cluster that does not exist. The node
  // addresses are the whole hand-off; the nodes answer on the insecure maintenance
  // API (`talosctl -n <ip> --insecure`).
  const maintenance = hasMaintenancePreset(cluster);

  if (!maintenance) {
    await exec(talosctl, ["kubeconfig", kubeconfig, "--nodes", endpoint, "--force"], {
      env: { ...process.env, TALOSCONFIG: talosconfig },
    });

    core.exportVariable("TALOSCONFIG", talosconfig);
    core.exportVariable("KUBECONFIG", kubeconfig);
  } else {
    // With no machine config to wait on, create returns as soon as the VMs launch,
    // and the caller's first `talosctl --insecure` would race the boot.
    const nodes = [...addresses.controlplanes, ...addresses.workers];
    core.info(`Waiting for the maintenance API to answer on ${nodes.join(", ")}`);
    await waitForMaintenanceNodes(nodes);
  }

  core.setOutput("cluster-name", name);
  core.setOutput("provider", provider);
  core.setOutput("kubeconfig", maintenance ? "" : kubeconfig);
  // Still written by `cluster create` in maintenance mode, alongside the generated
  // machine configs it belongs to; it becomes valid if the caller applies them.
  core.setOutput("talosconfig", talosconfig);
  core.setOutput("schematic-id", schematicId ?? "");
  core.setOutput("endpoint", endpoint);
  core.setOutput("gateway", addresses.gateway);
  core.setOutput("controlplane-ips", addresses.controlplanes.join(","));
  core.setOutput("worker-ips", addresses.workers.join(","));

  core.info(
    maintenance
      ? `Cluster '${name}' nodes answering in maintenance mode; first node at ${endpoint}`
      : `Cluster '${name}' ready at ${endpoint}`,
  );
}

run().catch((err) => core.setFailed(err.message));
