---
name: link-channel
description: >-
  HxA Link channel — receives messages from the Agent API Service, queues them for Claude
  processing, and delivers responses asynchronously via callback to hxa-link. Supports text,
  images, and files both inbound (download + Claude Read) and outbound ([MEDIA:*] prefix +
  file serving). Runs as an HTTP service on port 4200 inside agent containers.
  Use when: troubleshooting agent message delivery, checking link-channel status, or understanding
  the in-container message flow.
---

# Link Channel (C4 channel: link-channel)

In-container HTTP service that bridges the Agent API Service and Claude Code.

## Architecture

```
API Service (hxa-link)
    │
    │ POST pod_ip:4200/messages
    ▼
link-channel server (PM2: zylos-link)
    │
    │ Returns 202 { request_id, status: "queued" } immediately
    │ Downloads images/files → local storage → [Attached: /path]
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
    │                    or
    │ c4-send.js "link-channel" "<req_id>" "[MEDIA:image]/path/to/file"
    ▼
link-channel/scripts/send.js
    │
    │ Text: splits into chunks (2000 chars, markdown-aware)
    │ Media: stages file → /files/<name>, builds media_url
    │
    │ POST LINK_CALLBACK_URL (hxa-link /agent-callback)
    │   { agent_id, conversation_id, content, content_type, media_url?, chunk_index?, chunk_total? }
    ▼
hxa-link receives response → broadcasts to frontend
    │
    │ (for media) GET pod_ip:4200/files/<name> to download file
    ▼
Frontend renders message
```

## Inbound Message Formats

### Simple text
```json
{ "message": "Hello", "conversation_id": "conv-123" }
```

### Multimodal (content blocks)
```json
{
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "What is this?" },
      { "type": "image_url", "image_url": { "url": "https://..." } }
    ]
  }],
  "conversation_id": "conv-123"
}
```

### Image URL (backward compatible)
```json
{
  "message": "Describe this image",
  "image_url": "https://example.com/photo.png",
  "conversation_id": "conv-123"
}
```

### File URL
```json
{
  "message": "Summarize this document",
  "file_url": "https://example.com/doc.pdf",
  "conversation_id": "conv-123"
}
```

## Outbound Callback Format

### Text response
```json
{
  "agent_id": "agent_xxx",
  "conversation_id": "conv-123",
  "content": "Here is my response...",
  "content_type": "text",
  "request_id": "abc123"
}
```

### Chunked text (long response)
```json
{
  "agent_id": "agent_xxx",
  "conversation_id": "conv-123",
  "content": "First part...",
  "content_type": "text",
  "request_id": "abc123",
  "chunk_index": 0,
  "chunk_total": 3
}
```

### Media response
```json
{
  "agent_id": "agent_xxx",
  "conversation_id": "conv-123",
  "content": "[image]",
  "content_type": "image",
  "media_url": "http://pod_ip:4200/files/1711000000000-chart.png",
  "request_id": "abc123"
}
```

## HTTP Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/messages` | Receive inbound messages |
| GET | `/health` | Health check (returns inflight count) |
| GET | `/files/<name>` | Serve outbound media files |

## Environment Variables

| Var | Description |
|-----|-------------|
| `LINK_CHANNEL_PORT` | Server port (default: 4200) |
| `LINK_CALLBACK_URL` | hxa-link callback endpoint |
| `LINK_SERVICE_KEY` | Bearer token for callback auth |
| `AGENT_ID` | Fallback agent ID |
| `POD_IP` | Pod IP for constructing media URLs |

## Service Management

```bash
pm2 status zylos-link
pm2 logs zylos-link
pm2 restart zylos-link
```

## Data Directories

| Path | Purpose |
|------|---------|
| `~/zylos/link-channel/pending/` | Request metadata (agent_id, conversation_id) |
| `~/zylos/link-channel/images/` | Downloaded inbound images/files |
| `~/zylos/link-channel/files/` | Staged outbound media (served via /files/) |
| `~/zylos/link-channel/responses/` | Fallback file-based responses (no callback URL) |
