import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";
import Ajv from "ajv";
import schema from "../schema/talos-cluster.json" with { type: "json" };
import { providerOf } from "./args.js";

// sockaddr_un.sun_path is 108 bytes on Linux and must be NUL-terminated, so a
// monitor socket path may be at most 107 characters. The provisioner builds it as
// <state>/<name>/<name>-<role>-<n>.monitor, which puts the cluster name in twice.
// Both projects this action was extracted from hit this: a name carrying
// github.run_id pushed the path past the limit and QEMU refused to start, with an
// error that points at the socket rather than at the name.
export const SOCKET_PATH_LIMIT = 107;

// Read off the schema rather than restated, so a new spec field cannot drift out of
// the "you put this at the wrong level" hint below.
const SPEC_KEYS = new Set(Object.keys(schema.properties.spec.properties));

// Provider-specific blocks, likewise read off the schema, for the "that field belongs
// to the other provider" hint.
const PROVIDER_KEYS = {
  qemu: new Set(Object.keys(schema.properties.spec.properties.qemu.properties)),
  docker: new Set(Object.keys(schema.properties.spec.properties.docker.properties)),
};

// Keys that read as obvious but that `cluster create qemu` does not expose. Without
// these, `additionalProperties: false` reports a bare "unknown property" and leaves
// the reader to discover the reason from talosctl's source.
const UNSUPPORTED = {
  "spec.network.ipv6":
    "IPv6 is only available on `talosctl cluster create dev`, which cannot use Image Factory schematics. For IPv6 inside the cluster, patch cluster.network.podSubnets/serviceSubnets under spec.config-patches instead.",
  "spec.network.ipv4":
    "IPv4 is always on for `cluster create qemu`; the toggle exists only on `cluster create dev`.",
  "spec.network.nameservers": "Only available on `talosctl cluster create dev`.",
  "spec.install-image":
    "Not exposed by `cluster create qemu`. Pin machine.install.image through spec.config-patches, using ${SCHEMATIC_ID} to match the schematic this action registers.",
  "spec.registry-mirror":
    "Not exposed by `cluster create qemu`. Patch machine.registries.mirrors under spec.config-patches instead.",
  "spec.config-patches.all":
    "Patches applied to every node go under spec.config-patches.cluster, alongside controlplanes and workers.",
  "spec.controlplanes.disk": "Disks are cluster-wide, not per role. Use spec.qemu.disks.",
  "spec.controlplanes.disks": "Disks are cluster-wide, not per role. Use spec.qemu.disks.",
  "spec.workers.disk": "Disks are cluster-wide, not per role. Use spec.qemu.disks.",
  "spec.workers.disks":
    "Disks are cluster-wide, not per role. Use spec.qemu.disks: the first entry goes to every node, the rest to workers only.",
};

function dottedPath(instancePath, extra) {
  const base = instancePath.replace(/^\//, "").replace(/\//g, ".");
  return [base, extra].filter(Boolean).join(".");
}

function formatError(err) {
  if (err.keyword === "additionalProperties") {
    const key = err.params.additionalProperty;
    const dotted = dottedPath(err.instancePath, key);

    const hint = UNSUPPORTED[dotted];
    if (hint) return `${dotted}: ${hint}`;

    // A field at the document root is almost always one that belongs a level down.
    if (err.instancePath === "") {
      if (key === "name") return `${key}: the cluster name lives at metadata.name`;
      if (SPEC_KEYS.has(key)) return `${key}: belongs under spec`;
    }

    // A provider-specific field written directly under spec, rather than in its
    // provider's block.
    if (err.instancePath === "/spec") {
      for (const [provider, keys] of Object.entries(PROVIDER_KEYS)) {
        if (keys.has(key)) return `spec.${key}: belongs under spec.${provider}`;
      }
    }

    return `${dotted}: unknown field`;
  }

  const where = dottedPath(err.instancePath) || "(root)";

  if (err.keyword === "const")
    return `${where}: must be ${JSON.stringify(err.params.allowedValue)}`;
  if (err.keyword === "enum")
    return `${where}: must be one of ${err.params.allowedValues.join(", ")}`;
  if (err.keyword === "required")
    return `${where}: missing required field '${err.params.missingProperty}'`;
  // Three schema unions use oneOf: patch/schematic (object or "@path"), and the
  // number-or-string cpus and memory. Keying off the keyword alone told someone with
  // a bad cpu fraction to write an "@path".
  if (err.keyword === "oneOf") {
    if (/\.(cpus|memory)$/.test(where)) return `${where}: must be a positive number or a string`;
    return `${where}: must be an inline object or an "@path" string`;
  }

  return `${where}: ${err.message}`;
}

/**
 * Parse and validate a TalosCluster. Throws with every problem listed at once, so
 * a malformed config takes one CI run to fix rather than one run per typo.
 */
export function parseCluster(source) {
  let doc;
  try {
    doc = YAML.parse(source);
  } catch (err) {
    throw new Error(`config is not valid YAML: ${err.message}`);
  }

  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("config must be a YAML mapping");
  }

  // `uri` is declared for editors reading the schema directly; ajv only ships
  // formats via ajv-formats, and without this it warns on every single run. The URL
  // is handed to talosctl, which is the thing that actually has to accept it.
  const ajv = new Ajv({ allErrors: true, strict: false, formats: { uri: true } });
  const validate = ajv.compile(schema);

  if (!validate(doc)) {
    const seen = new Set();
    const lines = validate.errors
      .map(formatError)
      .filter((line) => !seen.has(line) && seen.add(line));
    throw new Error(`invalid TalosCluster:\n  - ${lines.join("\n  - ")}`);
  }

  const problems = [];
  const provider = providerOf(doc);

  // A block for the provider that is not running would otherwise be silently ignored,
  // which reads as the setting having had no effect.
  for (const other of Object.keys(PROVIDER_KEYS)) {
    if (other !== provider && doc.spec?.[other]) {
      problems.push(
        `spec.${other} is set but spec.provider is '${provider}', so none of it would apply`,
      );
    }
  }

  if (doc.spec?.qemu?.schematic && doc.spec?.qemu?.["schematic-id"]) {
    problems.push("spec.qemu.schematic and spec.qemu.schematic-id are mutually exclusive");
  }

  // docker never registers --controlplanes; it always runs exactly one.
  if (provider === "docker" && (doc.spec?.controlplanes?.count ?? 1) !== 1) {
    problems.push(
      "spec.controlplanes.count is only supported by the qemu provider; " +
        "`talosctl cluster create docker` always runs exactly one control plane",
    );
  }

  if (problems.length) {
    throw new Error(`invalid TalosCluster:\n  - ${problems.join("\n  - ")}`);
  }

  return doc;
}

export function loadCluster(file) {
  let source;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`could not read config at ${file}: ${err.message}`);
  }
  return parseCluster(source);
}

/**
 * The longest QEMU monitor socket path this cluster will produce. Checked before
 * anything is provisioned, because the failure otherwise lands minutes later as a
 * QEMU startup error that names the socket and not the cluster name that caused it.
 */
export function monitorSocketPath(
  cluster,
  stateRoot = path.join(os.homedir(), ".talos", "clusters"),
) {
  const name = cluster.metadata.name;
  const spec = cluster.spec ?? {};
  const controlplanes = spec.controlplanes?.count ?? 1;
  const workers = spec.workers?.count ?? 1;

  const nodes = [];
  if (controlplanes > 0) nodes.push(`${name}-controlplane-${controlplanes}`);
  if (workers > 0) nodes.push(`${name}-worker-${workers}`);

  return nodes
    .map((node) => path.join(stateRoot, name, `${node}.monitor`))
    .reduce((longest, p) => (p.length > longest.length ? p : longest), "");
}

export function validateSocketPath(cluster, stateRoot) {
  const socket = monitorSocketPath(cluster, stateRoot);
  const name = cluster.metadata.name;

  if (socket.length > SOCKET_PATH_LIMIT) {
    // The name occurs twice in the path, so each character dropped shortens it by
    // two. Halving the overflow is what makes the advertised budget actually fit.
    const overflow = socket.length - SOCKET_PATH_LIMIT;
    const budget = name.length - Math.ceil(overflow / 2);
    throw new Error(
      `cluster name '${name}' is too long: it produces a ${socket.length}-character QEMU ` +
        `monitor socket path, over the ${SOCKET_PATH_LIMIT}-character UNIX socket limit:\n` +
        `  ${socket}\n` +
        `The name appears twice in that path. Shorten it to at most ${Math.max(budget, 0)} characters.`,
    );
  }

  return socket;
}
