/**
 * Link Channel — Shared Library
 *
 * Pure/testable functions extracted from send.js and server.js.
 * No side effects — all dependencies are injected or parameterized.
 */

import fs from 'fs';
import path from 'path';

// ----- MIME types (used by server.js for file serving) -----

export const MIME_TYPES = {
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

// ----- Text chunking (used by send.js) -----

/**
 * Split long text into chunks (markdown-aware).
 * Keeps code blocks intact where possible.
 *
 * @param {string} text - Input text
 * @param {number} maxLength - Maximum characters per chunk
 * @returns {string[]} Array of text chunks
 */
export function splitMessage(text, maxLength) {
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

// ----- File staging (used by send.js) -----

/**
 * Copy a file to the shared files directory and return its serve name.
 * Only files from allowed directories can be staged (security).
 *
 * @param {string} filePath - Source file path
 * @param {string[]} allowedDirs - Allowed source directories
 * @param {string} filesDir - Destination directory for staged files
 * @returns {string} Destination filename (without path)
 */
export function stageFile(filePath, allowedDirs, filesDir) {
  const trimmed = filePath.trim();
  const resolved = path.resolve(trimmed);

  const allowed = allowedDirs.some(dir => resolved.startsWith(dir + path.sep));
  if (!allowed) {
    throw new Error(`Path not allowed for media staging: ${trimmed}`);
  }

  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }

  fs.mkdirSync(filesDir, { recursive: true });
  const basename = path.basename(resolved);
  const ts = Date.now();
  const destName = `${ts}-${basename}`;
  const destPath = path.join(filesDir, destName);
  fs.copyFileSync(resolved, destPath);
  return destName;
}

// ----- Message deduplication (used by server.js) -----

/**
 * Check if a message key is a duplicate within a time window.
 *
 * @param {Map} store - Dedup store (Map<key, {reqId, ts}>)
 * @param {string} key - Dedup key
 * @param {string} reqId - Current request ID
 * @param {number} ttl - Time-to-live in ms
 * @returns {string|null} Original reqId if duplicate, null otherwise
 */
export function checkDuplicate(store, key, reqId, ttl) {
  const now = Date.now();
  const existing = store.get(key);
  if (existing) {
    // Check if the entry has expired
    if (now - existing.ts > ttl) {
      store.delete(key);
      // Fall through to treat as new message
    } else {
      return existing.reqId;
    }
  }
  store.set(key, { reqId, ts: now });
  // Periodic cleanup when store gets large
  if (store.size > 100) {
    for (const [k, entry] of store) {
      if (now - entry.ts > ttl) store.delete(k);
    }
  }
  return null;
}

// ----- Multimodal content extraction (used by server.js) -----

/**
 * Extract content from multimodal message blocks.
 *
 * @param {object} msg - Message object with .content field
 * @param {string} reqId - Request ID for file naming
 * @param {function} downloadFn - async (url, reqId, prefix) => {localPath, mimeType} | null
 * @returns {Promise<string>} Extracted text content
 */
export async function extractMultimodalContent(msg, reqId, downloadFn) {
  if (typeof msg.content === 'string') return msg.content;
  if (!Array.isArray(msg.content)) return JSON.stringify(msg.content);

  const parts = [];
  let imgIdx = 0;
  let fileIdx = 0;

  for (const block of msg.content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }

    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    } else if (block.type === 'image_url' && block.image_url?.url) {
      const result = await downloadFn(block.image_url.url, reqId, `img${imgIdx++}`);
      if (result) {
        parts.push(`[Attached image: ${result.localPath}]`);
      } else {
        parts.push(`[Image failed to download: ${block.image_url.url}]`);
      }
    } else if (block.type === 'image' && block.url) {
      const result = await downloadFn(block.url, reqId, `img${imgIdx++}`);
      if (result) {
        parts.push(`[Attached image: ${result.localPath}]`);
      } else {
        parts.push(`[Image failed to download: ${block.url}]`);
      }
      if (block.text) parts.push(block.text);
    } else if (block.type === 'file' && block.url) {
      const result = await downloadFn(block.url, reqId, `file${fileIdx++}`);
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

// ----- Media prefix parsing (used by send.js) -----

/**
 * Parse a [MEDIA:type]/path prefix from message content.
 *
 * @param {string} content - Message content
 * @returns {{mediaType: string, mediaPath: string} | null}
 */
export function parseMediaPrefix(content) {
  const match = content.match(/^\[MEDIA:(\w+)\](.+)$/);
  if (!match) return null;
  return { mediaType: match[1], mediaPath: match[2] };
}
