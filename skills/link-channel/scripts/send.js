#!/usr/bin/env node
/**
 * Link Channel - Send Script (Enhanced)
 *
 * Called by c4-send.js when Claude replies to a link-channel message.
 * Reads the pending request metadata (agent_id, conversation_id) and
 * POSTs the response to hxa-link's /agent-callback endpoint.
 *
 * Supports:
 *   - Plain text with markdown-aware chunking (2000 chars/chunk)
 *   - [MEDIA:image]/path — sends content_type=image with media_url
 *   - [MEDIA:file]/path  — sends content_type=file with media_url
 *   - Graceful degradation on callback failure
 *
 * Usage: node send.js <req_id> "<response_content>"
 *
 * Env vars:
 *   LINK_CALLBACK_URL  - Full URL for the callback
 *   LINK_SERVICE_KEY   - Bearer token for auth
 *   AGENT_ID           - Fallback agent ID if not in pending metadata
 *   LINK_CHANNEL_PORT  - Local server port for file serving (default: 4200)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { splitMessage, stageFile as stageFileLib, parseMediaPrefix } from '../lib.js';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const PENDING_DIR = path.join(ZYLOS_DIR, 'link-channel', 'pending');
const FILES_DIR = path.join(ZYLOS_DIR, 'link-channel', 'files');

const CALLBACK_URL = process.env.LINK_CALLBACK_URL;
const SERVICE_KEY = process.env.LINK_SERVICE_KEY;
const LOCAL_PORT = parseInt(process.env.LINK_CHANNEL_PORT || '4200', 10);
const MAX_CHUNK_LENGTH = 2000;

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: send.js <req_id> <response_content>');
  process.exit(1);
}

const [reqId, ...contentParts] = args;
const content = contentParts.join(' ');

// Read pending metadata
let meta = {};
const pendingPath = path.join(PENDING_DIR, `${reqId}.json`);
try {
  meta = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
} catch {
  console.warn(`[link-channel] No pending metadata for ${reqId}, using env fallbacks`);
}

const agentId = meta.agentId || process.env.AGENT_ID || null;
const conversationId = meta.conversationId || null;

// Parse [MEDIA:type] prefix
const mediaMatch = parseMediaPrefix(content);

// Allowed source directories for media staging (prevent credential leaks)
const ALLOWED_MEDIA_DIRS = [
  path.join(ZYLOS_DIR, 'workspace'),
  path.join(ZYLOS_DIR, 'link-channel'),
  '/tmp',
];

function stageFile(filePath) {
  return stageFileLib(filePath, ALLOWED_MEDIA_DIRS, FILES_DIR);
}

/**
 * POST a single callback payload to hxa-link.
 */
async function postCallback(payload) {
  const res = await fetch(CALLBACK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(SERVICE_KEY ? { Authorization: `Bearer ${SERVICE_KEY}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Callback ${res.status}: ${body}`);
  }

  return res.json();
}

/**
 * Fallback: write response to file (no LINK_CALLBACK_URL set).
 */
function writeToFile(payload) {
  const RESPONSES_DIR = path.join(ZYLOS_DIR, 'link-channel', 'responses');
  fs.mkdirSync(RESPONSES_DIR, { recursive: true });
  const responsePath = path.join(RESPONSES_DIR, `${reqId}.json`);
  const tmpPath = `${responsePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload));
  fs.renameSync(tmpPath, responsePath);
  console.log(`[link-channel] Response written to file for ${reqId}`);
}

async function send() {
  if (!CALLBACK_URL) {
    writeToFile({ role: 'assistant', content, timestamp: new Date().toISOString() });
    process.exit(0);
  }

  try {
    if (mediaMatch) {
      // Media message: [MEDIA:image]/path or [MEDIA:file]/path
      const { mediaType, mediaPath } = mediaMatch;
      let payload;

      try {
        const filename = stageFile(mediaPath);
        const podIp = process.env.POD_IP || '127.0.0.1';
        const mediaUrl = `http://${podIp}:${LOCAL_PORT}/files/${filename}`;

        payload = {
          agent_id: agentId,
          conversation_id: conversationId,
          content: mediaType === 'image' ? '[image]' : `[file: ${path.basename(mediaPath.trim())}]`,
          content_type: mediaType,
          media_url: mediaUrl,
          request_id: reqId,
        };
      } catch (err) {
        // File staging failed — send as text fallback
        console.error(`[link-channel] Media staging failed: ${err.message}, sending as text`);
        payload = {
          agent_id: agentId,
          conversation_id: conversationId,
          content: `[Failed to attach ${mediaType}: ${err.message}]`,
          content_type: 'text',
          request_id: reqId,
        };
      }

      const result = await postCallback(payload);
      console.log(`[link-channel] Media callback delivered for ${reqId}: ${JSON.stringify(result)}`);
    } else {
      // Text message with chunking
      const chunks = splitMessage(content, MAX_CHUNK_LENGTH);

      for (let i = 0; i < chunks.length; i++) {
        const payload = {
          agent_id: agentId,
          conversation_id: conversationId,
          content: chunks[i],
          content_type: 'text',
          request_id: reqId,
          chunk_index: chunks.length > 1 ? i : undefined,
          chunk_total: chunks.length > 1 ? chunks.length : undefined,
        };

        try {
          const result = await postCallback(payload);
          console.log(`[link-channel] Callback delivered for ${reqId} (chunk ${i + 1}/${chunks.length}): ${JSON.stringify(result)}`);
        } catch (err) {
          console.error(`[link-channel] Callback failed for chunk ${i + 1}/${chunks.length}: ${err.message}`);
          // Notify frontend that message was truncated
          try {
            await postCallback({
              agent_id: agentId,
              conversation_id: conversationId,
              content: `[Message truncated: delivery failed at chunk ${i + 1}/${chunks.length}]`,
              content_type: 'error',
              request_id: reqId,
            });
          } catch { /* best-effort */ }
          process.exit(1);
        }

        // Small delay between chunks
        if (i < chunks.length - 1) {
          await new Promise(r => setTimeout(r, 300));
        }
      }
    }
  } catch (err) {
    console.error(`[link-channel] Send error for ${reqId}: ${err.message}`);
    process.exit(1);
  }
}

send();
