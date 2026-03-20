#!/usr/bin/env node
/**
 * Link Channel - Send Script (Async Callback Mode)
 *
 * Called by c4-send.js when Claude replies to a link-channel message.
 * Reads the pending request metadata (agent_id, conversation_id) and
 * POSTs the response to hxa-link's /agent-callback endpoint.
 *
 * This is the same pattern as zylos-lark's send.js calling the Lark API.
 *
 * Usage: node send.js <req_id> "<response_content>"
 *
 * Env vars:
 *   LINK_CALLBACK_URL  - Full URL for the callback (e.g. https://jessie.coco.site/hxa-link-api/agent-callback)
 *   LINK_SERVICE_KEY   - Bearer token for auth
 *   AGENT_ID           - Fallback agent ID if not in pending metadata
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const PENDING_DIR = path.join(ZYLOS_DIR, 'link-channel', 'pending');

const CALLBACK_URL = process.env.LINK_CALLBACK_URL;
const SERVICE_KEY = process.env.LINK_SERVICE_KEY;

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: send.js <req_id> <response_content>');
  process.exit(1);
}

const [reqId, ...contentParts] = args;
const content = contentParts.join(' ');

// Read pending metadata to get agent_id and conversation_id
let meta = {};
const pendingPath = path.join(PENDING_DIR, `${reqId}.json`);
try {
  meta = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
} catch {
  console.warn(`[link-channel] No pending metadata for ${reqId}, using env fallbacks`);
}

const agentId = meta.agentId || process.env.AGENT_ID || null;
const conversationId = meta.conversationId || null;

// Keep pending file — Claude may send multiple replies for the same request
// (e.g., "researching..." then final answer). Cleanup happens via periodic sweep.

if (!CALLBACK_URL) {
  // Fallback: write response to file (legacy mode for local dev)
  const RESPONSES_DIR = path.join(ZYLOS_DIR, 'link-channel', 'responses');
  fs.mkdirSync(RESPONSES_DIR, { recursive: true });
  const responsePath = path.join(RESPONSES_DIR, `${reqId}.json`);
  const response = { role: 'assistant', content, timestamp: new Date().toISOString() };
  const tmpPath = `${responsePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(response));
  fs.renameSync(tmpPath, responsePath);
  console.log(`[link-channel] Response written to file for ${reqId} (no LINK_CALLBACK_URL set)`);
  process.exit(0);
}

// POST to hxa-link /agent-callback
const payload = {
  agent_id: agentId,
  conversation_id: conversationId,
  content,
  request_id: reqId,
};

try {
  const res = await fetch(CALLBACK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(SERVICE_KEY ? { 'Authorization': `Bearer ${SERVICE_KEY}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[link-channel] Callback failed: ${res.status} ${body}`);
    process.exit(1);
  }

  const result = await res.json();
  console.log(`[link-channel] Callback delivered for ${reqId}: ${JSON.stringify(result)}`);
} catch (err) {
  console.error(`[link-channel] Callback error for ${reqId}: ${err.message}`);
  process.exit(1);
}
