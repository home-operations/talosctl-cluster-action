import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

/**
 * Variables a patch may reference. SCHEMATIC_ID is the reason this exists: pinning
 * machine.install.image to the Factory installer requires the schematic id, and
 * that id is only known after this action registers the schematic. A workflow
 * cannot template it in beforehand.
 */
export function substitutions({ schematicId, cluster, talosVersion }) {
  const spec = cluster.spec ?? {};
  return {
    SCHEMATIC_ID: schematicId ?? "",
    // Resolved by the caller: the spec's own version if it names one, otherwise the
    // version talosctl would pick for itself, and always v-prefixed so the pinned
    // install image points at a tag the Image Factory actually publishes.
    TALOS_VERSION: talosVersion ?? "",
    KUBERNETES_VERSION: spec["kubernetes-version"] ?? "",
    CLUSTER_NAME: cluster.metadata.name,
  };
}

const substitute = (text, vars) =>
  text.replace(/\$\{([A-Z_]+)\}/g, (match, name) => (name in vars ? vars[name] : match));

/** Any ${VAR} the substitution table did not know about. */
export function unresolved(text) {
  return [...text.matchAll(/\$\{([A-Z_]+)\}/g)].map((m) => m[1]);
}

/**
 * Normalise one patch to a JSON string suitable for --config-patch.
 *
 * Patches are passed inline rather than written to temp files: the flags are
 * StringArray, so pflag does not split on the commas that JSON is full of, and
 * inline values keep substitution and file loading on one path.
 *
 * "@path" is resolved relative to the config file, so a spec can sit next to the
 * patches it references.
 */
export function resolvePatch(patch, { baseDir = process.cwd(), vars = {} } = {}) {
  let value = patch;

  if (typeof patch === "string") {
    const file = path.resolve(baseDir, patch.slice(1));
    let source;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch (err) {
      throw new Error(`could not read config patch ${patch}: ${err.message}`);
    }
    try {
      value = YAML.parse(substitute(source, vars));
    } catch (err) {
      throw new Error(`config patch ${patch} is not valid YAML: ${err.message}`);
    }
    return JSON.stringify(value);
  }

  return substitute(JSON.stringify(value), vars);
}

/** The roles talosctl has a --config-patch flag for. */
export const ROLES = ["cluster", "controlplanes", "workers"];

/** An empty patch set, so no caller has to restate the role list to build one. */
export const emptyPatches = () => Object.fromEntries(ROLES.map((role) => [role, []]));

export function resolvePatches(cluster, options) {
  const byRole = cluster.spec?.["config-patches"] ?? {};
  const resolve = (list) => (list ?? []).map((patch) => resolvePatch(patch, options));

  return Object.fromEntries(ROLES.map((role) => [role, resolve(byRole[role])]));
}

/**
 * Resolve the profile's patches, which carry a name alongside the patch so a run can
 * report what it applied. They take the same ${VAR} substitution path as the
 * caller's rather than a parallel one.
 */
export function resolveProfilePatches(byRole, options) {
  return Object.fromEntries(
    ROLES.map((role) => [
      role,
      (byRole[role] ?? []).map((entry) => resolvePatch(entry.patch, options)),
    ]),
  );
}

/**
 * Concatenate patch sets per role, earliest set first.
 *
 * Order is the whole override mechanism: talosctl applies patches in sequence with a
 * deep merge, so a later set wins on the keys it sets and leaves the rest intact.
 * Profile patches therefore go in ahead of the caller's.
 */
export function concatPatches(...sets) {
  return Object.fromEntries(ROLES.map((role) => [role, sets.flatMap((set) => set?.[role] ?? [])]));
}
