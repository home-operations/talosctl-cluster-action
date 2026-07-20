import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export const DEFAULT_FACTORY_URL = "https://factory.talos.dev/";

/**
 * Register a schematic with the Image Factory and return its id.
 *
 * The id is a content hash, so re-registering an unchanged schematic is idempotent
 * and safe to do on every run.
 */
export async function registerSchematic(body, { factoryUrl = DEFAULT_FACTORY_URL, auth } = {}) {
  // A relative reference resolves against the base's *directory*, so a factory URL
  // with a path but no trailing slash would silently lose that path and POST to the
  // host root, while talosctl, given the same string, targets it correctly.
  const endpoint = new URL("schematics", factoryUrl.endsWith("/") ? factoryUrl : `${factoryUrl}/`);

  // talosctl gets the same credentials via --image-factory-auth, but this POST is the
  // action's own call and has to authenticate itself; a private factory 401s here,
  // before talosctl is ever reached.
  const headers = { "content-type": "application/yaml" };
  if (auth) headers.authorization = `Basic ${Buffer.from(auth).toString("base64")}`;

  let response;
  try {
    response = await fetch(endpoint, { method: "POST", headers, body });
  } catch (err) {
    throw new Error(`could not reach the Image Factory at ${endpoint}: ${err.message}`);
  }

  if (!response.ok) {
    throw new Error(
      `Image Factory rejected the schematic (${response.status} ${response.statusText}): ${await response.text()}`,
    );
  }

  const { id } = await response.json();
  if (!id) throw new Error("Image Factory returned no schematic id");

  return id;
}

/** The schematic as an object, from an inline mapping or an "@path". */
export function schematicDocument(cluster, baseDir = process.cwd()) {
  const schematic = cluster.spec?.qemu?.schematic;
  if (schematic === undefined) return undefined;

  if (typeof schematic === "string") {
    const file = path.resolve(baseDir, schematic.slice(1));
    let source;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch (err) {
      throw new Error(`could not read schematic ${schematic}: ${err.message}`);
    }
    try {
      return YAML.parse(source);
    } catch (err) {
      throw new Error(`schematic ${schematic} is not valid YAML: ${err.message}`);
    }
  }

  return schematic;
}

const argKey = (arg) => arg.split("=")[0];

/**
 * Add kernel args to a schematic, keeping any the schematic already sets.
 *
 * Kernel args live in the schematic rather than in a machine config patch, so unlike
 * the profile's patches they cannot be overridden by a later --config-patch. Matching
 * on the key before "=" gives the same override story: writing
 * `mitigations=auto` in the schematic beats the profile's `mitigations=off`.
 */
export function withKernelArgs(schematic, args) {
  if (!args.length) return schematic;

  const existing = schematic?.customization?.extraKernelArgs ?? [];
  const taken = new Set(existing.map(argKey));
  const added = args.filter((arg) => !taken.has(argKey(arg)));

  if (!added.length) return schematic;

  return {
    ...schematic,
    customization: {
      ...schematic?.customization,
      extraKernelArgs: [...added, ...existing],
    },
  };
}

export const toYaml = (document) => YAML.stringify(document);
