#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

HOME_DIR="$TMP_DIR/home"
ZYLOS_DIR="$HOME_DIR/zylos"
CONTROL_SCRIPT="$ROOT_DIR/skills/comm-bridge/scripts/c4-control.js"

mkdir -p "$ZYLOS_DIR/.zylos"

cat > "$ZYLOS_DIR/.zylos/config.json" <<'EOF'
{
  "runtime": "codex"
}
EOF

extract_id() {
  local output="$1"
  local id
  id="$(printf '%s\n' "$output" | sed -n 's/.*control \([0-9][0-9]*\).*/\1/p' | head -n 1)"
  if [ -z "$id" ]; then
    echo "failed to extract control id from output:" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
  printf '%s\n' "$id"
}

echo "== repeated enqueue supersedes older pending control =="
FIRST_OUT="$(HOME="$HOME_DIR" ZYLOS_DIR="$ZYLOS_DIR" node "$CONTROL_SCRIPT" enqueue --content "dedupe me")"
SECOND_OUT="$(HOME="$HOME_DIR" ZYLOS_DIR="$ZYLOS_DIR" node "$CONTROL_SCRIPT" enqueue --content "dedupe me")"

FIRST_ID="$(extract_id "$FIRST_OUT")"
SECOND_ID="$(extract_id "$SECOND_OUT")"

if ! printf '%s\n' "$SECOND_OUT" | grep -Fq "OK: superseded 1 equivalent pending control(s)"; then
  echo "missing supersede log line in second enqueue output" >&2
  printf '%s\n' "$SECOND_OUT" >&2
  exit 1
fi

ROOT_DIR="$ROOT_DIR" FIRST_ID="$FIRST_ID" SECOND_ID="$SECOND_ID" HOME="$HOME_DIR" ZYLOS_DIR="$ZYLOS_DIR" node --input-type=module <<'EOF'
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(`${process.env.ROOT_DIR}/skills/comm-bridge/scripts/c4-db.js`).href;
const {
  getControlById,
  getNextPendingControl,
  claimControl,
  ackControl,
  close
} = await import(moduleUrl);

const firstId = Number(process.env.FIRST_ID);
const secondId = Number(process.env.SECOND_ID);

try {
  const first = getControlById(firstId);
  const second = getControlById(secondId);

  assert.equal(first.status, 'superseded');
  assert.equal(second.status, 'pending');

  const next = getNextPendingControl();
  assert.equal(next.id, secondId);

  assert.equal(claimControl(firstId), false);
  assert.equal(claimControl(secondId), true);
  assert.equal(getControlById(secondId).status, 'running');

  const supersededAck = ackControl(firstId);
  assert.equal(supersededAck.found, true);
  assert.equal(supersededAck.alreadyFinal, true);
  assert.equal(supersededAck.status, 'superseded');

  const runningAck = ackControl(secondId);
  assert.equal(runningAck.found, true);
  assert.equal(runningAck.alreadyFinal, false);
  assert.equal(runningAck.status, 'done');
  assert.equal(getControlById(secondId).status, 'done');
} finally {
  close();
}
EOF

echo "E2E OK"
