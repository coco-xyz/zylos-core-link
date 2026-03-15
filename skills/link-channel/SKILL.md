---
name: link-channel
description: >-
  HxA Link channel — receives messages from the Agent API Service and routes them to Claude
  via C4 queue, then returns Claude's response. Runs as an HTTP service on port 4200 inside
  agent containers. This is the in-container counterpart to the API Service's container routing.
  Use when: troubleshooting agent message delivery, checking link-channel status, or understanding
  the in-container message flow.
---

# Link Channel (C4 channel: link-channel)

In-container HTTP service that bridges the Agent API Service and Claude Code.

## Architecture

```
API Service (external)
    │
    │ POST pod_ip:4200/messages
    ▼
link-channel server (PM2: zylos-link)
    │
    │ c4-receive.js --channel link-channel --endpoint <req_id>
    ▼
C4 Queue (SQLite)
    │
    │ C4 dispatcher → tmux → Claude Code
    ▼
Claude processes message
    │
    │ c4-send.js "link-channel" "<req_id>" "response"
    ▼
link-channel/scripts/send.js → writes response file
    │
    ▼
link-channel server resolves HTTP response
    │
    ▼
API Service ← { role: 'assistant', content: '...' }
```

## Service Management

```bash
pm2 status zylos-link
pm2 logs zylos-link
pm2 restart zylos-link
```

## Response Files

- Pending requests: `~/zylos/link-channel/pending/<req_id>`
- Responses: `~/zylos/link-channel/responses/<req_id>.json`
- Files are cleaned up after each request completes

## Timeout

Default request timeout: 30 seconds. Configurable via `LINK_CHANNEL_TIMEOUT_MS` env var.
