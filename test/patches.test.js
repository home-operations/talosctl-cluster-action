import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";

import { resolvePatch, resolvePatches, substitutions, unresolved } from "../src/patches.js";
import { parseCluster } from "../src/config.js";

// Built through parseCluster rather than by hand: a hand-rolled object can drift into
// a shape the schema rejects and keep a test green against config that can never
// occur, which is exactly how a stale spec path survived here undetected.
const cluster = (spec = {}) =>
  parseCluster(
    YAML.stringify({
      apiVersion: "v1alpha1",
      kind: "TalosCluster",
      metadata: { name: "dev" },
      spec: { "kubernetes-version": "v1.34.0", qemu: { "talos-version": "v1.13.6" }, ...spec },
    }),
  );

const vars = substitutions({
  schematicId: "deadbeef",
  cluster: cluster(),
  talosVersion: "v1.13.6",
});

describe("resolvePatch", () => {
  it("serialises an inline patch to JSON", () => {
    const patch = resolvePatch({ machine: { sysctls: { "net.ipv4.ip_forward": "1" } } });
    assert.deepEqual(JSON.parse(patch), {
      machine: { sysctls: { "net.ipv4.ip_forward": "1" } },
    });
  });

  // The reason substitution exists: the schematic id is only known after this action
  // registers the schematic, so a workflow cannot template it in beforehand.
  it("substitutes the resolved schematic id", () => {
    const patch = resolvePatch(
      {
        machine: {
          install: { image: "factory.talos.dev/installer/${SCHEMATIC_ID}:${TALOS_VERSION}" },
        },
      },
      { vars },
    );
    assert.equal(
      JSON.parse(patch).machine.install.image,
      "factory.talos.dev/installer/deadbeef:v1.13.6",
    );
  });

  it("reads an @path relative to the config file and substitutes there too", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "patches-"));
    fs.writeFileSync(
      path.join(dir, "all.yaml"),
      "machine:\n  install:\n    image: factory.talos.dev/installer/${SCHEMATIC_ID}:${TALOS_VERSION}\n",
    );

    const patch = resolvePatch("@all.yaml", { baseDir: dir, vars });
    assert.equal(
      JSON.parse(patch).machine.install.image,
      "factory.talos.dev/installer/deadbeef:v1.13.6",
    );
  });

  it("names the patch when a file is missing", () => {
    assert.throws(
      () => resolvePatch("@nope.yaml", { baseDir: "/tmp" }),
      /could not read config patch @nope\.yaml/,
    );
  });

  it("leaves unknown variables alone so they can be reported", () => {
    const patch = resolvePatch({ a: "${NOPE}" }, { vars });
    assert.deepEqual(unresolved(patch), ["NOPE"]);
  });

  it("reports nothing for a fully resolved patch", () => {
    assert.deepEqual(unresolved(resolvePatch({ a: "${SCHEMATIC_ID}" }, { vars })), []);
  });
});

describe("resolvePatches", () => {
  it("returns an empty list per role when none are given", () => {
    assert.deepEqual(resolvePatches(cluster(), { vars }), {
      cluster: [],
      controlplanes: [],
      workers: [],
    });
  });

  it("tolerates a document with no spec", () => {
    assert.deepEqual(resolvePatches({ metadata: { name: "dev" } }, { vars }), {
      cluster: [],
      controlplanes: [],
      workers: [],
    });
  });

  it("resolves each role independently", () => {
    const patches = resolvePatches(
      cluster({ "config-patches": { cluster: [{ a: 1 }], workers: [{ b: 2 }, { c: 3 }] } }),
      { vars },
    );
    assert.deepEqual(patches.cluster, ['{"a":1}']);
    assert.equal(patches.workers.length, 2);
    assert.deepEqual(patches.controlplanes, []);
  });
});
