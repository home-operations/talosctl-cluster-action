#!/usr/bin/env bash
# Boot an example spec on this machine by invoking the built bundle the same way
# GitHub does: inputs as INPUT_* environment variables. Needs KVM and passwordless
# sudo. Usage: test/e2e.sh [example] (default: minimal)
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

example="${1:-minimal}"
config="examples/${example}.yaml"
[[ -f "$config" ]] || { echo "no such example: $config" >&2; exit 1; }

# Input names keep their dashes, so these cannot be `export`ed and are passed
# through `env` instead. Defaults normally come from action.yaml, which only GitHub
# applies; getBooleanInput rejects an unset value, so every input is spelled out.
workdir="$(mktemp -d)"
inputs=(
    "INPUT_CONFIG=${config}"
    "INPUT_CONFIG-DIR="
    "INPUT_TALOSCTL="
    "INPUT_CLEANUP=true"
    "RUNNER_TEMP=${workdir}"
    "GITHUB_STATE=${workdir}/state"
    "GITHUB_ENV=${workdir}/env"
    "GITHUB_OUTPUT=${workdir}/output"
)
touch "${workdir}/state" "${workdir}/env" "${workdir}/output"

# @actions/core does not write key=value; it writes a heredoc block:
#   <key><<ghadelimiter_<uuid>
#   <value>
#   ghadelimiter_<uuid>
# Parsing it as key=value silently yields empty for every key, which made teardown
# think no cluster existed and leak the VMs, bridge and NAT rules.
# Every value this script reads (paths, a name, a boolean) is single-line, so the
# line after the opening delimiter is the whole value.
value_of() {
    awk -v key="$1" 'index($0, key "<<") == 1 { getline; print; exit }' "$2"
}

teardown() {
    echo "==> tearing down"
    # STATE_sudo too: cleanup.js decides whether to elevate from it, and a qemu
    # cluster's state is root-owned, so destroying it unelevated fails on permissions
    # and cleanup.js downgrades that to a warning.
    env \
        "STATE_cleanup=true" \
        "STATE_cluster-name=$(value_of cluster-name "${workdir}/state")" \
        "STATE_talosctl=$(value_of talosctl "${workdir}/state")" \
        "STATE_sudo=$(value_of sudo "${workdir}/state")" \
        node dist/cleanup.js || true
    rm -rf "${workdir}"
}
trap teardown EXIT

echo "==> creating cluster from ${config}"
env "${inputs[@]}" node dist/index.js

echo "==> outputs"
cat "${workdir}/output"

kubeconfig="$(value_of kubeconfig "${workdir}/output")"
KUBECONFIG="${kubeconfig}" kubectl wait --for=condition=Ready node --all --timeout=5m
KUBECONFIG="${kubeconfig}" kubectl get nodes -o wide
