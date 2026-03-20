#!/usr/bin/env bash
#
# claude-token-refresh.sh — Refresh Claude Code OAuth token inside Zylos container.
#
# Adapted from coco-dashboard infra/golden-image/claude-token-refresh.sh.
# Called by PM2 token-refresh process every 6 hours.
#
# Reads current refresh_token from ~/.claude/.credentials.json,
# exchanges it for a new access+refresh pair, and updates the file.
#
set -euo pipefail

readonly CREDS_FILE="${HOME}/.claude/.credentials.json"
readonly TOKEN_URL="https://console.anthropic.com/v1/oauth/token"
readonly CLIENT_ID="9d1c250a-e61b-44d9-88ed-5944d1962f5e"
readonly LOG_TAG="claude-token-refresh"

log()  { printf '[%s %s] %s\n' "${LOG_TAG}" "$(date -u +%H:%M:%S)" "$*"; }
fail() { log "FATAL: $*"; exit 1; }

# ── Read current token ────────────────────────────────────────────
[[ -f "${CREDS_FILE}" ]] || fail "Credentials file not found: ${CREDS_FILE}"

REFRESH_TOKEN="$(jq -r '.claudeAiOauth.refreshToken // empty' "${CREDS_FILE}")"
[[ -n "${REFRESH_TOKEN}" ]] || fail "No refreshToken in ${CREDS_FILE}"

log "Refreshing token..."

# ── Exchange refresh token ────────────────────────────────────────
RESPONSE="$(printf 'grant_type=refresh_token&refresh_token=%s&client_id=%s' \
  "${REFRESH_TOKEN}" "${CLIENT_ID}" \
  | curl -sf --max-time 30 --retry 3 --retry-delay 5 \
    -X POST "${TOKEN_URL}" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d @- \
)" || fail "Token refresh request failed"

# Validate response
NEW_ACCESS="$(echo "${RESPONSE}" | jq -r '.access_token // empty')"
NEW_REFRESH="$(echo "${RESPONSE}" | jq -r '.refresh_token // empty')"
EXPIRES_IN="$(echo "${RESPONSE}" | jq -r '.expires_in // empty')"

[[ -n "${NEW_ACCESS}" ]]  || fail "No access_token in response: ${RESPONSE:0:200}"
[[ -n "${NEW_REFRESH}" ]] || fail "No refresh_token in response: ${RESPONSE:0:200}"

# ── Update .credentials.json atomically ─────────────────────────
EXPIRES_AT_MS="$(( ($(date -u +%s) + ${EXPIRES_IN:-28800}) * 1000 ))"
TMP_FILE="${CREDS_FILE}.tmp"

jq --arg at "${NEW_ACCESS}" \
   --arg rt "${NEW_REFRESH}" \
   --argjson exp "${EXPIRES_AT_MS}" \
   '.claudeAiOauth.accessToken = $at | .claudeAiOauth.refreshToken = $rt | .claudeAiOauth.expiresAt = $exp' \
   "${CREDS_FILE}" > "${TMP_FILE}"

chmod 600 "${TMP_FILE}"
mv -f "${TMP_FILE}" "${CREDS_FILE}"

log "Token refreshed successfully (expires_in: ${EXPIRES_IN}s, expiresAt: ${EXPIRES_AT_MS})"
