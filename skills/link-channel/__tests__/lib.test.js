import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  splitMessage,
  stageFile,
  checkDuplicate,
  extractMultimodalContent,
  parseMediaPrefix,
  MIME_TYPES,
} from '../lib.js';

// ─── splitMessage ───────────────────────────────────────────────────────────

describe('splitMessage', () => {
  it('returns single chunk when text is within limit', () => {
    const result = splitMessage('Hello world', 100);
    assert.deepEqual(result, ['Hello world']);
  });

  it('returns single chunk when text equals limit', () => {
    const text = 'a'.repeat(100);
    const result = splitMessage(text, 100);
    assert.deepEqual(result, [text]);
  });

  it('splits long text into multiple chunks', () => {
    const text = 'word '.repeat(100); // 500 chars
    const chunks = splitMessage(text, 100);
    assert.ok(chunks.length > 1, `expected >1 chunks, got ${chunks.length}`);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 100, `chunk too long: ${chunk.length}`);
    }
  });

  it('preserves all content across chunks', () => {
    const words = [];
    for (let i = 0; i < 50; i++) words.push(`word${i}`);
    const text = words.join(' ');
    const chunks = splitMessage(text, 80);
    const rejoined = chunks.join(' ');
    // All original words should be present
    for (const w of words) {
      assert.ok(rejoined.includes(w), `missing word: ${w}`);
    }
  });

  it('prefers paragraph breaks', () => {
    const para1 = 'A'.repeat(60);
    const para2 = 'B'.repeat(60);
    const text = `${para1}\n\n${para2}`;
    const chunks = splitMessage(text, 100);
    assert.equal(chunks.length, 2);
    assert.ok(chunks[0].startsWith('A'));
    assert.ok(chunks[1].startsWith('B'));
  });

  it('prefers line breaks over word breaks', () => {
    const lines = [];
    for (let i = 0; i < 10; i++) lines.push(`line ${i} content here`);
    const text = lines.join('\n');
    const chunks = splitMessage(text, 80);
    // Chunks should break at line boundaries, not mid-word
    for (const chunk of chunks) {
      assert.ok(!chunk.startsWith(' '), 'chunk should not start with space');
    }
  });

  it('keeps code blocks intact when possible', () => {
    const before = 'Some text here.\n';
    const codeBlock = '```js\nconst x = 1;\nconst y = 2;\n```';
    const after = '\nMore text after.';
    const text = before + codeBlock + after;
    const chunks = splitMessage(text, 50);
    // The code block should appear complete in one chunk
    const blockChunk = chunks.find(c => c.includes('```js'));
    assert.ok(blockChunk, 'code block should be in a chunk');
    assert.ok(blockChunk.includes('```js') && blockChunk.includes('const y = 2;'),
      'code block should be intact');
  });

  it('handles text with no good break points', () => {
    const text = 'a'.repeat(250);
    const chunks = splitMessage(text, 100);
    assert.ok(chunks.length >= 2);
    // All characters should be preserved
    assert.equal(chunks.join('').length, 250);
  });

  it('handles empty string', () => {
    const result = splitMessage('', 100);
    assert.deepEqual(result, ['']);
  });

  it('trims whitespace from chunks', () => {
    const text = 'first part   \n\n   second part';
    const chunks = splitMessage(text, 20);
    for (const chunk of chunks) {
      assert.equal(chunk, chunk.trim(), `chunk not trimmed: "${chunk}"`);
    }
  });
});

// ─── stageFile ──────────────────────────────────────────────────────────────

describe('stageFile', () => {
  let tmpDir;
  let allowedDir;
  let filesDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-stage-'));
    allowedDir = path.join(tmpDir, 'allowed');
    filesDir = path.join(tmpDir, 'files');
    fs.mkdirSync(allowedDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('copies file from allowed directory', () => {
    const srcPath = path.join(allowedDir, 'test.png');
    fs.writeFileSync(srcPath, 'fake-png-data');

    const destName = stageFile(srcPath, [allowedDir], filesDir);

    assert.ok(destName.endsWith('-test.png'));
    const destPath = path.join(filesDir, destName);
    assert.ok(fs.existsSync(destPath));
    assert.equal(fs.readFileSync(destPath, 'utf8'), 'fake-png-data');
  });

  it('rejects file outside allowed directories', () => {
    const outsideDir = path.join(tmpDir, 'outside');
    fs.mkdirSync(outsideDir);
    const srcPath = path.join(outsideDir, 'secret.env');
    fs.writeFileSync(srcPath, 'SECRET_KEY=abc');

    assert.throws(
      () => stageFile(srcPath, [allowedDir], filesDir),
      /not allowed/
    );
  });

  it('rejects non-existent file', () => {
    const srcPath = path.join(allowedDir, 'ghost.png');
    assert.throws(
      () => stageFile(srcPath, [allowedDir], filesDir),
      /not found/
    );
  });

  it('rejects path traversal attempts', () => {
    // Create a file at tmpDir level (outside allowedDir)
    fs.writeFileSync(path.join(tmpDir, '.env'), 'SECRET=true');
    const traversalPath = path.join(allowedDir, '..', '.env');

    assert.throws(
      () => stageFile(traversalPath, [allowedDir], filesDir),
      /not allowed/
    );
  });

  it('creates files directory if missing', () => {
    const srcPath = path.join(allowedDir, 'new.txt');
    fs.writeFileSync(srcPath, 'data');

    assert.ok(!fs.existsSync(filesDir));
    stageFile(srcPath, [allowedDir], filesDir);
    assert.ok(fs.existsSync(filesDir));
  });

  it('handles file with spaces in name', () => {
    const srcPath = path.join(allowedDir, 'my file.png');
    fs.writeFileSync(srcPath, 'data');

    const destName = stageFile(srcPath, [allowedDir], filesDir);
    assert.ok(destName.endsWith('-my file.png'));
    assert.ok(fs.existsSync(path.join(filesDir, destName)));
  });

  it('supports multiple allowed directories', () => {
    const allowed2 = path.join(tmpDir, 'allowed2');
    fs.mkdirSync(allowed2);
    const srcPath = path.join(allowed2, 'file.txt');
    fs.writeFileSync(srcPath, 'data');

    const destName = stageFile(srcPath, [allowedDir, allowed2], filesDir);
    assert.ok(destName.endsWith('-file.txt'));
  });
});

// ─── checkDuplicate ─────────────────────────────────────────────────────────

describe('checkDuplicate', () => {
  it('returns null for new message', () => {
    const store = new Map();
    const result = checkDuplicate(store, 'key1', 'req1', 300_000);
    assert.equal(result, null);
  });

  it('returns original reqId for duplicate', () => {
    const store = new Map();
    checkDuplicate(store, 'key1', 'req1', 300_000);
    const result = checkDuplicate(store, 'key1', 'req2', 300_000);
    assert.equal(result, 'req1');
  });

  it('returns null for different key', () => {
    const store = new Map();
    checkDuplicate(store, 'key1', 'req1', 300_000);
    const result = checkDuplicate(store, 'key2', 'req2', 300_000);
    assert.equal(result, null);
  });

  it('stores entry in the map', () => {
    const store = new Map();
    checkDuplicate(store, 'key1', 'req1', 300_000);
    assert.equal(store.size, 1);
    assert.equal(store.get('key1').reqId, 'req1');
  });

  it('cleans up expired entries when store exceeds 100', () => {
    const store = new Map();
    // Fill store with 101 entries that are already expired
    const pastTs = Date.now() - 400_000;
    for (let i = 0; i < 101; i++) {
      store.set(`old-${i}`, { reqId: `r${i}`, ts: pastTs });
    }
    // This triggers cleanup
    checkDuplicate(store, 'new-key', 'new-req', 300_000);
    // Old entries should be cleaned up, only 'new-key' remains
    assert.ok(store.size < 101, `store should have been cleaned, size: ${store.size}`);
    assert.ok(store.has('new-key'));
  });
});

// ─── extractMultimodalContent ───────────────────────────────────────────────

describe('extractMultimodalContent', () => {
  const mockDownloadOk = async (url, reqId, prefix) => ({
    localPath: `/tmp/images/${prefix}-${reqId}.png`,
    mimeType: 'image/png',
  });

  const mockDownloadFail = async () => null;

  it('returns string content as-is', async () => {
    const result = await extractMultimodalContent({ content: 'hello' }, 'req1', mockDownloadOk);
    assert.equal(result, 'hello');
  });

  it('stringifies non-array non-string content', async () => {
    const result = await extractMultimodalContent({ content: { key: 'val' } }, 'req1', mockDownloadOk);
    assert.equal(result, '{"key":"val"}');
  });

  it('extracts text blocks', async () => {
    const msg = { content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] };
    const result = await extractMultimodalContent(msg, 'req1', mockDownloadOk);
    assert.equal(result, 'hello\nworld');
  });

  it('handles string items in array', async () => {
    const msg = { content: ['plain string'] };
    const result = await extractMultimodalContent(msg, 'req1', mockDownloadOk);
    assert.equal(result, 'plain string');
  });

  it('handles image_url blocks with successful download', async () => {
    const msg = { content: [{ type: 'image_url', image_url: { url: 'http://example.com/img.png' } }] };
    const result = await extractMultimodalContent(msg, 'req1', mockDownloadOk);
    assert.ok(result.includes('[Attached image:'));
  });

  it('handles image_url blocks with failed download', async () => {
    const msg = { content: [{ type: 'image_url', image_url: { url: 'http://example.com/img.png' } }] };
    const result = await extractMultimodalContent(msg, 'req1', mockDownloadFail);
    assert.ok(result.includes('[Image failed to download:'));
  });

  it('handles image blocks with text', async () => {
    const msg = { content: [{ type: 'image', url: 'http://example.com/img.png', text: 'caption' }] };
    const result = await extractMultimodalContent(msg, 'req1', mockDownloadOk);
    assert.ok(result.includes('[Attached image:'));
    assert.ok(result.includes('caption'));
  });

  it('handles file blocks', async () => {
    const msg = { content: [{ type: 'file', url: 'http://example.com/doc.pdf', text: 'see file' }] };
    const result = await extractMultimodalContent(msg, 'req1', mockDownloadOk);
    assert.ok(result.includes('[Attached file:'));
    assert.ok(result.includes('see file'));
  });

  it('handles mixed content blocks', async () => {
    const msg = {
      content: [
        { type: 'text', text: 'Check this:' },
        { type: 'image_url', image_url: { url: 'http://example.com/a.png' } },
        { type: 'text', text: 'And this:' },
        { type: 'file', url: 'http://example.com/b.pdf' },
      ],
    };
    const result = await extractMultimodalContent(msg, 'req1', mockDownloadOk);
    const lines = result.split('\n');
    assert.equal(lines[0], 'Check this:');
    assert.ok(lines[1].includes('[Attached image:'));
    assert.equal(lines[2], 'And this:');
    assert.ok(lines[3].includes('[Attached file:'));
  });

  it('uses separate indices for images and files', async () => {
    const calls = [];
    const trackingDownload = async (url, reqId, prefix) => {
      calls.push(prefix);
      return { localPath: `/tmp/${prefix}.bin`, mimeType: 'application/octet-stream' };
    };

    const msg = {
      content: [
        { type: 'image_url', image_url: { url: 'http://example.com/1.png' } },
        { type: 'file', url: 'http://example.com/1.pdf' },
        { type: 'image', url: 'http://example.com/2.png' },
        { type: 'file', url: 'http://example.com/2.pdf' },
      ],
    };

    await extractMultimodalContent(msg, 'req1', trackingDownload);
    assert.deepEqual(calls, ['img0', 'file0', 'img1', 'file1']);
  });
});

// ─── parseMediaPrefix ───────────────────────────────────────────────────────

describe('parseMediaPrefix', () => {
  it('parses [MEDIA:image] prefix', () => {
    const result = parseMediaPrefix('[MEDIA:image]/path/to/photo.jpg');
    assert.deepEqual(result, { mediaType: 'image', mediaPath: '/path/to/photo.jpg' });
  });

  it('parses [MEDIA:file] prefix', () => {
    const result = parseMediaPrefix('[MEDIA:file]/tmp/doc.pdf');
    assert.deepEqual(result, { mediaType: 'file', mediaPath: '/tmp/doc.pdf' });
  });

  it('returns null for plain text', () => {
    const result = parseMediaPrefix('Hello, world');
    assert.equal(result, null);
  });

  it('returns null for partial match', () => {
    const result = parseMediaPrefix('[MEDIA:image]');
    assert.equal(result, null);
  });

  it('handles paths with spaces', () => {
    const result = parseMediaPrefix('[MEDIA:file]/tmp/my document.pdf');
    assert.deepEqual(result, { mediaType: 'file', mediaPath: '/tmp/my document.pdf' });
  });
});

// ─── MIME_TYPES ─────────────────────────────────────────────────────────────

describe('MIME_TYPES', () => {
  it('maps common image extensions', () => {
    assert.equal(MIME_TYPES['.png'], 'image/png');
    assert.equal(MIME_TYPES['.jpg'], 'image/jpeg');
    assert.equal(MIME_TYPES['.gif'], 'image/gif');
    assert.equal(MIME_TYPES['.webp'], 'image/webp');
  });

  it('maps document extensions', () => {
    assert.equal(MIME_TYPES['.pdf'], 'application/pdf');
    assert.equal(MIME_TYPES['.json'], 'application/json');
    assert.equal(MIME_TYPES['.txt'], 'text/plain');
    assert.equal(MIME_TYPES['.md'], 'text/markdown');
  });

  it('does not contain unknown extensions', () => {
    assert.equal(MIME_TYPES['.exe'], undefined);
    assert.equal(MIME_TYPES['.sh'], undefined);
  });
});
