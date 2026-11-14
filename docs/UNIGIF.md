# UNIGIF integration

[UNIGIF](https://github.com/TimurSl/unigif) is a self-hosted, hashtag-first GIF library. When it is switched on in
**Settings → Ethernet → UNIGIF**, it replaces Telegram's saved GIFs:

- **GIF panel** lists the UNIGIF library (most used first) and pages through it while scrolling.
- **Search** in the GIF panel queries UNIGIF hashtags: `cat funny` needs both, `-dog` excludes one, the last word
  matches as a prefix.
- **Add to GIFs** on any GIF in a chat uploads it to UNIGIF (`source=telegram`, `source_id=<document id>`), where it
  lands in Unsorted. Nothing is saved to Telegram's own list. Adding the same GIF twice is deduplicated by the server.
- **Sending** a UNIGIF GIF uploads its MP4 with `DocumentAttributeAnimated` and `nosound`, so it arrives as a real
  Telegram GIF. The Telegram copy is remembered for the rest of the session, so sending it again reuses the document
  instead of uploading.
- **Live updates**: the panel follows UNIGIF's event stream, so GIFs added or tagged elsewhere (web UI, iOS
  Shortcut, bot) appear without reopening it.

Telegram GIFs come back as soon as UNIGIF is switched off.

## Setup

1. In UNIGIF, create a key with the **picker** preset (`read upload`). The client never asks for `tag`, `delete` or
   `admin`, so GIFs cannot be removed from the panel; manage the library in the UNIGIF web UI.
2. In Ethernet, open **Settings → Ethernet → UNIGIF**, enter the server URL (for example `https://gif.example.com`)
   and the key, press **Test connection**, then switch **Use UNIGIF** on.

## How it works

```
renderer (telegram-tt)                         Electron main                     UNIGIF
fetch('/ethernet/unigif/api/v1/gifs?q=cat') ─► app:// protocol handler ─► GET /api/v1/gifs?q=cat
  X-Ethernet-Unigif-Token: <session token>      checks token + allowlist        Authorization: Bearer ugf_…
<video src="/ethernet/unigif/m/{id}/preview.mp4"> ───────────────────────► GET /m/{id}/preview.mp4 (Range)
```

- `client/electron/unigif.cjs` holds the proxy. The API key stays in the main process, encrypted on disk with
  `safeStorage` (`unigif.apiKey` in `ethernet-settings.json`). Requests stay on the app origin, which the client CSP
  (`connect-src 'self'`, `media-src 'self'`) already allows, and no CORS setup is needed on the server.
- Only these routes are forwarded: `GET/POST /api/v1/gifs`, `GET /api/v1/gifs/{id}`, `POST /api/v1/gifs/{id}/use`,
  `GET /api/v1/tags/suggest`, `GET /api/v1/events` and `GET /m/{id}/{variant}`.
- Plugins run in the same page, so API routes require a per-launch session token. Core gets it over IPC; a plugin
  can only read it with the `desktop.ipc` permission. Media routes need no token because `<video>` cannot send
  headers and media ids are unguessable.
- `client/src/api/unigif/index.ts` is the renderer client: listing, search, quick add, usage pings, the event stream
  reader and the session cache of Telegram copies. `client/src/global/actions/api/unigif.ts` keeps
  `global.gifs.unigif` in sync.
