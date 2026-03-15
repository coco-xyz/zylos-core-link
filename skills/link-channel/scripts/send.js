#!/usr/bin/env node
/**
 * Link Channel - Send Script
 *
 * Called by c4-send.js when Claude replies to a link-channel message.
 * Writes the response to the responses directory where server.js is watching.
 *
 * Usage: node send.js <req_id> "<response_content>"
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const RESPONSES_DIR = path.join(ZYLOS_DIR, 'link-channel', 'responses');

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: send.js <req_id> <response_content>');
  process.exit(1);
}

const [reqId, ...contentParts] = args;
const content = contentParts.join(' ');

// Ensure responses directory exists
fs.mkdirSync(RESPONSES_DIR, { recursive: true });

const responsePath = path.join(RESPONSES_DIR, `${reqId}.json`);
const response = {
  role: 'assistant',
  content,
  timestamp: new Date().toISOString(),
};

// Write atomically via temp file + rename
const tmpPath = `${responsePath}.tmp`;
fs.writeFileSync(tmpPath, JSON.stringify(response));
fs.renameSync(tmpPath, responsePath);

console.log(`[link-channel] Response written for request ${reqId}`);
