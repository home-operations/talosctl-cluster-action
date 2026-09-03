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

`spec.provider` picks how the nodes run. They are not interchangeable:

|                    | `qemu` (default)                | `docker`                      |
| ------------------ | ------------------------------- | ----------------------------- |
| Nodes are          | VMs with their own kernel       | containers on the host kernel |
| Control planes     | any number                      | always exactly one            |
| Disks, schematics  | yes                             | no                            |
| `talosctl upgrade` | yes                             | no                            |
| Needs              | `/dev/kvm`, passwordless `sudo` | a reachable Docker daemon     |
| Boots in           | minutes                         | seconds                       |

Use `qemu` when the test needs a real kernel, real disks, or a real upgrade; `docker`
when it only needs a Kubernetes API to talk to. Both need `talosctl` **v1.14 or
newer** on `PATH`, and the clusters run Talos 1.14+: the ephemeral profile is written
as the typed config documents that 1.14 configs use, which older nodes reject as
unknown. Repos on older Talos should pin an older release of this action rather than
upgrade.

The docker provider maps onto `talosctl cluster create docker`. The qemu provider is
driven through **`talosctl cluster create dev`**: upstream froze the qemu
subcommand's flag surface and points anyone needing the full set at `dev`, so the
action pins the behavior the qemu subcommand had — the same Image Factory boot media
(as explicit URLs), the same boot-to-maintenance-then-apply-over-the-API lifecycle,
the same schematic-pinned install image — through explicit flags, and layers the
extra capabilities only `dev` exposes on top over time. `dev` makes no
interface-stability promise between talosctl releases; this action's e2e pins the
tested version, and a talosctl release the action has not caught up with may need an
action update. Check the release notes before jumping a talosctl minor.

## Runner setup

The action provisions the cluster and nothing else: it does not install packages or
touch the host's swap. That keeps it working on any distribution and keeps host
mutation in your workflow, where you can see it. Both providers need `talosctl`
**v1.14 or newer** on `PATH`.

### qemu

```yaml
- name: Install talosctl
  run: curl -sL https://talos.dev/install | sh

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
  run: curl -sL https://talos.dev/install | sh

# The nodes are containers on the runner's kernel, so flannel runs against host modules
# it cannot load itself. Without br_netfilter its `bridge-nf-call-iptables` probe fails,
# flannel never writes /run/flannel/subnet.env, and every pod sandbox then fails on the
# missing CNI subnet. cluster create sits waiting on CoreDNS until it times out. Runners
# do not load this module by default.
- name: Load br_netfilter
  run: sudo modprobe br_netfilter
```

### About sudo

The action shells out to `sudo` for exactly one thing: `talosctl cluster create dev`.
That is not a choice. The QEMU provisioner's _first_ preflight check is
`os.Geteuid() != 0`, and its own error recommends `sudo -E`:

> error: please run as root user (CNI, qemu hvf requirement), we recommend running with `sudo -E`

Root is what lets it run the CNI plugins that build the bridge and tap devices, and
write the iptables NAT rules. `-E` matters too: `sudo` resets `HOME`, and cluster state
lives at `$HOME/.talos/clusters`. If the runner is already root, the action skips
`sudo` entirely. The **docker provider never uses sudo**: its provisioner has no root
check at all, it just needs a reachable daemon.

### Caching boot assets

Every qemu run starts by downloading boot media from the Image Factory. talosctl
already keeps those downloads in `~/.talos/cache`, keyed by source URL, and checks
there before downloading; `cache: true` carries that directory across runs through
the GitHub Actions cache, so only the first run per combination touches the Factory:

```yaml
- uses: home-operations/talosctl-cluster-action@v1
  with:
    config: test/e2e/cluster.yaml
    cache: true
```

The cache key covers everything that changes what talosctl downloads: Talos version,
schematic, presets, factory URL, and architecture. A changed spec misses and
downloads fresh; a hit cannot serve wrong bytes, because talosctl's own lookup is by
full URL. Off by default because it spends the repository's cache quota, roughly one
ISO per Talos version and schematic. qemu only: the docker provider pulls a
container image, and no boot assets are involved.

## Config

`metadata.name` is the cluster name. Every field under `spec` maps to exactly one
flag. A field the spec omits is not passed, so it keeps talosctl's own default rather
than one this action invents and then has to track across Talos releases.

Shared by both providers (the flag column shows the qemu provider's dev dialect;
docker keeps its own names for a few of them):

| Field                               | Flag                                              |
| ----------------------------------- | ------------------------------------------------- |
| `metadata.name`                     | `--name`                                          |
| `spec.provider`                     | selects the subcommand                            |
| `spec.profile`                      | (see below)                                       |
| `spec.kubernetes-version`           | `--kubernetes-version`                            |
| `spec.controlplanes.count`          | `--controlplanes` (qemu only)                     |
| `spec.controlplanes.cpus`           | `--cpus` (docker: `--cpus-controlplanes`)         |
| `spec.controlplanes.memory`         | `--memory` (docker: `--memory-controlplanes`)     |
| `spec.workers.count`                | `--workers`                                       |
| `spec.workers.cpus`                 | `--cpus-workers`                                  |
| `spec.workers.memory`               | `--memory-workers`                                |
| `spec.network.cidr`                 | `--cidr` on qemu, `--subnet` on docker            |
| `spec.network.mtu`                  | `--mtu`                                           |
| `spec.config-patches.cluster`       | `--config-patch`                                  |
| `spec.config-patches.controlplanes` | `--config-patch-control-plane` / `-controlplanes` |
| `spec.config-patches.workers`       | `--config-patch-worker` / `-workers`              |

Provider-specific, and an error if it does not match `spec.provider`:

| Field                                   | Becomes                                                    |
| --------------------------------------- | ---------------------------------------------------------- |
| `spec.qemu.talos-version`               | `--talos-version`, and the version in every Factory URL    |
| `spec.qemu.disks`                       | `--disk` + `--extra-disks*` (see Disks)                    |
| `spec.qemu.schematic` / `.schematic-id` | the schematic in the boot media and install-image URLs     |
| `spec.qemu.image-factory.url`           | the base of every Factory URL the action builds            |
| `spec.qemu.image-factory.auth`          | an authenticated pre-download into talosctl's asset cache  |
| `spec.qemu.presets`                     | the boot media flag (`--iso-path`, `--disk-image-path`, …) |
| `spec.docker.image`                     | `--image`                                                  |
| `spec.docker.host-ip`                   | `--host-ip`                                                |
| `spec.docker.exposed-ports`             | `--exposed-ports`                                          |
| `spec.docker.mounts`                    | `--mount` (repeated)                                       |

`spec.network.cidr` is one field because both subcommands set the same underlying
option. `spec.controlplanes.count` is the awkward one: docker never exposes it and
always runs exactly one, so setting anything else there is rejected rather than
silently ignored.

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

| Setting                                                         | Why                                                         |
| --------------------------------------------------------------- | ----------------------------------------------------------- |
| `talos.dashboard.disabled=1`                                    | The console dashboard redraws for nobody to watch.          |
| `talos.auditd.disabled=1`                                       | Kernel audit events nothing reads.                          |
| `mitigations=off`                                               | Side-channel mitigations cost cycles in a throwaway guest.  |
| `init_on_alloc=0`                                               | Zeroing every allocation costs cycles in a throwaway guest. |
| `KubeletConfig` GC + eviction thresholds at zero                | Stops image GC and pod eviction from reading as flakes.     |
| `KubeletConfig` `serializeImagePulls: false` (3 parallel pulls) | Pulls images in parallel, the slowest part of a cold start. |
| `machine.time.disabled`                                         | NTP sync gates etcd, the kubelet and trustd on every boot.  |
| discovery service off                                           | Nothing local needs the public discovery service.           |
| etcd `unsafe-no-fsync`                                          | Durability for I/O, on a cluster about to be deleted.       |
| `KubeAuditPolicyConfig` rules: `None`                           | Talos logs every request to disk by default.                |

`mitigations=off` does not cover page-table isolation, and nothing can make it. Talos
bakes `pti=on` into every image, and since Linux 6.17 an explicit `pti=on` outranks
`mitigations=off`, so PTI stays on even on CPUs carrying no Meltdown bug. Negating it is
not available either: Talos enforces `pti=on` and `slab_nomerge` as KSPP requirements and
a node missing either fails its `systemRequirements` boot phase.

Every run logs exactly what it applied; nothing here happens silently.

`profile: none` applies none of it. Under the **docker provider** the kernel args are
skipped, because they ride in an Image Factory schematic and docker boots a prebuilt
image instead; the kubelet, etcd, and audit settings still apply.

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

The kubelet and audit-policy settings are the 1.14 **typed documents**
(`KubeletConfig`, `KubeAuditPolicyConfig`) rather than v1alpha1 sections, because a
1.14 config that sets the same area in both is rejected; overriding those means
patching the same document kind. Patching `.machine.kubelet` or
`.cluster.apiServer` yourself hits the same rejection. Discovery is not a patch at
all: the qemu provider turns it off at generation time, and the docker provider
deletes the generated `DiscoveryServiceConfig` document; wanting it back on means
adding that document via config-patches.

**The install image** is pinned by the action itself, not by the profile: it always
passes `--install-image` pointing at the Factory installer for the schematic in play
(or the empty one), because the dev subcommand's default is the generic installer,
which would silently drop every schematic extension on the first `talosctl upgrade`.
Because the pin needs a Talos version, and a spec need not name one, the action falls
back to the version `talosctl` would have chosen for itself.

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

Two constraints come from the dev subcommand's count-based disk flags, and violating
either is a validation error rather than a silent reshaping: the **first disk must be
virtio** (and carries no `tag=`/`serial=`), and the **extra disks must all be the same
size**. Extras keep per-disk drivers, tags, and serials.

Disks are always **sparse**: the dev subcommand defaults to preallocating them, which
turns a spec's nominal sizes into real bytes and fills a CI runner's disk before the
first node boots, so the action pins the qemu subcommand's old sparse behavior. And
when a spec names no disks at all, talosctl's default is now a single 6GiB disk per
node — the previous subcommand defaulted to 10GiB plus a 6GiB extra on workers, so a
test that relied on that implicit second disk must declare it.

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
`${CLUSTER_NAME}`, and `${GATEWAY}`. `SCHEMATIC_ID` is why this exists: `talosctl` never sets
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

`GATEWAY` is the host's own address on the cluster network, the first in the CIDR,
and the only address a patch can use to point nodes at something the runner serves.
The classic case is a registry pull-through cache: kubelet image pulls dominate a
cold bring-up, and a mirror on the host makes them cacheable between runs. The
workflow runs the mirror, with its storage under `actions/cache`:

```yaml
- name: Run a registry.k8s.io pull-through cache
  run: |
    docker run -d -p 5001:5000 \
      -e REGISTRY_PROXY_REMOTEURL=https://registry.k8s.io \
      -v "$HOME/.registry-mirror:/var/lib/registry" registry:3
```

and the spec points the nodes at it:

```yaml
spec:
  config-patches:
    cluster:
      - machine:
          registries:
            mirrors:
              registry.k8s.io:
                endpoints: ["http://${GATEWAY}:5001"]
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

The action is the only consumer: it registers the schematic over HTTP, builds the
boot media URLs against the same base, and with `auth` set it downloads the media
itself — HTTP Basic in headers, never in a command line — into the URL-keyed cache
`talosctl` checks before downloading anything. A URL with a path is kept intact, so
`/image-factory` above is registered at `/image-factory/schematics`. The one
host-shaped exception is the install image, which is an OCI reference and therefore
uses the factory URL's host only. Keep `auth` in a GitHub secret rather than
committing it.

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

- **The action waits for the maintenance API** before returning. `cluster create`
  itself returns as soon as the VMs launch, since there is no configuration to wait
  on, so the action polls until every node accepts a connection on port 50000; the
  first `talosctl --insecure` a later step runs does not race the boot.
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
    talos-version: v1.14.0
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
| `cache`      | `false`               | Keep Image Factory boot assets in the GitHub Actions cache.         |

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

**IPv6 is not exposed yet.** The dev subcommand the action now drives does have
`--ipv6`, so this is a planned spec field rather than an upstream limitation. Until
then, for IPv6 inside the cluster, patch `cluster.network.podSubnets` /
`serviceSubnets` under `spec.config-patches`. Setting `spec.network.ipv6` is a
validation error that says so.

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
