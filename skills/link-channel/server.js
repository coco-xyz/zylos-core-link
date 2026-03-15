#!/usr/bin/env node
/**
 * Link Channel Server
 *
 * HTTP service running on port 4200 inside agent containers.
 * Receives messages from the Agent API Service and routes them to Claude
 * via the C4 queue, then waits for Claude's response and returns it.
 *
 * Flow:
 *   POST /messages → c4-receive.js → C4 Queue → C4 dispatcher → Claude
 *   Claude → c4-send.js "link-channel" <req_id> → send.js → response file
 *   server watches response file → resolves HTTP response
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
const RESPONSES_DIR = path.join(DATA_DIR, 'responses');
const C4_RECEIVE = path.join(SKILLS_DIR, 'comm-bridge', 'scripts', 'c4-receive.js');

const PORT = parseInt(process.env.LINK_CHANNEL_PORT || '4200', 10);
const TIMEOUT_MS = parseInt(process.env.LINK_CHANNEL_TIMEOUT_MS || '30000', 10);

// Ensure data directories exist
fs.mkdirSync(PENDING_DIR, { recursive: true });
fs.mkdirSync(RESPONSES_DIR, { recursive: true });

// In-memory map of pending requests: req_id → { resolve, reject, cleanup }
const pending = new Map();

// Watch responses directory for completed requests
const watcher = fs.watch(RESPONSES_DIR, (eventType, filename) => {
  if (eventType !== 'rename' || !filename?.endsWith('.json')) return;

  const reqId = filename.slice(0, -5); // strip .json
  const entry = pending.get(reqId);
  if (!entry) return;

  const responsePath = path.join(RESPONSES_DIR, filename);

  // Small delay to ensure file is fully written
  setTimeout(() => {
    try {
      const raw = fs.readFileSync(responsePath, 'utf8');
      const data = JSON.parse(raw);
      entry.cleanup();
      entry.resolve(data);
    } catch (err) {
      entry.cleanup();
      entry.reject(new Error(`Failed to read response: ${err.message}`));
    }
  }, 50);
});

watcher.on('error', (err) => {
  console.error('[link-channel] Watcher error:', err);
});

function queueMessage(reqId, agentId, content) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(reqId);
      fs.unlink(path.join(PENDING_DIR, reqId), () => {});
      reject(new Error('Request timed out'));
    }, TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      pending.delete(reqId);
      fs.unlink(path.join(PENDING_DIR, reqId), () => {});
      fs.unlink(path.join(RESPONSES_DIR, `${reqId}.json`), () => {});
    };

    pending.set(reqId, { resolve, reject, cleanup });

    // Write pending marker
    fs.writeFileSync(path.join(PENDING_DIR, reqId), JSON.stringify({ agentId, content, ts: Date.now() }));

    // Format message content for Claude (channel label + content)
    const label = agentId ? `[HxA Link] ${agentId} says` : '[HxA Link]';
    const messageContent = `${label}: ${content}`;

    // Queue via c4-receive.js
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
        cleanup();
        reject(new Error(`c4-receive exited with code ${code}`));
      }
      // Success: wait for response via file watcher
    });

    child.on('error', (err) => {
      cleanup();
      reject(new Error(`c4-receive error: ${err.message}`));
    });
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
    return sendJson(res, 200, { ok: true, pending: pending.size });
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

  const agentId = req.headers['x-agent-id'] || null;
  const reqId = crypto.randomUUID().replace(/-/g, '');

  try {
    const result = await queueMessage(reqId, agentId, content);
    return sendJson(res, 200, result);
  } catch (err) {
    if (err.message === 'Request timed out') {
      return sendJson(res, 504, { error: 'gateway_timeout', message: 'Agent did not respond in time' });
    }
    console.error('[link-channel] Error:', err);
    return sendJson(res, 502, { error: 'bad_gateway', message: err.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[link-channel] Listening on port ${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('[link-channel] Shutting down...');
  server.close();
  watcher.close();
  process.exit(0);
});
