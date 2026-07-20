import * as core from "@actions/core";
import { exec } from "@actions/exec";

/**
 * Destroy the cluster in the post step.
 *
 * On an ephemeral GitHub-hosted runner this is close to free, since the machine is
 * discarded anyway. It matters on self-hosted runners, where a leaked bridge, NAT
 * rule, or VM outlives the job and breaks the next one.
 */
export async function cleanup() {
  if (core.getState("cleanup") !== "true") return;

  const name = core.getState("cluster-name");
  const talosctl = core.getState("talosctl");

  if (!name || !talosctl) {
    core.info("No cluster was created, nothing to tear down");
    return;
  }

  core.info(`Destroying cluster '${name}'`);

  // Mirrors how the cluster was created: QEMU state is root-owned, docker's is not.
  const destroy = ["cluster", "destroy", "--name", name, "--force"];
  const [command, args] =
    core.getState("sudo") === "true" ? ["sudo", ["-E", talosctl, ...destroy]] : [talosctl, destroy];

  const exitCode = await exec(command, args, { ignoreReturnCode: true });

  // A failed teardown must not fail an otherwise green job; the job's own result is
  // the signal the caller cares about.
  if (exitCode !== 0)
    core.warning(`teardown exited ${exitCode}; some resources may be left behind`);
}

cleanup().catch((err) => core.warning(`teardown failed: ${err.message}`));
