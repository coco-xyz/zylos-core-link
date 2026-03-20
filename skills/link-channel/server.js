#!/usr/bin/env node
/**
 * Link Channel Server (Async Mode)
 *
 * HTTP service running on port 4200 inside agent containers.
 * Receives messages from the Agent API Service, queues them to C4 for
 * Claude processing, and returns immediately with a request_id.
 *
 * Claude's response is delivered asynchronously via send.js → hxa-link
 * /agent-callback (same pattern as zylos-lark).
 *
 * Flow:
 *   POST /messages → queue via c4-receive.js → return { request_id, status: "queued" }
 *   Claude processes → c4-send.js "link-channel" <req_id> → send.js → POST /agent-callback
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
const C4_RECEIVE = path.join(SKILLS_DIR, 'comm-bridge', 'scripts', 'c4-receive.js');

const PORT = parseInt(process.env.LINK_CHANNEL_PORT || '4200', 10);

// Ensure data directories exist
fs.mkdirSync(PENDING_DIR, { recursive: true });

// Track in-flight requests for health reporting
let inflight = 0;

function queueMessage(reqId, agentId, conversationId, content) {
  // Store metadata for send.js to read when delivering response
  const meta = { agentId, conversationId, content, ts: Date.now() };
  fs.writeFileSync(path.join(PENDING_DIR, `${reqId}.json`), JSON.stringify(meta));

  inflight++;

  // Format message content for Claude (channel label + content)
  const label = agentId ? `[HxA Link] ${agentId} says` : '[HxA Link]';
  const messageContent = `${label}: ${content}`;

  // Queue via c4-receive.js (fire-and-forget from caller's perspective)
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
      // Clean up pending file on queue failure
      fs.unlink(path.join(PENDING_DIR, `${reqId}.json`), () => {});
      inflight--;
    }
    // On success, send.js will decrement inflight when it delivers the response
  });

  child.on('error', (err) => {
    console.error(`[link-channel] c4-receive error for ${reqId}:`, err.message);
    fs.unlink(path.join(PENDING_DIR, `${reqId}.json`), () => {});
    inflight--;
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
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

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true, inflight });
  }

  if (req.method !== 'POST' || req.url !== '/messages') {
    return sendJson(res, 404, { error: 'not_found' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { error: 'invalid_json' });
  }

  // Support both { message: string } and { messages: [...] } formats
  let content;
  if (typeof body.message === 'string') {
    content = body.message;
  } else if (Array.isArray(body.messages) && body.messages.length > 0) {
    // Extract last user message for simple routing
    const lastMsg = body.messages.slice().reverse().find(m => m.role === 'user');
    content = lastMsg
      ? (typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content))
      : JSON.stringify(body.messages);
  } else {
    return sendJson(res, 400, { error: 'message or messages required' });
  }

  const agentId = req.headers['x-agent-id'] || process.env.AGENT_ID || null;
  const conversationId = body.conversation_id || null;
  const reqId = crypto.randomUUID().replace(/-/g, '');

  // Queue to C4 and return immediately
  queueMessage(reqId, agentId, conversationId, content);

  return sendJson(res, 202, {
    request_id: reqId,
    status: 'queued',
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[link-channel] Listening on port ${PORT} (async mode)`);
});

process.on('SIGTERM', () => {
  console.log('[link-channel] Shutting down...');
  server.close();
  process.exit(0);
});
