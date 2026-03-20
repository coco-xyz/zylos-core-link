---
name: link-channel
description: >-
  HxA Link channel — receives messages from the Agent API Service, queues them for Claude
  processing, and delivers responses asynchronously via callback to hxa-link. Runs as an HTTP
  service on port 4200 inside agent containers. Same async pattern as zylos-lark.
  Use when: troubleshooting agent message delivery, checking link-channel status, or understanding
  the in-container message flow.
---

# Link Channel (C4 channel: link-channel)

In-container HTTP service that bridges the Agent API Service and Claude Code.

## Architecture (Async Mode)

```
API Service (hxa-link)
    │
    │ POST pod_ip:4200/messages
    ▼
link-channel server (PM2: zylos-link)
    │
    │ Returns 202 { request_id, status: "queued" } immediately
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
link-channel/scripts/send.js
    │
    │ Reads pending/<req_id>.json for agent_id + conversation_id
    │ POST LINK_CALLBACK_URL (hxa-link /agent-callback)
    ▼
hxa-link receives response → broadcasts to frontend
```

## Service Management

```bash
pm2 status zylos-link
pm2 logs zylos-link
pm2 restart zylos-link
```

## Environment Variables

| Var | Description |
|-----|-------------|
| `LINK_CHANNEL_PORT` | Server port (default: 4200) |
| `LINK_CALLBACK_URL` | hxa-link callback endpoint (e.g. `https://jessie.coco.site/hxa-link-api/agent-callback`) |
| `LINK_SERVICE_KEY` | Bearer token for callback auth |
| `AGENT_ID` | Fallback agent ID |

## Pending Request Files

- Metadata: `~/zylos/link-channel/pending/<req_id>.json` — stores agent_id, conversation_id, content
- Cleaned up by send.js after callback delivery

## Key Difference from Sync Mode

Previously, server.js waited for Claude's response via a file watcher (30s timeout).
Now it returns immediately and send.js delivers the response asynchronously to hxa-link.
This eliminates the timeout problem when Claude takes 1-3 minutes to process.
