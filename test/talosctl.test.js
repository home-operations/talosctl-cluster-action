import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isShim, resolveTalosctl } from "../src/talosctl.js";

describe("resolveTalosctl", () => {
  it("honours an explicit override without probing anything", async () => {
    assert.equal(await resolveTalosctl("/opt/talos/talosctl"), "/opt/talos/talosctl");
  });
});

// A version manager must never be a requirement: a plain binary on PATH is the
// normal case, and only a shim needs unwrapping.
describe("isShim", () => {
  it("treats an ordinary PATH binary as final", () => {
    for (const binary of ["/usr/local/bin/talosctl", "/usr/bin/talosctl", "/opt/bin/talosctl"]) {
      assert.equal(isShim(binary), false, binary);
    }
  });

  it("recognises version-manager shims", () => {
    for (const binary of [
      "/home/runner/.local/share/mise/shims/talosctl",
      "/home/runner/.asdf/shims/talosctl",
    ]) {
      assert.equal(isShim(binary), true, binary);
    }
  });

  it('does not treat a path merely containing "shims" as a shim', () => {
    assert.equal(isShim("/opt/shimsurvey/bin/talosctl"), false);
  });
});
