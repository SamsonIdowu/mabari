#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# Installs Mabari on macOS or Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/SamsonIdowu/mabari/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/SamsonIdowu/mabari/main/install.sh | sh -s -- --docker
#
# Without --docker it puts the `mabari` binary in ~/.local/bin: the release build for this system
# when one is published, otherwise one built from source (which needs git, Go 1.27+, Node 22+).
# With --docker it runs Mabari in Docker with Compose, built from source.
#
# Options:
#   --docker          run in Docker instead of installing the binary
#   --bin DIR         where to put the binary (default: ~/.local/bin)
#   --src DIR         where to keep the source (default: ~/.mabari/src)
#   --ref REF         branch or tag to build (default: main)
#   --from-source     build from source even when a release exists
#   --service         start Mabari at every login afterwards (mabari service install)
set -eu

REPO="SamsonIdowu/mabari"
URL="https://github.com/${REPO}"
BIN_DIR="${HOME}/.local/bin"
SRC_DIR="${HOME}/.mabari/src"
REF="main"
DOCKER=0
FROM_SOURCE=0
SERVICE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --docker) DOCKER=1 ;;
    --bin) BIN_DIR="$2"; shift ;;
    --src) SRC_DIR="$2"; shift ;;
    --ref) REF="$2"; shift ;;
    --from-source) FROM_SOURCE=1 ;;
    --service) SERVICE=1 ;;
    -h|--help) sed -n '2,22p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# major.minor of a version string such as "go1.27.1" or "v22.11.0", as a comparable number.
version_number() {
  echo "$1" | sed -E 's/^[^0-9]*([0-9]+)\.([0-9]+).*/\1 \2/' | awk '{ printf "%d", $1 * 1000 + $2 }'
}

fetch_source() {
  have git || fail "git is needed. Install it, then run this again."
  if [ -d "${SRC_DIR}/.git" ]; then
    say "Updating the source in ${SRC_DIR}"
    git -C "${SRC_DIR}" fetch --depth 1 origin "${REF}"
    git -C "${SRC_DIR}" checkout -q FETCH_HEAD
  else
    say "Downloading the source to ${SRC_DIR}"
    mkdir -p "$(dirname "${SRC_DIR}")"
    git clone --depth 1 --branch "${REF}" "${URL}.git" "${SRC_DIR}"
  fi
}

install_docker() {
  have docker || fail "Docker is needed. Install Docker Desktop or Docker Engine, then run this again."
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is needed (the 'docker compose' command)."
  fetch_source
  key="${SRC_DIR}/deploy/docker/mabari_master_key"
  if [ ! -f "${key}" ]; then
    say "Making the master key that seals Mabari's stored keys"
    (umask 077 && head -c 32 /dev/urandom | base64 > "${key}")
    echo "    Kept in ${key}. Without it, the stored keys can't be read."
  fi
  say "Building and starting Mabari in Docker (the first build takes a few minutes)"
  (cd "${SRC_DIR}" && MABARI_VERSION="$(git describe --tags --always 2>/dev/null || echo dev)" \
    docker compose -f deploy/docker/compose.yaml up -d --build)
  say "Mabari is running at http://localhost:4317"
  echo "    Stop it:    docker compose -f ${SRC_DIR}/deploy/docker/compose.yaml down"
  echo "    Update it:  run this installer again"
}

# Downloads the release build for this system into $1, or returns 1 when there is none.
download_release() {
  have curl || return 1
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) return 1 ;;
  esac
  tag="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)" || return 1
  [ -n "${tag}" ] || return 1
  version="${tag#v}"
  name="mabari_${version}_${os}_${arch}.tar.gz"
  work="$(mktemp -d)"
  say "Downloading Mabari ${tag} for ${os}/${arch}"
  curl -fsSL -o "${work}/${name}" "${URL}/releases/download/${tag}/${name}" || return 1
  if curl -fsSL -o "${work}/checksums.txt" "${URL}/releases/download/${tag}/checksums.txt"; then
    expected="$(grep " ${name}\$" "${work}/checksums.txt" | awk '{print $1}')"
    if have sha256sum; then actual="$(sha256sum "${work}/${name}" | awk '{print $1}')"
    else actual="$(shasum -a 256 "${work}/${name}" | awk '{print $1}')"; fi
    [ -n "${expected}" ] && [ "${expected}" = "${actual}" ] || fail "The download doesn't match checksums.txt."
  fi
  tar -xzf "${work}/${name}" -C "${work}"
  cp "${work}/mabari" "$1"
  rm -rf "${work}"
}

build_from_source() {
  have go || fail "Go 1.27 or later is needed to build Mabari: https://go.dev/dl/"
  [ "$(version_number "$(go env GOVERSION)")" -ge 1027 ] || fail "Go 1.27 or later is needed; you have $(go env GOVERSION)."
  have node || fail "Node 22 or later is needed to build Mabari's web app: https://nodejs.org/"
  [ "$(version_number "$(node --version)")" -ge 22000 ] || fail "Node 22 or later is needed; you have $(node --version)."
  fetch_source
  if have pnpm; then pnpm_cmd="pnpm"
  elif have corepack; then corepack enable >/dev/null 2>&1 || true; pnpm_cmd="corepack pnpm"
  else pnpm_cmd="npx --yes pnpm@10"; fi
  say "Building the web app"
  (cd "${SRC_DIR}/web" && ${pnpm_cmd} install --frozen-lockfile && ${pnpm_cmd} build)
  say "Building the mabari binary"
  version="$(git -C "${SRC_DIR}" describe --tags --always 2>/dev/null || echo dev)"
  (cd "${SRC_DIR}" && CGO_ENABLED=0 go build -tags embedweb -trimpath \
    -ldflags "-s -w -X main.version=${version}" -o "$1" ./cmd/mabari)
}

install_binary() {
  mkdir -p "${BIN_DIR}"
  target="${BIN_DIR}/mabari"
  staged="${target}.new"
  if [ "${FROM_SOURCE}" -eq 1 ] || ! download_release "${staged}"; then
    [ "${FROM_SOURCE}" -eq 1 ] || say "No release build to download, so building from source"
    build_from_source "${staged}"
  fi
  chmod 755 "${staged}"
  mv -f "${staged}" "${target}"
  say "Installed ${target} ($("${target}" version 2>/dev/null || echo 'mabari'))"
  case ":${PATH}:" in
    *":${BIN_DIR}:"*) ;;
    *) echo "    Add ${BIN_DIR} to your PATH, for example: echo 'export PATH=\"${BIN_DIR}:\$PATH\"' >> ~/.profile" ;;
  esac
  if [ "${SERVICE}" -eq 1 ]; then
    "${target}" service install
  else
    echo "    Start it:            mabari, then open http://localhost:4317"
    echo "    Start it at login:   mabari service install"
  fi
}

case "$(uname -s)" in
  Darwin|Linux) ;;
  *) fail "This installer is for macOS and Linux. On Windows, use install.ps1 (see the README)." ;;
esac

if [ "${DOCKER}" -eq 1 ]; then install_docker; else install_binary; fi
