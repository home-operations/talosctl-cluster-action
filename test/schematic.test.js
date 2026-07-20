import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  schematicDocument,
  withKernelArgs,
  toYaml,
  registerSchematic,
  DEFAULT_FACTORY_URL,
} from "../src/schematic.js";
import { parseCluster } from "../src/config.js";
import { profileKernelArgs } from "../src/profile.js";
import { buildArgs } from "../src/args.js";

const envelope = "apiVersion: v1alpha1\nkind: TalosCluster\nmetadata:\n  name: dev\n";

// This whole file exists because the path had no coverage at all, and a stale read of
// spec.schematic (post-nesting it lives at spec.qemu.schematic) silently discarded
// every user schematic while still producing a non-empty schematic id from the
// profile's kernel args. Nothing caught it.
describe("schematicDocument", () => {
  it("reads the schematic from spec.qemu", () => {
    const cluster = parseCluster(
      `${envelope}spec:\n  qemu:\n    schematic:\n      customization:\n        extraKernelArgs: [console=ttyS0]\n`,
    );
    assert.deepEqual(schematicDocument(cluster).customization.extraKernelArgs, ["console=ttyS0"]);
  });

  it("keeps system extensions the spec asks for", () => {
    const cluster = parseCluster(
      `${envelope}spec:\n  qemu:\n    schematic:\n      customization:\n        systemExtensions:\n          officialExtensions: [siderolabs/drbd]\n`,
    );
    const document = withKernelArgs(schematicDocument(cluster), profileKernelArgs("ephemeral"));
    assert.deepEqual(document.customization.systemExtensions.officialExtensions, [
      "siderolabs/drbd",
    ]);
    assert.match(toYaml(document), /drbd/);
  });

  it("returns nothing when the spec declares no schematic", () => {
    assert.equal(
      schematicDocument(parseCluster(`${envelope}spec:\n  workers:\n    count: 0\n`)),
      undefined,
    );
  });

  it("reads an @path relative to the config file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schematic-"));
    fs.writeFileSync(
      path.join(dir, "s.yaml"),
      "customization:\n  systemExtensions:\n    officialExtensions:\n      - siderolabs/drbd\n",
    );

    const cluster = parseCluster(`${envelope}spec:\n  qemu:\n    schematic: "@s.yaml"\n`);
    assert.deepEqual(
      schematicDocument(cluster, dir).customization.systemExtensions.officialExtensions,
      ["siderolabs/drbd"],
    );
  });

  it("names the file when an @path schematic is missing", () => {
    const cluster = parseCluster(`${envelope}spec:\n  qemu:\n    schematic: "@nope.yaml"\n`);
    assert.throws(() => schematicDocument(cluster, "/tmp"), /could not read schematic @nope\.yaml/);
  });
});

// A private factory has to be honoured by both callers: talosctl gets the flag, and
// the action registers the schematic over HTTP itself. Only the second one is easy to
// get wrong, since a relative reference silently drops a base path.
describe("image factory url", () => {
  // The endpoint is reported in the unreachable-host error, which is the only seam
  // that does not require a fetch stub in production code.
  const endpointFor = async (factoryUrl) => {
    try {
      await registerSchematic("customization: {}", { factoryUrl });
    } catch (err) {
      // "...Factory at <endpoint>: <cause>", so the first ": " ends the URL; its own
      // colons are always followed by a slash.
      return err.message.match(/ at (\S+?): /)?.[1];
    }
    return undefined;
  };

  it("defaults to the official factory", () => {
    assert.equal(DEFAULT_FACTORY_URL, "https://factory.talos.dev/");
  });

  it("omits the flag when the spec names no factory, leaving talosctl's default", () => {
    assert.ok(!buildArgs({ metadata: { name: "x" }, spec: {} }).includes("--image-factory-url"));
  });

  it("passes a custom factory to talosctl", () => {
    const cluster = {
      metadata: { name: "x" },
      spec: { qemu: { "image-factory": { url: "https://ci.internal/image-factory" } } },
    };
    const args = buildArgs(cluster);
    assert.equal(
      args[args.indexOf("--image-factory-url") + 1],
      "https://ci.internal/image-factory",
    );
  });

  it("keeps a base path when building its own endpoint", async () => {
    assert.equal(
      await endpointFor("https://unreachable.invalid/image-factory"),
      "https://unreachable.invalid/image-factory/schematics",
    );
    assert.equal(
      await endpointFor("https://unreachable.invalid/"),
      "https://unreachable.invalid/schematics",
    );
  });
});
