import { DEFAULT_FACTORY_URL } from "./schematic.js";

/**
 * Image Factory asset references for the dev backend.
 *
 * `cluster create dev` takes boot media as plain paths or URLs rather than a
 * schematic id, so the action builds the same Factory URLs the qemu subcommand's
 * presets would have (preset/*.go in talosctl), byte for byte: the schematic id
 * (or the well-known empty one), the Talos version, and the metal platform's
 * asset naming.
 */

// constants.ImageFactoryEmptySchematicID: what `cluster create qemu` substitutes
// when no schematic is given, so a spec without one boots identical media.
export const EMPTY_SCHEMATIC_ID =
  "376567988ad370138ad8b2698212367b8edcb69b5fd68c80be1f2ec7d603b4ba";

// Node arch to Talos arch. The provisioner targets the host's own architecture.
const ARCHES = { x64: "amd64", arm64: "arm64" };
export const talosArch = (nodeArch = process.arch) => ARCHES[nodeArch] ?? "amd64";

// A relative reference resolves against the base's *directory*, so a factory URL
// with a path but no trailing slash would silently lose that path (same rule as
// schematic registration).
const join = (factoryUrl, ...segments) =>
  new URL(segments.join("/"), factoryUrl.endsWith("/") ? factoryUrl : `${factoryUrl}/`).toString();

/** The boot-method preset in play: the first non-maintenance entry, iso by default. */
export const bootMethodOf = (presets) =>
  (presets ?? []).find((preset) => preset !== "maintenance") ?? "iso";

/**
 * The dev flag and Factory URL for the spec's boot method. Mirrors talosctl's
 * iso/iso-secureboot/pxe/disk-image presets (metal platform asset paths).
 */
export function bootAsset({
  presets,
  factoryUrl = DEFAULT_FACTORY_URL,
  schematicId,
  talosVersion,
  arch = talosArch(),
}) {
  const id = schematicId ?? EMPTY_SCHEMATIC_ID;
  const method = bootMethodOf(presets);

  switch (method) {
    case "iso":
      return {
        flag: "--iso-path",
        url: join(factoryUrl, "image", id, talosVersion, `metal-${arch}.iso`),
        secureboot: false,
      };
    case "iso-secureboot":
      return {
        flag: "--iso-path",
        url: join(factoryUrl, "image", id, talosVersion, `metal-${arch}-secureboot.iso`),
        secureboot: true,
      };
    case "disk-image":
      return {
        flag: "--disk-image-path",
        url: join(factoryUrl, "image", id, talosVersion, `metal-${arch}.raw.zst`),
        secureboot: false,
      };
    case "pxe":
      return {
        flag: "--ipxe-boot-script",
        url: join(factoryUrl, "pxe", id, talosVersion, `metal-${arch}`),
        secureboot: false,
      };
    default:
      throw new Error(`unknown boot-method preset '${method}'`);
  }
}

/**
 * The installer image reference the stable subcommand would have pinned
 * (applyDefaultSettings in preset.go). dev defaults to the generic installer,
 * which would drop schematic extensions on the first `talosctl upgrade`, so it
 * is always passed explicitly via --install-image.
 */
export function installerImage({
  factoryUrl = DEFAULT_FACTORY_URL,
  schematicId,
  talosVersion,
  secureboot = false,
}) {
  const host = new URL(factoryUrl).host;
  const name = secureboot ? "metal-installer-secureboot" : "metal-installer";

  return `${host}/${name}/${schematicId ?? EMPTY_SCHEMATIC_ID}:${talosVersion}`;
}
