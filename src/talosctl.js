import path from "node:path";
import { which } from "@actions/io";

import { tryExec } from "./exec.js";

/**
 * A version manager's shim rather than a real binary. A shim is an absolute path,
 * so it survives sudo's PATH reset, but it re-execs through the manager, which
 * needs environment that sudo strips.
 */
export const isShim = (binary) => path.dirname(binary).split(path.sep).includes("shims");

/** Ask a version manager for the binary its shim points at. */
async function unwrapShim(manager) {
  const { exitCode, stdout } = await tryExec(manager, ["which", "talosctl"]);

  return exitCode === 0 && stdout.trim() ? stdout.trim() : undefined;
}

/**
 * Absolute path to the talosctl binary.
 *
 * PATH is the source of truth: any of the usual ways of installing talosctl leaves
 * it there, and this action does not care which was used. The version-manager step
 * is a fallback for shims only, never a requirement.
 */
export async function resolveTalosctl(override) {
  if (override) return override;

  const found = await which("talosctl", false);

  if (found && isShim(found)) {
    for (const manager of ["mise", "asdf"]) {
      const real = await unwrapShim(manager);
      if (real) return real;
    }
  }

  if (found) return found;

  throw new Error(
    "could not find talosctl on PATH. Install it before this action, or set the `talosctl` " +
      "input to an absolute path.",
  );
}

/**
 * The version talosctl would default `--talos-version` to, which is its own build
 * tag. Needed when a spec omits the version but the profile still has to pin an
 * install image to the matching Talos release.
 */
/**
 * The Tag field out of `talosctl version --client` output.
 *
 * Not \s*, which spans newlines: a talosctl built without version ldflags prints an
 * empty Tag, and \s* would then capture the next line's first token ("SHA:") and pin
 * an install image to it.
 */
export function parseVersionOutput(stdout) {
  return stdout.match(/Tag:[^\S\n]*(\S+)/)?.[1];
}

async function defaultTalosVersion(binary) {
  const { exitCode, stdout } = await tryExec(binary, ["version", "--client"]);
  if (exitCode !== 0) return undefined;

  return parseVersionOutput(stdout);
}

// This action targets Talos 1.14: the ephemeral profile is written as the typed
// config documents (KubeletConfig, KubeAuditPolicyConfig) that 1.14-contract
// configs generate, and a pre-1.14 node rejects those kinds as unknown. Repos on
// older Talos should pin an older action release rather than upgrade.
export const MINIMUM_TALOS_VERSION = "1.14.0";

const parseVersion = (tag) =>
  (tag ?? "")
    .replace(/^v/, "")
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10));

/** Whether `version` is at least `minimum`, both as dotted strings. */
export function meetsMinimum(version, minimum = MINIMUM_TALOS_VERSION) {
  const actual = parseVersion(version);

  // Unparseable, so there is nothing to compare; a dev build should not be blocked.
  if (actual.length < 2 || actual.some(Number.isNaN)) return true;

  const required = parseVersion(minimum);

  for (let i = 0; i < required.length; i += 1) {
    const a = actual[i] ?? 0;
    const r = required[i] ?? 0;
    if (a !== r) return a > r;
  }

  return true;
}

export async function assertUsableVersion(binary) {
  const version = await defaultTalosVersion(binary);

  // Could not read a version, so let the provisioner speak for itself rather than
  // blocking on a string this action failed to parse.
  if (!version) return undefined;

  if (!meetsMinimum(version)) {
    throw new Error(
      `talosctl ${version} is too old: this action targets Talos v${MINIMUM_TALOS_VERSION} and ` +
        "newer, whose configs use the typed multi-documents the ephemeral profile is written " +
        "as. Pin an older release of this action for older Talos.",
    );
  }

  return version;
}

/**
 * The same floor for the Talos version the nodes will run: the profile's typed
 * documents are unknown kinds to a pre-1.14 node, which rejects the whole config.
 */
export function assertSupportedTargetVersion(talosVersion) {
  if (!meetsMinimum(talosVersion)) {
    throw new Error(
      `spec.qemu.talos-version ${talosVersion} is below v${MINIMUM_TALOS_VERSION}: this action ` +
        "targets Talos 1.14+, whose configs carry the typed documents the ephemeral profile " +
        "emits. Pin an older release of this action for older Talos.",
    );
  }
}
