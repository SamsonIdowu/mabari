#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Installs the snapshot from dist/ in clean containers and checks each one starts and answers:
# the Linux archive, the .deb and the .rpm. On macOS it also runs the macOS archive from a
# scratch folder. Run `make release-snapshot` first.
set -euo pipefail
cd "$(dirname "$0")/.."
arch=$(uname -m); case "$arch" in arm64 | aarch64) arch=arm64 ;; *) arch=amd64 ;; esac
key=install-check-only-master-key-0123456789abcd
run="MABARI_SECRETS=encrypted-file MABARI_MASTER_KEY=$key MABARI_DATA_DIR=/tmp/mabari-data"
check='for i in $(seq 1 20); do mabari healthcheck >/dev/null 2>&1 && break; sleep 0.5; done; mabari healthcheck'

one() { # name image install-command
  printf '%-22s' "$1"
  docker run --rm -v "$PWD/dist:/dist:ro" "$2" sh -c "$3 >/dev/null 2>&1 && ($run mabari serve >/tmp/log 2>&1 &) && $check" \
    || { echo "FAIL"; exit 1; }
}

tarball=$(ls dist/mabari_*_linux_${arch}.tar.gz | head -1)
one "Linux archive" debian:bookworm-slim \
  "tar -xzf /dist/$(basename "$tarball") -C /usr/local/bin mabari"
one ".deb on Debian" debian:bookworm-slim "dpkg -i /dist/$(basename "$(ls dist/*_linux_${arch}.deb)")"
one ".deb on Ubuntu" ubuntu:24.04 "dpkg -i /dist/$(basename "$(ls dist/*_linux_${arch}.deb)")"
one ".rpm on Fedora" fedora:42 "rpm -i /dist/$(basename "$(ls dist/*_linux_${arch}.rpm)")"

if [ "$(uname)" = Darwin ]; then
  printf '%-22s' "macOS archive"
  scratch=$(mktemp -d)
  tar -xzf "$(ls dist/mabari_*_darwin_${arch}.tar.gz | head -1)" -C "$scratch" mabari
  MABARI_SECRETS=encrypted-file MABARI_MASTER_KEY=$key MABARI_DATA_DIR="$scratch/data" \
    "$scratch/mabari" serve --port 4394 >"$scratch/log" 2>&1 &
  pid=$!
  for _ in $(seq 1 20); do "$scratch/mabari" healthcheck --port 4394 >/dev/null 2>&1 && break; sleep 0.5; done
  "$scratch/mabari" healthcheck --port 4394 || { kill "$pid"; echo FAIL; exit 1; }
  kill "$pid"; rm -rf "$scratch"
fi
echo "every install answered"
