import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assertStateWritable, conflictingInterface } from "../src/host.js";
import { tryExec } from "../src/exec.js";

// Real `ip -o -4 addr show` output, including a live QEMU cluster bridge.
const IP_OUTPUT = [
  "1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever",
  "2: eth0    inet 192.168.1.20/24 brd 192.168.1.255 scope global eth0\\       valid_lft forever",
  "3: docker0    inet 172.16.0.1/24 brd 172.16.0.255 scope global docker0\\       valid_lft forever",
  "7: talosbr0    inet 10.5.0.1/24 brd 10.5.0.255 scope global talosbr0\\       valid_lft forever",
].join("\n");

// This is the failure that cost a running cluster during development: a second
// cluster taking the default 10.5.0.0/24 shares the first one's bridge, and
// destroying either tears down the network under both.
describe("network conflict detection", () => {
  it("names the interface already holding the gateway", () => {
    assert.equal(conflictingInterface(IP_OUTPUT, "10.5.0.1"), "talosbr0");
    assert.equal(conflictingInterface(IP_OUTPUT, "172.16.0.1"), "docker0");
  });

  it("passes a gateway nothing has claimed", () => {
    assert.equal(conflictingInterface(IP_OUTPUT, "10.6.0.1"), undefined);
  });

  // 10.5.0.1 must not match a line holding 110.5.0.1 or 10.5.0.10.
  it("does not match an address that merely contains the gateway", () => {
    const output = "9: eth1    inet 10.5.0.10/24 brd 10.5.0.255 scope global eth1";
    assert.equal(conflictingInterface(output, "10.5.0.1"), undefined);
  });

  it("reports nothing for empty output", () => {
    assert.equal(conflictingInterface("", "10.5.0.1"), undefined);
  });
});

// The mixed-provider trap: a qemu run creates the state root as root, and a later
// docker run on the same host cannot write into it.
describe("state directory writability", () => {
  it("passes when the directory does not exist yet", () => {
    assert.doesNotThrow(() => assertStateWritable(path.join(os.tmpdir(), "absent-xyz-9f2")));
  });

  it("passes on a directory the current user owns", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "writable-"));
    assert.doesNotThrow(() => assertStateWritable(dir));
  });

  it("explains the cause when the directory is not writable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "readonly-"));
    fs.chmodSync(dir, 0o500);
    try {
      assert.throws(
        () => assertStateWritable(dir),
        /created by a qemu cluster, which runs as root/,
      );
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });
});

// Every probe in the action goes through this. Its job is turning "the binary is not
// installed" into a value rather than a rejection, which two call sites had lost and
// would have failed the whole run over.
describe("tryExec", () => {
  it("reports a missing binary as a non-zero exit rather than throwing", async () => {
    const result = await tryExec("definitely-not-a-real-binary-xyz", ["--version"]);
    assert.equal(result.exitCode, 127);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });

  it("reports a non-zero exit without throwing", async () => {
    assert.equal((await tryExec("sh", ["-c", "exit 3"])).exitCode, 3);
  });

  it("returns stdout on success", async () => {
    const { exitCode, stdout } = await tryExec("sh", ["-c", "echo hello"]);
    assert.equal(exitCode, 0);
    assert.equal(stdout.trim(), "hello");
  });
});
