import { getExecOutput } from "@actions/exec";

/**
 * Run a command and report failure as a value rather than a rejection.
 *
 * `ignoreReturnCode` only covers a non-zero exit; @actions/exec rejects outright when
 * the binary is missing, which is the case every caller here actually cares about
 * (probing for `ip`, `docker`, or a version manager that may not be installed).
 *
 * That distinction is easy to lose: of the four call sites this replaces, two had
 * dropped the catch and would have failed the whole run instead of falling back to
 * the path they were written to take.
 */
export async function tryExec(command, args) {
  return getExecOutput(command, args, { ignoreReturnCode: true, silent: true }).catch(() => ({
    exitCode: 127,
    stdout: "",
    stderr: "",
  }));
}
