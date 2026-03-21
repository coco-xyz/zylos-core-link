import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = path.join(__dirname, '..', 'server.js');

let tmpDir;
let serverProcess;
let serverPort;
let baseUrl;

async function findFreePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function startServer() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-server-test-'));

  // Create required directory structure
  const skillsDir = path.join(tmpDir, '.claude', 'skills', 'comm-bridge', 'scripts');
  fs.mkdirSync(skillsDir, { recursive: true });

  // Mock c4-receive.js that just echoes args to a file
  fs.writeFileSync(path.join(skillsDir, 'c4-receive.js'), `
    import fs from 'fs';
    import path from 'path';
    const args = process.argv.slice(2);
    const parsed = {};
    for (let i = 0; i < args.length; i += 2) {
      parsed[args[i].replace('--', '')] = args[i + 1];
    }
    const logDir = path.join(process.env.ZYLOS_DIR, 'link-channel', 'c4-log');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, Date.now() + '.json'), JSON.stringify(parsed));
  `);

  serverPort = await findFreePort();
  baseUrl = `http://127.0.0.1:${serverPort}`;

  return new Promise((resolve, reject) => {
    serverProcess = spawn('node', [SERVER_SCRIPT], {
      env: {
        ...process.env,
        ZYLOS_DIR: tmpDir,
        LINK_CHANNEL_PORT: String(serverPort),
        AGENT_ID: 'test-agent-123',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) reject(new Error('Server startup timeout'));
    }, 10_000);

    serverProcess.stdout.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Listening on port') && !started) {
        started = true;
        clearTimeout(timeout);
        resolve();
      }
    });

    serverProcess.stderr.on('data', (data) => {
      // Log but don't fail — some test scenarios produce expected errors
    });

    serverProcess.on('error', reject);
  });
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
}

async function req(method, urlPath, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(5_000),
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${baseUrl}${urlPath}`, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, headers: res.headers, text, json };
}

// ─── Server Integration Tests ───────────────────────────────────────────────

describe('link-channel server', () => {
  before(async () => {
    await startServer();
  });

  after(() => {
    stopServer();
  });

  // --- Health ---

  describe('GET /health', () => {
    it('returns 200 with ok status', async () => {
      const { status, json } = await req('GET', '/health');
      assert.equal(status, 200);
      assert.equal(json.ok, true);
      assert.equal(typeof json.inflight, 'number');
    });
  });

  // --- Message Endpoint ---

  describe('POST /messages', () => {
    it('accepts simple text message and returns 202', async () => {
      const { status, json } = await req('POST', '/messages', {
        message: 'Hello agent',
      });
      assert.equal(status, 202);
      assert.equal(json.status, 'queued');
      assert.ok(json.request_id, 'should have request_id');
      assert.equal(json.request_id.length, 32, 'request_id should be UUID without dashes');
    });

    it('accepts messages array format', async () => {
      const { status, json } = await req('POST', '/messages', {
        messages: [
          { role: 'user', content: 'Tell me a joke' },
        ],
      });
      assert.equal(status, 202);
      assert.equal(json.status, 'queued');
    });

    it('extracts last user message from messages array', async () => {
      const { status, json } = await req('POST', '/messages', {
        messages: [
          { role: 'assistant', content: 'I am here' },
          { role: 'user', content: 'First question' },
          { role: 'assistant', content: 'Answer' },
          { role: 'user', content: 'Follow up' },
        ],
      });
      assert.equal(status, 202);
    });

    it('rejects request with no message or messages', async () => {
      const { status, json } = await req('POST', '/messages', {
        foo: 'bar',
      });
      assert.equal(status, 400);
      assert.ok(json.error.includes('message'));
    });

    it('rejects invalid JSON body', async () => {
      const res = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json{{{',
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.ok(json.error.includes('Invalid JSON'));
    });

    it('includes conversation_id in pending metadata', async () => {
      const { json } = await req('POST', '/messages', {
        message: 'test',
        conversation_id: 'conv-abc-123',
      });
      assert.equal(json.status, 'queued');

      // Verify pending file was written
      const pendingPath = path.join(tmpDir, 'link-channel', 'pending', `${json.request_id}.json`);
      // Give a moment for the async file write
      await new Promise(r => setTimeout(r, 100));
      const meta = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
      assert.equal(meta.conversationId, 'conv-abc-123');
    });

    it('handles multimodal content blocks with text', async () => {
      const { status, json } = await req('POST', '/messages', {
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Look at this' },
            { type: 'text', text: 'And this' },
          ],
        }],
      });
      assert.equal(status, 202);
    });
  });

  // --- Deduplication ---

  describe('deduplication', () => {
    it('returns duplicate status for same dedup_key', async () => {
      const dedupKey = `test-dedup-${Date.now()}`;

      const first = await req('POST', '/messages', {
        message: 'first',
        dedup_key: dedupKey,
      });
      assert.equal(first.status, 202);
      assert.equal(first.json.status, 'queued');

      const second = await req('POST', '/messages', {
        message: 'second',
        dedup_key: dedupKey,
      });
      assert.equal(second.status, 200);
      assert.equal(second.json.status, 'duplicate');
      assert.equal(second.json.request_id, first.json.request_id);
    });

    it('allows different dedup_keys', async () => {
      const r1 = await req('POST', '/messages', {
        message: 'a',
        dedup_key: `unique-${Date.now()}-1`,
      });
      const r2 = await req('POST', '/messages', {
        message: 'b',
        dedup_key: `unique-${Date.now()}-2`,
      });
      assert.equal(r1.status, 202);
      assert.equal(r2.status, 202);
      assert.notEqual(r1.json.request_id, r2.json.request_id);
    });
  });

  // --- File Serving ---

  describe('GET /files/*', () => {
    it('serves an existing file', async () => {
      const filesDir = path.join(tmpDir, 'link-channel', 'files');
      fs.mkdirSync(filesDir, { recursive: true });
      fs.writeFileSync(path.join(filesDir, 'test.png'), 'fake-image-data');

      const res = await fetch(`${baseUrl}/files/test.png`, {
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/png');
      const body = await res.text();
      assert.equal(body, 'fake-image-data');
    });

    it('returns 404 for non-existent file', async () => {
      const { status, json } = await req('GET', '/files/does-not-exist.png');
      assert.equal(status, 404);
      assert.equal(json.error, 'file_not_found');
    });

    it('prevents directory traversal', async () => {
      // Write a file outside files dir
      fs.writeFileSync(path.join(tmpDir, 'secret.txt'), 'secret');

      const res = await fetch(`${baseUrl}/files/..%2F..%2Fsecret.txt`, {
        signal: AbortSignal.timeout(5_000),
      });
      // path.basename strips traversal, so it should look for "secret.txt" in FILES_DIR
      assert.equal(res.status, 404);
    });

    it('returns 400 for malformed URL encoding', async () => {
      const res = await fetch(`${baseUrl}/files/%E0%A4%A`, {
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.error, 'invalid_url_encoding');
    });

    it('serves file with correct MIME type', async () => {
      const filesDir = path.join(tmpDir, 'link-channel', 'files');
      fs.writeFileSync(path.join(filesDir, 'doc.pdf'), 'fake-pdf');

      const res = await fetch(`${baseUrl}/files/doc.pdf`, {
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/pdf');
    });

    it('defaults to octet-stream for unknown extension', async () => {
      const filesDir = path.join(tmpDir, 'link-channel', 'files');
      fs.writeFileSync(path.join(filesDir, 'data.xyz'), 'binary');

      const res = await fetch(`${baseUrl}/files/data.xyz`, {
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    });
  });

  // --- Routing ---

  describe('routing', () => {
    it('returns 404 for unknown paths', async () => {
      const { status, json } = await req('GET', '/unknown');
      assert.equal(status, 404);
      assert.equal(json.error, 'not_found');
    });

    it('returns 404 for POST to non-messages path', async () => {
      const { status, json } = await req('POST', '/other', { message: 'hi' });
      assert.equal(status, 404);
    });

    it('returns 404 for GET /messages', async () => {
      const { status } = await req('GET', '/messages');
      assert.equal(status, 404);
    });
  });
});
