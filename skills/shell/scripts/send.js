#!/usr/bin/env node
/**
 * Shell channel - send script
 * Delivers a message to the zylos shell REPL via Unix domain socket.
 *
 * Usage: node send.js <socket_path> <message>
 */

import net from 'node:net';

const socketPath = process.argv[2];
const message = process.argv[3];

if (!socketPath || process.argv.length < 4) {
  console.error('Usage: node send.js <socket_path> <message>');
  process.exit(1);
}

const client = net.createConnection({ path: socketPath }, () => {
  client.end(message);
});

client.on('error', (err) => {
  console.error(`[shell] Failed to deliver message: ${err.message}`);
  process.exit(1);
});

client.on('close', () => {
  process.exit(0);
});
