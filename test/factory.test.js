import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  bootAsset,
  bootMethodOf,
  installerImage,
  EMPTY_SCHEMATIC_ID,
  talosArch,
} from "../src/factory.js";

const base = { schematicId: "abc", talosVersion: "v1.13.7", arch: "amd64" };

describe("bootAsset", () => {
  // The default must be byte-identical to what `cluster create qemu`'s iso preset
  // would have downloaded, or the migration changes what nodes boot.
  it("builds the iso preset's URL by default", () => {
    assert.deepEqual(bootAsset(base), {
      flag: "--iso-path",
      url: "https://factory.talos.dev/image/abc/v1.13.7/metal-amd64.iso",
      secureboot: false,
    });
  });

  it("substitutes the well-known empty schematic when none was registered", () => {
    assert.match(
      bootAsset({ ...base, schematicId: undefined }).url,
      new RegExp(EMPTY_SCHEMATIC_ID),
    );
  });

  it("maps each boot-method preset onto its dev flag and asset path", () => {
    assert.equal(bootAsset({ ...base, presets: ["disk-image"] }).flag, "--disk-image-path");
    assert.match(bootAsset({ ...base, presets: ["disk-image"] }).url, /metal-amd64\.raw\.zst$/);

    const pxe = bootAsset({ ...base, presets: ["pxe", "maintenance"] });
    assert.equal(pxe.flag, "--ipxe-boot-script");
    assert.equal(pxe.url, "https://factory.talos.dev/pxe/abc/v1.13.7/metal-amd64");

    const secureboot = bootAsset({ ...base, presets: ["iso-secureboot"] });
    assert.equal(secureboot.secureboot, true);
    assert.match(secureboot.url, /metal-amd64-secureboot\.iso$/);
  });

  it("ignores the maintenance preset when picking the boot method", () => {
    assert.equal(bootMethodOf(["maintenance"]), "iso");
    assert.equal(bootMethodOf(["iso", "maintenance"]), "iso");
    assert.equal(bootMethodOf(undefined), "iso");
  });
});

describe("installerImage", () => {
  it("pins the schematic installer the way applyDefaultSettings does", () => {
    assert.equal(installerImage(base), "factory.talos.dev/metal-installer/abc:v1.13.7");
  });

  it("uses the secureboot installer for secureboot media", () => {
    assert.equal(
      installerImage({ ...base, secureboot: true }),
      "factory.talos.dev/metal-installer-secureboot/abc:v1.13.7",
    );
  });

  it("keeps only the host of a path-carrying factory URL, since it is an image ref", () => {
    assert.equal(
      installerImage({ ...base, factoryUrl: "https://factory.internal/image-factory" }),
      "factory.internal/metal-installer/abc:v1.13.7",
    );
  });
});

describe("talosArch", () => {
  it("maps node arch names to Talos arch names", () => {
    assert.equal(talosArch("x64"), "amd64");
    assert.equal(talosArch("arm64"), "arm64");
  });
});
