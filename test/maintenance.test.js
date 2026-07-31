import { describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import { waitForMaintenanceNodes } from "../src/maintenance.js";

const listen = (port = 0) =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });

// A port nothing listens on: bind one, note it, release it. Connections to it are
// refused immediately, which is the fast-failure path the poll loop retries.
const freePort = async () => {
  const server = await listen();
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
};

describe("waitForMaintenanceNodes", () => {
  it("resolves once every node answers", async () => {
    const server = await listen();
    try {
      await waitForMaintenanceNodes(["127.0.0.1"], {
        port: server.address().port,
        timeoutMs: 2000,
        intervalMs: 50,
      });
    } finally {
      server.close();
    }
  });

  it("keeps polling until a slow node comes up", async () => {
    const port = await freePort();
    let server;
    const timer = setTimeout(() => {
      listen(port).then((s) => {
        server = s;
      });
    }, 200);
    try {
      await waitForMaintenanceNodes(["127.0.0.1"], { port, timeoutMs: 5000, intervalMs: 50 });
    } finally {
      clearTimeout(timer);
      server?.close();
    }
  });

  it("names the nodes that never answered", async () => {
    const port = await freePort();
    await assert.rejects(
      waitForMaintenanceNodes(["127.0.0.1"], { port, timeoutMs: 300, intervalMs: 50 }),
      /127\.0\.0\.1 did not answer on port \d+ within 1s/,
    );
  });
});
