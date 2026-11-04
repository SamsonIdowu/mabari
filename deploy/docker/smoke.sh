#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Starts Mabari with compose, checks it the way a person would use it, then removes it.
# Usage: deploy/docker/smoke.sh [extra compose files...]. Runs on port 4398 by default.
set -euo pipefail

cd "$(dirname "$0")/../.."
export MABARI_HOST_PORT="${MABARI_HOST_PORT:-4398}"
project="mabari-smoke-$$"
files=(-f deploy/docker/compose.yaml)
for extra in "$@"; do files+=(-f "$extra"); done
compose() { docker compose -p "$project" "${files[@]}" "$@"; }
base="http://127.0.0.1:${MABARI_HOST_PORT}"

key_made=0
if [ ! -f deploy/docker/mabari_master_key ]; then
  (umask 077 && openssl rand -base64 32 > deploy/docker/mabari_master_key)
  key_made=1
fi
cleanup() {
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  if [ "$key_made" = 1 ]; then rm -f deploy/docker/mabari_master_key; fi
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; compose logs --no-color | tail -40 >&2; exit 1; }
pass() { echo "ok   $*"; }

compose up -d --build --wait --wait-timeout 90 || fail "the container didn't become healthy"
pass "healthy, by its own healthcheck"

curl -fsS "$base/api/health" | grep -q '"ok":true' || fail "health"
pass "answers /api/health"

# Through Docker every browser signs in with the access key.
status=$(curl -s -o /dev/null -w '%{http_code}' "$base/api/snapshot")
[ "$status" = 401 ] || fail "the office answered without a sign in ($status)"
pass "asks for the access key"
key=$(compose exec -T mabari /mabari access-key 2>/dev/null || compose exec -T mabari mabari access-key)
token=$(curl -fsS -H "Origin: $base" -H "Content-Type: application/json" \
  -d "{\"key\":\"$key\"}" "$base/api/login" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$token" ] || fail "sign in with the key"
pass "signs in with the key from mabari access-key"
api() { curl -fsS -H "Authorization: Bearer $token" -H "Origin: $base" "$@"; }

api -X POST "$base/api/demo/load" >/dev/null || fail "demo load"
agents=$(api "$base/api/snapshot" | grep -o '"state":' | wc -l | tr -d ' ')
[ "$agents" -gt 0 ] || fail "the demo office has no agents"
pass "demo office has $agents agents"

status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 -H "Sec-WebSocket-Protocol: mabari, mabari.session.$token" \
  -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Origin: $base" "$base/ws" || true)
[ "$status" = 101 ] || fail "WebSocket upgrade answered $status"
pass "WebSocket upgrades"

status=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Origin: https://evil.example" "$base/api/demo/load")
[ "$status" = 403 ] || fail "another site got $status"
pass "refuses other websites"

id=$(compose ps -q mabari)
[ "$(docker inspect -f '{{range (index .NetworkSettings.Ports "4317/tcp")}}{{.HostIp}} {{end}}' "$id")" = "127.0.0.1 " ] \
  || fail "the port is published beyond 127.0.0.1"
pass "published on 127.0.0.1 only"
[ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$id")" = true ] || fail "root file system is writable"
[ "$(docker inspect -f '{{.HostConfig.CapDrop}}' "$id")" = "[ALL]" ] || fail "capabilities kept"
docker inspect -f '{{.HostConfig.SecurityOpt}}' "$id" | grep -q no-new-privileges || fail "no-new-privileges missing"
user=$(docker inspect -f '{{.Config.User}}' "$id")
case "$user" in root | 0 | "") fail "runs as root ($user)" ;; esac
pass "read-only, no capabilities, no new privileges, user $user"

if [ "$#" = 0 ]; then
  size=$(docker image inspect -f '{{.Size}}' mabari:latest)
  [ "$size" -lt 40000000 ] || fail "image is $size bytes, over 40 MB"
  pass "image is $((size / 1000000)) MB"
fi
echo "smoke test passed"
