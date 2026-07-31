import net from "node:net";

/** The Talos machine API port, where maintenance mode answers unauthenticated. */
export const MAINTENANCE_PORT = 50000;

const attempt = (host, port, timeoutMs) =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (up) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until every node accepts a TCP connection on the maintenance API port.
 *
 * Under the maintenance preset `cluster create` returns as soon as the VMs launch,
 * since there is no machine configuration to wait on, so the caller's first
 * `talosctl --insecure` races the boot. A TCP connect is the whole check: the point
 * is that the API is answering, not what it says.
 */
export async function waitForMaintenanceNodes(
  nodes,
  {
    port = MAINTENANCE_PORT,
    timeoutMs = 300_000,
    intervalMs = 2_000,
    connectTimeoutMs = 2_000,
  } = {},
) {
  const deadline = Date.now() + timeoutMs;

  const wait = async (node) => {
    for (;;) {
      if (await attempt(node, port, connectTimeoutMs)) return undefined;
      if (Date.now() >= deadline) return node;
      await sleep(intervalMs);
    }
  };

  const down = (await Promise.all(nodes.map(wait))).filter(Boolean);

  if (down.length) {
    throw new Error(
      `the maintenance API on ${down.join(", ")} did not answer on port ${port} within ` +
        `${Math.ceil(timeoutMs / 1000)}s`,
    );
  }
}
