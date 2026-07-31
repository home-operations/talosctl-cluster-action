import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as cache from "@actions/cache";
import * as core from "@actions/core";

import { DEFAULT_FACTORY_URL } from "./schematic.js";

/**
 * Where talosctl caches Image Factory downloads, keyed by source URL. Fixed in
 * downloadBootAssets (cmd/talosctl/cmd/mgmt/cluster/create/create.go), which checks
 * this directory before downloading anything.
 */
export const bootAssetsDir = () => path.join(os.homedir(), ".talos", "cache");

/**
 * A key covering everything that changes the asset URLs talosctl builds: the
 * presets pick which assets (ISO, disk image, PXE kernel), the factory, schematic,
 * version, and architecture form the URL itself. talosctl's cache is keyed by full
 * URL, so a wrong hit cannot serve wrong bytes; a stale key just re-downloads.
 */
export function bootAssetsKey({
  talosVersion,
  schematicId,
  presets,
  factoryUrl,
  arch = os.arch(),
}) {
  const fingerprint = crypto
    .createHash("sha256")
    // talosctl's own defaults, spelled out so a spec that states them gets the
    // same key as one that omits them.
    .update(
      JSON.stringify([factoryUrl ?? DEFAULT_FACTORY_URL, schematicId ?? "", presets ?? ["iso"]]),
    )
    .digest("hex")
    .slice(0, 16);

  return `talos-boot-assets-${arch}-${talosVersion}-${fingerprint}`;
}

/** Restore the boot asset directory; returns the hit key, or undefined on a miss. */
export async function restoreBootAssets(key) {
  if (!cache.isFeatureAvailable()) {
    core.warning("the actions cache service is unavailable; boot assets will not be cached");
    return undefined;
  }

  try {
    const hit = await cache.restoreCache([bootAssetsDir()], key);
    core.info(
      hit ? `Boot assets restored from cache '${hit}'` : `No cached boot assets for '${key}'`,
    );
    return hit;
  } catch (err) {
    core.warning(`boot asset cache restore failed: ${err.message}`);
    return undefined;
  }
}

/** Save the boot asset directory unless this exact key was already restored. */
export async function saveBootAssets(key, restoredKey) {
  if (key === restoredKey || !cache.isFeatureAvailable()) return;
  if (!fs.existsSync(bootAssetsDir())) return;

  try {
    await cache.saveCache([bootAssetsDir()], key);
    core.info(`Boot assets saved to cache '${key}'`);
  } catch (err) {
    // The cache is a speedup, never a gate, and a parallel matrix leg may simply
    // have won the race to save this key.
    core.warning(`boot asset cache save failed: ${err.message}`);
  }
}
