#!/usr/bin/env bash
# Cursor cloud agent install step: everything a splitch agent needs to run
# `pnpm verify:push` and the git hooks it will hit on every commit and push.
#
# Cursor runs this when it creates a Build and again on machine boot after the
# checkout is refreshed, so every step is idempotent and skips work that is
# already in the snapshot.
#
# Versions are read out of the CI definitions rather than copied. A fourth copy
# of each pin would drift, and an agent that passes a gate CI then fails (or the
# reverse) is worse than no agent. A floating installer would do the same thing
# from the other direction: an upstream publish could hand the agent a different
# toolchain with no repo change. scripts/cursor-install-pins.test.mjs runs the
# `pin` expressions below against the real files so a reshaped CI definition
# fails in `pnpm test:scripts` instead of in the next Cursor Build.
set -euo pipefail

cd "$(dirname "$0")/.."

# Exactly one match, or stop. `head -n1` on a disagreeing set would install a
# version nothing else in the repo uses.
pin() {
  local file="$1" expression="$2" label="$3" values count
  values="$(sed -n "$expression" "$file" | sort -u)"
  count="$(printf '%s' "$values" | grep -c . || true)"
  if [ "$count" -ne 1 ]; then
    echo "install: expected exactly one $label pin in $file, found $count" >&2
    exit 1
  fi
  printf '%s' "$values"
}

NODE_VERSION="$(pin .github/workflows/ci.yml 's/^ *node-version: *\([0-9][0-9.]*\) *$/\1/p' Node)"
GITLEAKS_VERSION="$(pin .github/workflows/ci.yml 's/^ *GITLEAKS_VERSION: *\([0-9][0-9.]*\) *$/\1/p' gitleaks)"
TINYBIRD_CLI_VERSION="$(pin .github/actions/setup-tinybird-cli/action.yml 's/^ *default: *\([0-9][0-9.]*\) *$/\1/p' "Tinybird CLI")"
PNPM_VERSION="$(pin package.json 's/^ *"packageManager": *"pnpm@\([0-9][0-9.]*\)".*/\1/p' pnpm)"

case "$(uname -m)" in
  x86_64) ARCH=x64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *)
    echo "install: unsupported architecture $(uname -m)" >&2
    exit 1
    ;;
esac

########################################################
# DOCKER
########################################################

# `pnpm verify:push` runs tinybird:local, which drives a tinybird-local
# container, so an agent without Docker cannot push. The managed Cloud Agent
# base image no longer ships the client or the daemon. Install docker-ce here
# with fuse-overlayfs plus iptables-legacy so docker-in-docker can start, using
# Cursor's documented noble pins so an upstream publish cannot hand the agent
# a different engine with no repo change.
# https://cursor.com/docs/cloud-agent/setup#running-docker
DOCKER_VERSION="28.5.2"
DOCKER_CE_PIN="5:${DOCKER_VERSION}-1~ubuntu.24.04~noble"

docker_client_version() {
  docker --version 2>/dev/null | sed -n 's/^Docker version \([0-9][0-9.]*\).*/\1/p'
}

if [ "$(docker_client_version)" != "$DOCKER_VERSION" ]; then
  # Sourced for VERSION_CODENAME only. The rest of the script does not depend
  # on distro fields, so keep the leak local to this block.
  # shellcheck disable=SC1091
  . /etc/os-release
  if [ "${VERSION_CODENAME}" != "noble" ]; then
    echo "install: docker-ce pin is for Ubuntu noble, found ${VERSION_CODENAME:-unknown}" >&2
    exit 1
  fi

  sudo install -m 0755 -d /etc/apt/keyrings
  if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
    curl -fsSL --retry 3 --retry-delay 5 --max-time 60 \
      https://download.docker.com/linux/ubuntu/gpg |
      sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    sudo chmod a+r /etc/apt/keyrings/docker.gpg
  fi

  if [ ! -f /etc/apt/sources.list.d/docker.list ]; then
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" |
      sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  fi

  sudo apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    "docker-ce=${DOCKER_CE_PIN}" \
    "docker-ce-cli=${DOCKER_CE_PIN}" \
    containerd.io \
    docker-buildx-plugin \
    docker-compose-plugin \
    fuse-overlayfs \
    iptables

  sudo mkdir -p /etc/docker
  if [ ! -f /etc/docker/daemon.json ]; then
    printf '%s\n' '{' '  "storage-driver": "fuse-overlayfs"' '}' |
      sudo tee /etc/docker/daemon.json >/dev/null
  fi

  sudo update-alternatives --set iptables /usr/sbin/iptables-legacy
  sudo update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "install: docker is not on PATH after installing docker-ce" >&2
  exit 1
fi

# tinybird:local reaches the daemon socket as this user, not through sudo, and
# the socket is root:docker 0660. Membership lands in /etc/group inside the
# snapshot, so the shells Cursor starts after boot pick it up; .cursor/start.sh
# proves it against a live daemon. docker-ce creates the group; -f covers a
# partial install that somehow left the binary without it.
sudo groupadd -f docker
sudo usermod -aG docker "$(id -un)"

########################################################
# NODE + PNPM
########################################################

# Installed from the official tarball into /usr/local rather than through a
# version manager: /usr/local/bin is already on PATH for the agent's shells, the
# start command and the terminals, so nothing has to source a shell profile.
if [ "$(node --version 2>/dev/null || true)" != "v${NODE_VERSION}" ]; then
  tarball="node-v${NODE_VERSION}-linux-${ARCH}.tar.xz"
  tmp="$(mktemp -d)"
  curl -fsSL --max-time 300 -o "${tmp}/${tarball}" \
    "https://nodejs.org/dist/v${NODE_VERSION}/${tarball}"
  curl -fsSL --max-time 120 -o "${tmp}/SHASUMS256.txt" \
    "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
  (cd "$tmp" && grep " ${tarball}\$" SHASUMS256.txt | sha256sum -c -)
  # Untarring over the previous release would leave its orphans behind, and a
  # stale npm tree or stale node headers outlive the version they came from.
  sudo rm -rf /usr/local/lib/node_modules /usr/local/include/node
  sudo tar -xJf "${tmp}/${tarball}" -C /usr/local --strip-components=1 \
    --exclude CHANGELOG.md --exclude LICENSE --exclude README.md
  rm -rf "$tmp"
fi

# `corepack prepare --activate` with no argument reads the packageManager field
# in package.json, so the pnpm pin stays owned by the repo. The prompt opt-out
# is written to a profile drop-in because corepack will also want to download a
# new pnpm from the agent's own shells the first time someone bumps that field.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
printf 'export COREPACK_ENABLE_DOWNLOAD_PROMPT=0\n' |
  sudo tee /etc/profile.d/corepack.sh >/dev/null
sudo corepack enable --install-directory /usr/local/bin
corepack prepare --activate

########################################################
# GITLEAKS
########################################################

# The pre-commit hook runs `pnpm secrets:staged` and pre-push runs
# `pnpm secrets:range`; without gitleaks on PATH the agent cannot commit.
if [ "$(gitleaks version 2>/dev/null || true)" != "$GITLEAKS_VERSION" ]; then
  asset="gitleaks_${GITLEAKS_VERSION}_linux_${ARCH}.tar.gz"
  checksums="gitleaks_${GITLEAKS_VERSION}_checksums.txt"
  base="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}"
  tmp="$(mktemp -d)"
  curl -fsSL --max-time 120 -o "${tmp}/${asset}" "${base}/${asset}"
  curl -fsSL --max-time 120 -o "${tmp}/${checksums}" "${base}/${checksums}"
  (cd "$tmp" && grep " ${asset}\$" "$checksums" | sha256sum -c -)
  tar -xzf "${tmp}/${asset}" -C "$tmp" gitleaks
  sudo install -m 0755 "${tmp}/gitleaks" /usr/local/bin/gitleaks
  rm -rf "$tmp"
fi

########################################################
# TINYBIRD CLI
########################################################

# Same shape as .github/actions/setup-tinybird-cli: uv is the installer rather
# than the thing under test, so it floats, while `tb` itself is pinned. Both are
# symlinked into /usr/local/bin because ~/.local/bin only reaches shells that
# source ~/.profile, and the agent's do not.
export PATH="${HOME}/.local/bin:${PATH}"
if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf --max-time 120 https://astral.sh/uv/install.sh | sh
  sudo ln -sf "${HOME}/.local/bin/uv" /usr/local/bin/uv
fi
if [ "$(tb --no-version-warning --version 2>/dev/null || true)" != "$TINYBIRD_CLI_VERSION" ]; then
  uv tool install --force --python 3.11 "tinybird==${TINYBIRD_CLI_VERSION}"
  sudo ln -sf "${HOME}/.local/bin/tb" /usr/local/bin/tb
fi

########################################################
# WORKSPACE
########################################################

pnpm install --frozen-lockfile

# `--with-deps` shells out to apt, so it runs once when the browser is absent
# rather than on every boot, where a held dpkg lock would strand the machine.
# Chromium is for the Control Panel e2e; verify:push does not need it.
if [ -d "${HOME}/.cache/ms-playwright" ]; then
  pnpm exec playwright install chromium
else
  pnpm exec playwright install --with-deps chromium
fi

########################################################
# PROOF
########################################################

# Fail here, in the Build, rather than three minutes into an agent run. Each
# check is a real comparison against the pin: printing `$(tool --version)` into
# an echo would swallow both a broken binary and an off-pin one, because a
# failing command substitution does not trip `set -e`.
require_version() {
  local label="$1" expected="$2" actual
  shift 2
  if ! actual="$("$@" 2>/dev/null)"; then
    echo "install: ${label} did not run after install" >&2
    exit 1
  fi
  case "$actual" in
    *"$expected"*) printf '%-10s %s\n' "$label" "$actual" ;;
    *)
      echo "install: ${label} reports '${actual}', expected ${expected}" >&2
      exit 1
      ;;
  esac
}

require_version node "v${NODE_VERSION}" node --version
require_version pnpm "$PNPM_VERSION" pnpm --version
require_version gitleaks "$GITLEAKS_VERSION" gitleaks version
require_version tinybird "$TINYBIRD_CLI_VERSION" tb --no-version-warning --version
require_version docker "$DOCKER_VERSION" docker --version
