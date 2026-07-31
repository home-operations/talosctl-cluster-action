import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { bootAssetsKey } from "../src/cache.js";

const base = { talosVersion: "v1.13.7", arch: "x64" };

describe("bootAssetsKey", () => {
  it("is deterministic", () => {
    assert.equal(bootAssetsKey(base), bootAssetsKey(base));
  });

  it("keeps the version and architecture readable", () => {
    assert.match(bootAssetsKey(base), /^talos-boot-assets-x64-v1\.13\.7-[0-9a-f]{16}$/);
  });

  // A spec that states talosctl's defaults must share a cache with one that omits
  // them, or every stylistic variant of the same cluster downloads its own assets.
  it("treats talosctl's defaults and their explicit spelling as one key", () => {
    assert.equal(bootAssetsKey(base), bootAssetsKey({ ...base, presets: ["iso"] }));
    assert.equal(
      bootAssetsKey(base),
      bootAssetsKey({ ...base, factoryUrl: "https://factory.talos.dev/" }),
    );
  });

  it("changes when anything that changes the asset URLs changes", () => {
    const variants = [
      { ...base, talosVersion: "v1.13.6" },
      { ...base, schematicId: "deadbeef" },
      { ...base, presets: ["disk-image"] },
      { ...base, factoryUrl: "https://factory.internal/" },
      { ...base, arch: "arm64" },
    ];
    const keys = new Set([bootAssetsKey(base), ...variants.map(bootAssetsKey)]);
    assert.equal(keys.size, variants.length + 1);
  });
});
