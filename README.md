# talosctl-cluster-action

Provision an ephemeral [Talos Linux](https://talos.dev) cluster on a CI runner from a
declarative config file instead of a wall of flags. Wraps `talosctl cluster create`,
with either the QEMU or the Docker provisioner.

```yaml
- uses: home-operations/talosctl-cluster-action@v1
  with:
    config: test/e2e/cluster.yaml
```

```yaml
# test/e2e/cluster.yaml
apiVersion: v1alpha1
kind: TalosCluster
metadata:
  name: e2e
spec:
  controlplanes:
    count: 1
  workers:
    count: 2
    cpus: 2
    memory: 4GiB
  network:
    cidr: 10.5.0.0/24
  config-patches:
    workers:
      - machine:
          sysctls:
            net.ipv4.ip_forward: "1"
```

Subsequent steps get `KUBECONFIG` and `TALOSCONFIG` in the environment, so `kubectl`
and `talosctl` just work. The cluster is destroyed in the post step.

## Why

Real per-node kernels, real `talosctl upgrade`, real Pod Security enforcement: things
kind cannot give you. The setup is fiddly in the same way every time (QEMU packages,
swap headroom, an Image Factory schematic, sudo, a chown afterwards, a socket path
length limit that is not obvious until it bites), so it lives here once.

## Providers

`spec.provider` picks the `talosctl cluster create` subcommand. They are not
interchangeable, and the differences are talosctl's, not this action's:

|                    | `qemu` (default)                | `docker`                      |
| ------------------ | ------------------------------- | ----------------------------- |
| Nodes are          | VMs with their own kernel       | containers on the host kernel |
| Control planes     | any number                      | always exactly one            |
| Disks, schematics  | yes                             | no                            |
| `talosctl upgrade` | yes                             | no                            |
| Needs              | `/dev/kvm`, passwordless `sudo` | a reachable Docker daemon     |
| Boots in           | minutes                         | seconds                       |

Use `qemu` when the test needs a real kernel, real disks, or a real upgrade; `docker`
when it only needs a Kubernetes API to talk to. Both need `talosctl` **v1.13 or
newer** on `PATH`. v1.12 introduced these subcommands, but the action also emits
`--image-factory-auth` and accepts `:tag=` / `:serial=` disk parameters, neither of
which v1.12 understands; it checks the version and says so rather than letting cobra
report an unknown flag.

## Runner setup

The action provisions the cluster and nothing else: it does not install packages or
touch the host's swap. That keeps it working on any distribution and keeps host
mutation in your workflow, where you can see it. Both providers need `talosctl`
**v1.13 or newer** on `PATH`.

### qemu

```yaml
- name: Install talosctl
  env:
    # renovate: datasource=github-releases depName=siderolabs/talos
    TALOS_VERSION: v1.13.7
  run: |
    curl -sfL "https://github.com/siderolabs/talos/releases/download/${TALOS_VERSION}/talosctl-linux-amd64" -o talosctl
    sudo install -m 0755 talosctl /usr/local/bin/talosctl

- name: Install QEMU
  run: |
    sudo apt-get update
    sudo apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils ovmf

# Runner swap, for the runner's own kernel, not the cluster. The nodes are QEMU VMs,
# so their RAM is ordinary host memory: under an upgrade's transient spike (each node
# unpacking an installer alongside etcd and the API server) the kernel pages a QEMU
# process out to here instead of OOM-killing it, which would read as a flaky test. The
# guest never sees this swap, so it needs no Talos or kubelet config. Its own file, so
# it adds to the runner's existing swap; skip it and a 16GB runner OOMs mid-upgrade.
- name: Enable swap
  run: |
    sudo fallocate -l 8G /mnt/e2e-swapfile
    sudo chmod 600 /mnt/e2e-swapfile
    sudo mkswap /mnt/e2e-swapfile
    sudo swapon /mnt/e2e-swapfile
```

### docker

`talosctl`, plus one kernel module. The daemon is already running on GitHub-hosted
runners and the runner user is already in the `docker` group, so no install is needed.

```yaml
- name: Install talosctl
  env:
    # renovate: datasource=github-releases depName=siderolabs/talos
    TALOS_VERSION: v1.13.7
  run: |
    curl -sfL "https://github.com/siderolabs/talos/releases/download/${TALOS_VERSION}/talosctl-linux-amd64" -o talosctl
    sudo install -m 0755 talosctl /usr/local/bin/talosctl

# The nodes are containers on the runner's kernel, so flannel runs against host modules
# it cannot load itself. Without br_netfilter its `bridge-nf-call-iptables` probe fails,
# flannel never writes /run/flannel/subnet.env, and every pod sandbox then fails on the
# missing CNI subnet. cluster create sits waiting on CoreDNS until it times out. Runners
# do not load this module by default.
- name: Load br_netfilter
  run: sudo modprobe br_netfilter
```

### About sudo

The action shells out to `sudo` for exactly one thing: `talosctl cluster create qemu`.
That is not a choice. The QEMU provisioner's _first_ preflight check is
`os.Geteuid() != 0`, and its own error recommends `sudo -E`:

> error: please run as root user (CNI, qemu hvf requirement), we recommend running with `sudo -E`

Root is what lets it run the CNI plugins that build the bridge and tap devices, and
write the iptables NAT rules. `-E` matters too: `sudo` resets `HOME`, and cluster state
lives at `$HOME/.talos/clusters`. If the runner is already root, the action skips
`sudo` entirely. The **docker provider never uses sudo**: its provisioner has no root
check at all, it just needs a reachable daemon.

## Config

`metadata.name` is the cluster name. Every field under `spec` maps to exactly one
flag. A field the spec omits is not passed, so it keeps talosctl's own default rather
than one this action invents and then has to track across Talos releases.

Shared by both providers:

| Field                               | Flag                                   |
| ----------------------------------- | -------------------------------------- |
| `metadata.name`                     | `--name`                               |
| `spec.provider`                     | selects the subcommand                 |
| `spec.profile`                      | (see below)                            |
| `spec.kubernetes-version`           | `--kubernetes-version`                 |
| `spec.controlplanes.count`          | `--controlplanes` (qemu only)          |
| `spec.controlplanes.cpus`           | `--cpus-controlplanes`                 |
| `spec.controlplanes.memory`         | `--memory-controlplanes`               |
| `spec.workers.count`                | `--workers`                            |
| `spec.workers.cpus`                 | `--cpus-workers`                       |
| `spec.workers.memory`               | `--memory-workers`                     |
| `spec.network.cidr`                 | `--cidr` on qemu, `--subnet` on docker |
| `spec.network.mtu`                  | `--mtu`                                |
| `spec.config-patches.cluster`       | `--config-patch`                       |
| `spec.config-patches.controlplanes` | `--config-patch-controlplanes`         |
| `spec.config-patches.workers`       | `--config-patch-workers`               |

Provider-specific, and an error if it does not match `spec.provider`:

| Field                                   | Flag                   |
| --------------------------------------- | ---------------------- |
| `spec.qemu.talos-version`               | `--talos-version`      |
| `spec.qemu.disks`                       | `--disks`              |
| `spec.qemu.schematic` / `.schematic-id` | `--schematic-id`       |
| `spec.qemu.image-factory.url`           | `--image-factory-url`  |
| `spec.qemu.image-factory.auth`          | `--image-factory-auth` |
| `spec.qemu.presets`                     | `--presets`            |
| `spec.docker.image`                     | `--image`              |
| `spec.docker.host-ip`                   | `--host-ip`            |
| `spec.docker.exposed-ports`             | `--exposed-ports`      |
| `spec.docker.mounts`                    | `--mount` (repeated)   |

`spec.network.cidr` is one field because talosctl's `--cidr` and `--subnet` set the
same underlying option. `spec.controlplanes.count` is the awkward one: docker never
exposes it and always runs exactly one, so setting anything else there is rejected
rather than silently ignored.

`spec` is optional: a document with only `metadata.name` boots a qemu cluster on every
talosctl default.

The document is validated against [a JSON schema](schema/talos-cluster.json)
before anything is provisioned, and unknown fields are an error rather than a silent
no-op. Point your editor at it for completion:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/home-operations/talosctl-cluster-action/main/schema/talos-cluster.json
```

### The ephemeral profile

A cluster that lives for one CI run wants a set of settings that a real cluster does
not. `spec.profile` defaults to `ephemeral` and applies them, so a spec is only what
makes your cluster different:

| Setting                                                           | Why                                                         |
| ----------------------------------------------------------------- | ----------------------------------------------------------- |
| `talos.dashboard.disabled=1`                                      | The console dashboard redraws for nobody to watch.          |
| `talos.auditd.disabled=1`                                         | Kernel audit events nothing reads.                          |
| `mitigations=off`                                                 | Side-channel mitigations cost cycles in a throwaway guest.  |
| `init_on_alloc=0`                                                 | Zeroing every allocation costs cycles in a throwaway guest. |
| kubelet `imageGCHighThresholdPercent` + `evictionHard` at zero    | Stops image GC and pod eviction from reading as flakes.     |
| kubelet `serializeImagePulls: false` (`maxParallelImagePulls: 3`) | Pulls images in parallel, the slowest part of a cold start. |
| etcd `unsafe-no-fsync`                                            | Durability for I/O, on a cluster about to be deleted.       |
| apiserver `auditPolicy: None`                                     | Talos logs every request to disk by default.                |
| `machine.install.image` pinned to the schematic                   | Only when a schematic is used; see below.                   |

Every run logs exactly what it applied; nothing here happens silently.

`profile: none` applies none of it. Under the **docker provider** the kernel args and
the install image pin are skipped, because both ride in an Image Factory schematic and
docker boots a prebuilt image instead; the kubelet, etcd, and audit settings still
apply.

**Overriding one setting** does not mean giving up the rest. The profile's settings
are ordinary config patches emitted _before_ yours, and talosctl applies patches in
order with a deep merge, so your value wins on the key you set and everything else
stays:

```yaml
spec:
  config-patches:
    controlplanes:
      - cluster:
          etcd:
            extraArgs:
              unsafe-no-fsync: "false" # keep the rest of the profile
```

**The install image pin** is the one that is easy to miss. `talosctl` never sets
`machine.install.image`, so nodes boot from your schematic but come up on the generic
installer, and the first `talosctl upgrade` silently drops every extension the
schematic baked in. Whenever a schematic is in play, the profile pins the install
image to the matching Factory image. Because it needs a Talos version, and a spec need
not name one, the action falls back to the version `talosctl` would have chosen for
itself.

**Kernel args are the exception to the override rule.** They live in the Image Factory
schematic rather than in a config patch, so no later patch can override them. They
merge by key instead, and your schematic wins:

```yaml
spec:
  qemu:
    schematic:
      customization:
        extraKernelArgs:
          - mitigations=auto # beats the profile's mitigations=off
```

If you pass a pre-registered `spec.qemu.schematic-id`, the action cannot fold kernel args
into an opaque id; it warns and applies the rest of the profile.

### Versions

`--talos-version` wants a leading `v` and `--kubernetes-version` refuses one. Write
either the way it appears in the release notes; the action normalises both.

### Disks

`spec.qemu.disks` is a cluster-wide list, not a per-role setting. The **first entry goes to
every node** and any after it are attached to **workers only**; that is talosctl's own
semantics.

```yaml
spec:
  qemu:
    disks:
      - virtio:10GiB # every node
      - virtio:20GiB # workers only
```

### Patches and schematics

Both take an inline object or an `"@path"` string, resolved relative to the config
file so a spec can sit next to the files it references:

```yaml
spec:
  qemu:
    schematic: "@schematic.yaml"
  config-patches:
    cluster: ["@patches/registry.yaml"]
    controlplanes:
      - cluster:
          etcd:
            extraArgs:
              unsafe-no-fsync: "true"
```

Patches may reference `${SCHEMATIC_ID}`, `${TALOS_VERSION}`, `${KUBERNETES_VERSION}`,
and `${CLUSTER_NAME}`. `SCHEMATIC_ID` is why this exists: `talosctl` never sets
`machine.install.image`, so nodes come up on the generic installer and lose the
schematic's extensions on the first upgrade. Pinning it needs the schematic id, which
is only known after this action registers the schematic:

```yaml
spec:
  config-patches:
    cluster:
      - machine:
          install:
            image: factory.talos.dev/installer/${SCHEMATIC_ID}:${TALOS_VERSION}
```

### A different Image Factory

`spec.qemu.image-factory` points both consumers at a self-hosted or mirrored factory.
Leave it out and everything uses the official `https://factory.talos.dev/`.

```yaml
spec:
  qemu:
    image-factory:
      url: https://factory.internal/image-factory
      auth: ${FACTORY_CREDENTIALS} # username:password
    schematic:
      customization:
        systemExtensions:
          officialExtensions:
            - siderolabs/drbd
```

Two consumers, because there are two calls: the action registers the schematic over
HTTP itself and then hands the same settings to `talosctl`, which fetches the boot
media. A URL with a path is kept intact, so `/image-factory` above is registered at
`/image-factory/schematics`. `auth` is sent as HTTP Basic on the action's own request
and passed through as `--image-factory-auth`; it is registered as a secret, so the
runner masks it in the command line the log echoes. Keep it in a GitHub secret rather
than committing it, and note it needs talosctl v1.13 or newer.

### Maintenance mode

talosctl's `maintenance` preset ("Skip applying machine configuration and leave the
machines in maintenance mode") passes through like any other, and the action detects
it. That turns the action into a "give me unconfigured Talos nodes on this runner"
primitive for repos that bring their own config management: an e2e workflow for a
cluster template can exercise its real bootstrap flow against freshly booted nodes,
the same way a user would against bare metal.

```yaml
spec:
  controlplanes:
    count: 1
  workers:
    count: 0
  qemu:
    presets: [iso, maintenance]
```

No cluster forms behind the nodes, so the action skips the kubeconfig fetch and
exports neither `KUBECONFIG` nor `TALOSCONFIG`; the `kubeconfig` output is empty.
The hand-off is the `controlplane-ips`, `worker-ips`, and `gateway` outputs: the
nodes answer on the insecure maintenance API, and your tooling takes it from there.

```yaml
- uses: home-operations/talosctl-cluster-action@v1
  id: cluster
  with:
    config: test/e2e/maintenance.yaml

- run: talosctl -n "${IPS%%,*}" get links --insecure
  env:
    IPS: ${{ steps.cluster.outputs.controlplane-ips }}
```

Three details worth knowing:

- **Create returns as soon as the VMs launch**, since there is no configuration to
  wait on. Give the maintenance API a moment to start answering, or poll it.
- **Machine configs are still generated**, with the profile and any
  `spec.config-patches` folded in; they are written to `config-dir` but never
  applied, and the `talosconfig` output points at the matching client config. Apply
  them yourself or ignore them entirely.
- **The post-step teardown is unchanged**: the nodes and their network are destroyed
  at the end of the job as usual.

## Using it in a matrix

Testing several cluster shapes is the common case: one leg per shape, each on its own
runner. Give every leg its own document and keep the bulky parts in shared files
pulled in by `@path`, so a leg is only the handful of lines that actually differ.

A worked set lives in [`examples/matrix/`](examples/matrix):

```text
examples/matrix/
├── 1cp-0w.yaml          # one leg per cluster shape
├── 1cp-1w.yaml
├── 3cp-0w.yaml
└── patches/
    └── registry.yaml    # shared: whatever the profile does not cover
```

A leg is small, because the profile covers the throwaway-cluster settings and
anything else common sits behind an `@path`:

```yaml
apiVersion: v1alpha1
kind: TalosCluster
metadata:
  name: e2e-3cp-0w
spec:
  qemu:
    talos-version: v1.13.6
  controlplanes:
    count: 3
  workers:
    count: 0
  config-patches:
    cluster: ["@patches/registry.yaml"]
```

`@path` resolves relative to the config file, so the leg documents and the files they
share sit in one directory and move together.

```yaml
jobs:
  e2e:
    name: E2E (${{ matrix.leg }})
    runs-on: ubuntu-24.04
    timeout-minutes: 45
    strategy:
      # The legs are independent clusters, so a failure in one should not cost
      # you the signal from the others.
      fail-fast: false
      matrix:
        leg: [1cp-0w, 1cp-1w, 3cp-0w]
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false

      - uses: home-operations/talosctl-cluster-action@v1
        id: cluster
        with:
          config: test/e2e/${{ matrix.leg }}.yaml

      # KUBECONFIG and TALOSCONFIG are already exported, so nothing to wire up.
      - run: kubectl wait --for=condition=Ready node --all --timeout=5m

      - run: talosctl -n "$ENDPOINT" version
        env:
          ENDPOINT: ${{ steps.cluster.outputs.endpoint }}
```

Three things worth knowing before you scale the matrix out:

- **Give each leg a distinct name**, and keep every one of them short. The name is in
  the QEMU monitor socket path twice (see [Notes](#notes)), so `e2e-3cp-0w` is fine
  and anything carrying `github.run_id` is not. The action fails immediately with the
  character budget rather than letting QEMU fail later.
- **One cluster per runner.** What bounds a leg is VM count against runner memory,
  not the number of legs, so adding legs is cheap and adding nodes to a leg is not. A
  16GB runner fits roughly three VMs at the default 2GiB.
- **Overlap the cluster boot with your image build.** Neither depends on the other,
  and booting VMs is mostly waiting. GitHub's
  [parallel steps](https://github.blog/changelog/2026-06-25-actions-steps-can-now-be-run-in-parallel/)
  do this natively: mark both `background: true`, give them ids, then `wait` on both
  before the tests. (Maximum 10 background steps per job.)

```yaml
- uses: home-operations/talosctl-cluster-action@v1
  id: cluster
  background: true
  with:
    config: test/e2e/${{ matrix.leg }}.yaml

- uses: docker/build-push-action@v7
  id: image
  background: true
  with:
    context: .

- wait: [cluster, image]

- run: ./test/run.sh
```

## Inputs

| Input        | Default               | Description                                                         |
| ------------ | --------------------- | ------------------------------------------------------------------- |
| `config`     | `.talos-cluster.yaml` | Path to the `TalosCluster` document.                                |
| `talosctl`   | PATH lookup           | Absolute path to `talosctl`. Only needed when PATH cannot reach it. |
| `config-dir` | `$RUNNER_TEMP/<name>` | Where the kubeconfig, talosconfig, and machine configs are written. |
| `cleanup`    | `true`                | Destroy the cluster in the post step.                               |

## Outputs

| Output             | Description                                               |
| ------------------ | --------------------------------------------------------- |
| `cluster-name`     | Name of the created cluster.                              |
| `provider`         | Provisioner used, qemu or docker.                         |
| `kubeconfig`       | Path to the kubeconfig. Also exported as `$KUBECONFIG`.   |
| `talosconfig`      | Path to the talosconfig. Also exported as `$TALOSCONFIG`. |
| `schematic-id`     | Image Factory schematic the nodes booted from, if any.    |
| `endpoint`         | First control plane address.                              |
| `gateway`          | Host end of the QEMU bridge (first address in the CIDR).  |
| `controlplane-ips` | Comma-separated control plane addresses.                  |
| `worker-ips`       | Comma-separated worker addresses.                         |

Under the [maintenance preset](#maintenance-mode) `kubeconfig` is empty and neither
environment variable is exported; everything else is emitted as usual.

## Notes

**Keep `metadata.name` short.** It appears twice in the QEMU monitor socket path
(`~/.talos/clusters/<name>/<name>-controlplane-N.monitor`), which is capped at 107
characters by the UNIX socket limit. A name carrying `github.run_id` overflows it, and
QEMU's error names the socket rather than the name that caused it. The action checks
this up front and tells you how many characters you have.

**IPv6 is not available.** `talosctl cluster create qemu` has no `--ipv6` flag; it
exists only on `cluster create dev`, which cannot use Image Factory schematics. For
IPv6 inside the cluster, patch `cluster.network.podSubnets` / `serviceSubnets` under
`spec.config-patches`. Setting `spec.network.ipv6` is a validation error that says so.

**One cluster per CIDR per host.** The provisioner puts the bridge on the first
address of the CIDR, so two clusters sharing a CIDR share a bridge and its tap
devices: creating the second disrupts the first, and destroying either tears down the
network under both, silently and after the fact. An ephemeral runner never hits
this; a self-hosted runner or a developer machine already running a cluster hits it
immediately. The action checks the gateway address before provisioning anything and
refuses with the name of the interface already holding it, so give each concurrent
cluster its own `spec.network.cidr`.

**Do not mix providers on one host without care.** A qemu cluster creates
`~/.talos/clusters` as root, because that provisioner needs root; a later docker run
on the same host is not root and cannot write there. The action detects this and says
so, rather than surfacing a bare mkdir failure.

**Cluster state stays at `~/.talos/clusters`,** not under `config-dir`, because the
monitor sockets live beside it and a longer path overflows the limit above.

## Development

```sh
mise run test   # unit tests
mise run build  # rebuild the committed bundle in dist/
mise run e2e    # boot examples/ on a KVM-capable host
```

GitHub executes `dist/`, not `src/`, so the bundle is committed. A pre-commit hook
rebuilds it and CI fails if it is stale.
