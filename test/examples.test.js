import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { loadCluster, validateSocketPath } from "../src/config.js";
import { buildArgs } from "../src/args.js";
import { resolvePatches, substitutions, unresolved } from "../src/patches.js";

const examplesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples");

// Cluster documents only: examples/ also holds the schematic and patch files they
// reference by @path, which are not TalosCluster documents.
const examples = fs
  .readdirSync(examplesDir, { recursive: true })
  .filter((f) => String(f).endsWith(".yaml"))
  .map(String)
  .filter(
    (f) => YAML.parse(fs.readFileSync(path.join(examplesDir, f), "utf8"))?.kind === "TalosCluster",
  );

// The e2e workflow boots these on real hardware, which is slow feedback. Parsing
// them here catches a broken example in the unit suite instead.
describe("examples", () => {
  it("finds the cluster documents, including nested ones", () => {
    assert.ok(examples.length > 0);
    assert.ok(
      examples.some((f) => f.includes(path.sep)),
      "expected at least one example in a subdirectory",
    );
  });

  it("gives every example a distinct cluster name", () => {
    const names = examples.map(
      (f) => YAML.parse(fs.readFileSync(path.join(examplesDir, f), "utf8")).metadata.name,
    );
    assert.equal(new Set(names).size, names.length, `duplicate names in ${names.join(", ")}`);
  });

  for (const example of examples) {
    describe(example, () => {
      const file = path.join(examplesDir, example);
      // Same base directory the action uses: @paths resolve against the config file,
      // so a nested example reaches its own patches rather than the top level's.
      const baseDir = path.dirname(file);
      const cluster = loadCluster(file);

      it("validates and fits the socket path limit", () => {
        validateSocketPath(cluster, "/home/runner/.talos/clusters");
      });

      it("builds arguments with every patch variable resolved", () => {
        const vars = substitutions({ schematicId: "f".repeat(64), cluster });
        const patches = resolvePatches(cluster, { baseDir, vars });

        for (const patch of [...patches.cluster, ...patches.controlplanes, ...patches.workers]) {
          assert.deepEqual(unresolved(patch), [], `unresolved variable in ${example}`);
        }

        const args = buildArgs(cluster, { schematicId: "f".repeat(64), patches });
        assert.equal(args[0], "cluster");
        assert.ok(args.includes("--name"));
      });
    });
  }
});
