---
name: shell
description: CLI interactive mode channel. Delivers Claude responses to the zylos shell REPL via Unix socket.
user-invocable: false
---

# Shell Channel

Communication channel for `zylos shell` — the CLI interactive mode.

## How It Works

1. `zylos shell` starts a readline REPL and a Unix domain socket server
2. User input is sent to Claude via `c4-receive` (channel=shell, endpoint=socket path)
3. Claude responds via `c4-send` which invokes `scripts/send.js`
4. `send.js` connects to the Unix socket and delivers the response to the REPL
5. The REPL prints the response and prompts for the next input

## Socket Protocol

- Socket path is passed as the endpoint (e.g., `/tmp/zylos-shell-<pid>.sock`)
- `send.js` connects, writes the full message as UTF-8, then closes the connection
- The REPL reassembles the message from socket data events
