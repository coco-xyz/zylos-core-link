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
const mediaMatch = content.match(/^\[MEDIA:(\w+)\](.+)$/);

/**
 * Split long text into chunks (markdown-aware).
 * Keeps code blocks intact where possible.
 */
function splitMessage(text, maxLength) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      const finalChunk = remaining.trim();
      if (finalChunk.length > 0) chunks.push(finalChunk);
      break;
    }

    let breakAt = maxLength;
    const segment = remaining.substring(0, breakAt);
    const fenceMatches = segment.match(/```/g);
    const insideCodeBlock = fenceMatches && fenceMatches.length % 2 !== 0;

    if (insideCodeBlock) {
      // Try to break before the code block
      const lastFenceStart = segment.lastIndexOf('```');
      const lineBeforeFence = remaining.lastIndexOf('\n', lastFenceStart - 1);
      if (lineBeforeFence > maxLength * 0.2) {
        breakAt = lineBeforeFence;
      } else {
        // Include the entire code block
        const fenceEnd = remaining.indexOf('```', lastFenceStart + 3);
        if (fenceEnd !== -1) {
          const blockEnd = remaining.indexOf('\n', fenceEnd + 3);
          breakAt = blockEnd !== -1 ? blockEnd + 1 : fenceEnd + 3;
        }
        if (breakAt > maxLength * 1.5) breakAt = maxLength;
      }
    } else {
      // Prefer breaking at paragraph, then line, then word boundaries
      const chunk = remaining.substring(0, breakAt);
      const lastParaBreak = chunk.lastIndexOf('\n\n');
      if (lastParaBreak > maxLength * 0.3) {
        breakAt = lastParaBreak + 1;
      } else {
        const lastNewline = chunk.lastIndexOf('\n');
        if (lastNewline > maxLength * 0.3) {
          breakAt = lastNewline;
        } else {
          const lastSpace = chunk.lastIndexOf(' ');
          if (lastSpace > maxLength * 0.3) {
            breakAt = lastSpace;
          }
        }
      }
    }

    const nextChunk = remaining.substring(0, breakAt).trim();
    if (nextChunk.length > 0) chunks.push(nextChunk);
    remaining = remaining.substring(breakAt).trim();
  }

  return chunks;
}

/**
 * Copy a file to the shared files directory and return its serve path.
 * The file will be accessible via GET /files/<filename> on the local server.
 */
function stageFile(filePath) {
  const trimmed = filePath.trim();
  if (!fs.existsSync(trimmed)) {
    throw new Error(`File not found: ${trimmed}`);
  }
  fs.mkdirSync(FILES_DIR, { recursive: true });
  const basename = path.basename(trimmed);
  const ts = Date.now();
  const destName = `${ts}-${basename}`;
  const destPath = path.join(FILES_DIR, destName);
  fs.copyFileSync(trimmed, destPath);
  return destName;
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
      const [, mediaType, mediaPath] = mediaMatch;
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
          // On failure, don't send remaining chunks
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
