#!/usr/bin/env node
/**
 * Link Channel Server (Enhanced)
 *
 * HTTP service running on port 4200 inside agent containers.
 * Receives messages from the Agent API Service, queues them to C4 for
 * Claude processing, and returns immediately with a request_id.
 *
 * Features:
 *   - Async message processing (202 immediate return)
 *   - Image/file download from URLs
 *   - Multimodal content block parsing
 *   - Static file serving for outbound media (/files/*)
 *   - Message deduplication (5-minute window)
 *
 * Flow:
 *   Inbound:  POST /messages → download media → queue via c4-receive.js → 202
 *   Outbound: send.js stages file → /files/<name> served to hxa-link
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import crypto from 'crypto';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const SKILLS_DIR = path.join(ZYLOS_DIR, '.claude', 'skills');
const DATA_DIR = path.join(ZYLOS_DIR, 'link-channel');
const PENDING_DIR = path.join(DATA_DIR, 'pending');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const FILES_DIR = path.join(DATA_DIR, 'files');
const C4_RECEIVE = path.join(SKILLS_DIR, 'comm-bridge', 'scripts', 'c4-receive.js');

const PORT = parseInt(process.env.LINK_CHANNEL_PORT || '4200', 10);

// Ensure data directories exist
for (const dir of [PENDING_DIR, IMAGES_DIR, FILES_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// Track in-flight requests
let inflight = 0;

// Message deduplication (5-minute window)
const processedMessages = new Map();
const DEDUP_TTL = 5 * 60 * 1000;

function isDuplicate(key) {
  const now = Date.now();
  if (processedMessages.has(key)) return true;
  processedMessages.set(key, now);
  // Periodic cleanup
  if (processedMessages.size > 100) {
    for (const [k, ts] of processedMessages) {
      if (now - ts > DEDUP_TTL) processedMessages.delete(k);
    }
  }
  return false;
}

// MIME type map for file serving
const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
};

/**
 * Download a file from a URL to a local path.
 * Returns { localPath, mimeType } on success, null on failure.
 */
async function downloadFile(fileUrl, reqId, prefix) {
  try {
    const parsedUrl = new URL(fileUrl);
    const ext = path.extname(parsedUrl.pathname) || '.bin';
    const filename = `${prefix}-${reqId}${ext}`;
    const localPath = path.join(IMAGES_DIR, filename);

    const res = await fetch(fileUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      console.error(`[link-channel] Download failed: ${res.status} ${fileUrl}`);
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(localPath, buffer);
    const mimeType = res.headers.get('content-type') || MIME_TYPES[ext] || 'application/octet-stream';
    console.log(`[link-channel] Downloaded: ${localPath} (${buffer.length} bytes, ${mimeType})`);
    return { localPath, mimeType };
  } catch (err) {
    console.error(`[link-channel] Download error: ${err.message}`);
    return null;
  }
}

/**
 * Extract content from multimodal message blocks.
 * Supports:
 *   - { type: "text", text: "..." }
 *   - { type: "image_url", image_url: { url: "..." } }
 *   - { type: "image", url: "...", text: "..." }
 *   - plain string content
 */
async function extractMultimodalContent(msg, reqId) {
  if (typeof msg.content === 'string') return msg.content;
  if (!Array.isArray(msg.content)) return JSON.stringify(msg.content);

  const parts = [];
  let imageIndex = 0;

  for (const block of msg.content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }

    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    } else if (block.type === 'image_url' && block.image_url?.url) {
      const result = await downloadFile(block.image_url.url, reqId, `img${imageIndex++}`);
      if (result) {
        parts.push(`[Attached image: ${result.localPath}]`);
      } else {
        parts.push(`[Image failed to download: ${block.image_url.url}]`);
      }
    } else if (block.type === 'image' && block.url) {
      const result = await downloadFile(block.url, reqId, `img${imageIndex++}`);
      if (result) {
        parts.push(`[Attached image: ${result.localPath}]`);
      } else {
        parts.push(`[Image failed to download: ${block.url}]`);
      }
      if (block.text) parts.push(block.text);
    } else if (block.type === 'file' && block.url) {
      const result = await downloadFile(block.url, reqId, `file${imageIndex++}`);
      if (result) {
        parts.push(`[Attached file: ${result.localPath}]`);
      } else {
        parts.push(`[File failed to download: ${block.url}]`);
      }
      if (block.text) parts.push(block.text);
    }
  }

  return parts.join('\n');
}

function queueMessage(reqId, agentId, conversationId, content) {
  const meta = { agentId, conversationId, content, ts: Date.now() };
  fs.writeFileSync(path.join(PENDING_DIR, `${reqId}.json`), JSON.stringify(meta));

  inflight++;

  const label = agentId ? `[HxA Link] ${agentId} says` : '[HxA Link]';
  const messageContent = `${label}: ${content}`;

  const child = spawn('node', [
    C4_RECEIVE,
    '--channel', 'link-channel',
    '--endpoint', reqId,
    '--content', messageContent,
  ]);

  child.stderr.on('data', (d) => {
    console.error('[link-channel] c4-receive stderr:', d.toString().trim());
  });

  child.on('close', (code) => {
    if (code !== 0) {
      console.error(`[link-channel] c4-receive exited with code ${code} for ${reqId}`);
      fs.unlink(path.join(PENDING_DIR, `${reqId}.json`), () => {});
      inflight--;
    }
  });

  child.on('error', (err) => {
    console.error(`[link-channel] c4-receive error for ${reqId}:`, err.message);
    fs.unlink(path.join(PENDING_DIR, `${reqId}.json`), () => {});
    inflight--;
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Serve static files from the files directory.
 * Used by hxa-link to download media sent by Claude.
 */
function serveFile(req, res, filename) {
  // Sanitize filename to prevent directory traversal
  const safeName = path.basename(filename);
  const filePath = path.join(FILES_DIR, safeName);

  if (!fs.existsSync(filePath)) {
    return sendJson(res, 404, { error: 'file_not_found' });
  }

  const ext = path.extname(safeName).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const stat = fs.statSync(filePath);

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Cache-Control': 'public, max-age=3600',
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true, inflight });
  }

  // Static file serving for outbound media
  if (req.method === 'GET' && req.url.startsWith('/files/')) {
    const filename = decodeURIComponent(req.url.substring(7).split('?')[0]);
    return serveFile(req, res, filename);
  }

  // Message endpoint
  if (req.method !== 'POST' || req.url !== '/messages') {
    return sendJson(res, 404, { error: 'not_found' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  const agentId = req.headers['x-agent-id'] || process.env.AGENT_ID || null;
  const conversationId = body.conversation_id || null;
  const reqId = crypto.randomUUID().replace(/-/g, '');

  // Deduplication: use message content hash as key
  const dedupKey = body.dedup_key || null;
  if (dedupKey && isDuplicate(dedupKey)) {
    console.log(`[link-channel] Duplicate message filtered: ${dedupKey}`);
    return sendJson(res, 200, { request_id: reqId, status: 'duplicate' });
  }

  // Extract content from various message formats
  let content;
  if (typeof body.message === 'string') {
    content = body.message;
  } else if (Array.isArray(body.messages) && body.messages.length > 0) {
    const lastMsg = body.messages.slice().reverse().find(m => m.role === 'user');
    if (lastMsg) {
      content = await extractMultimodalContent(lastMsg, reqId);
    } else {
      content = JSON.stringify(body.messages);
    }
  } else {
    return sendJson(res, 400, { error: 'message or messages required' });
  }

  // Handle top-level image_url (backward compatible with TC-05)
  const imageUrl = typeof body.image_url === 'string' ? body.image_url : null;
  if (imageUrl) {
    const result = await downloadFile(imageUrl, reqId, 'img');
    if (result) {
      content = `[Attached image: ${result.localPath}]\n${content}`;
    } else {
      content = `[Image failed to download: ${imageUrl}]\n${content}`;
    }
  }

  // Handle top-level file_url
  const fileUrl = typeof body.file_url === 'string' ? body.file_url : null;
  if (fileUrl) {
    const result = await downloadFile(fileUrl, reqId, 'file');
    if (result) {
      content = `[Attached file: ${result.localPath}]\n${content}`;
    } else {
      content = `[File failed to download: ${fileUrl}]\n${content}`;
    }
  }

  // Queue to C4 and return immediately
  queueMessage(reqId, agentId, conversationId, content);

  return sendJson(res, 202, {
    request_id: reqId,
    status: 'queued',
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[link-channel] Listening on port ${PORT} (enhanced mode)`);
});

process.on('SIGTERM', () => {
  console.log('[link-channel] Shutting down...');
  server.close();
  process.exit(0);
});
