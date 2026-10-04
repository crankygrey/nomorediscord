# NoMoreDiscord

Peer-to-peer voice chat for dota nights. Pick a name, press **Join Roshan**, talk to your
friends. No server, no account, no install.

![stack](https://img.shields.io/badge/stack-vanilla_JS-C0392B) ![hosting](https://img.shields.io/badge/hosting-any_static_host-6BBF47)

## What you get

- **Mesh voice for up to 5 players** — audio goes browser to browser, never through a server.
- **One room: Roshan.** No room list, no codes to share.
- **Open mic by default**, with push-to-talk (hold `Space`) and a hard mute when you need it.
- **Chat that sticks around** — the transcript survives a reload, and if the host leaves it
  transfers to whoever takes over, so the next person still sees the conversation.
- **Sounds** for joins, leaves, and incoming messages.
- **Live player count** in the lobby, so you know if the team's already in.
- **Dota 2 look** — Ancient Slate surfaces, Dota Red actions, Radiant Gold accents, and a
  Juggernaut for the mascot.

## Run it locally

You only need Node 18+ for the local server; players just need a browser.

```bash
npm install     # one dev dependency, used only by the tests
npm start       # http://localhost:8787
```

Open the same URL in two windows to hear it work. `localhost` counts as a secure context, so
the microphone works without HTTPS.

To try a room name in development, add `?trace=1` — otherwise everything funnels into Roshan.

## Share a link

```
https://your-host/?name=SwiftFox
```

`?name=` prefills the name field. `?room=` is accepted but ignored in production, so old links
with `general` or `turbo` still land in Roshan.

## Controls

| Control | What it does |
| --- | --- |
| Open mic | Transmits continuously. The default. |
| Push to talk | Hold `Space`, or hold the button, to transmit. |
| Mute | Hard off, and it stays off when you switch modes. |
| Leave | Tears down every connection and returns you to the lobby. |

Chat is 280 characters with a short per-person cooldown, and the rate limit is 600 ms.

## How it works

- **Signaling:** the free public [PeerJS](https://peerjs.com) broker.
- **Voice:** WebRTC `peer.call()` connections in a full mesh. Up to 4 streams in, 4 out.
  The app also configures public STUN plus Metered Open Relay TURN so strict networks can fall
  back to relay candidates when a direct path is not possible.
- **Chat:** DataChannels, relayed by the host. The host keeps the transcript and hands it to
  the next host if it leaves.
- **Counts:** the lobby opens a throwaway peer, asks the room's host for its roster size, and
  refreshes every 12 seconds. No hosting, no players — reads as empty.
- **Host handover:** when the host leaves — cleanly or by closing the tab — the survivors race
  for the freed host ID and one of them takes over. Audio never routes through the host, so
  nobody's call drops. A player who cannot reach the host opens the room themselves instead of
  hanging on "Connecting".

## Chat history and privacy

Every browser keeps its own transcript in `localStorage` under `nomorediscord:chat:<room>`,
last 200 lines. It is never uploaded, and rooms cannot read each other's archives. Clearing
site data wipes it. While someone is hosting, chat does pass through that person's browser,
because that is how the relay works.

## Deploy

Any static host works — Netlify, Vercel, GitHub Pages, S3, a USB drive. Upload:

```
index.html
styles.css
app.js
images/
sounds/
```

No build step, no environment variables. **HTTPS is required** for microphone access once you
are off localhost.

## Tests

Both suites drive real Chrome or Edge. Install one, or point `CHROME_PATH` at it.

```bash
npm test            # 116 checks: mesh, chat relay, counts, host handover, mic modes, sounds, archives
npm run test:layout # 20 checks: overflow and clipping at 1280 / 900 / 390 / 320 px
```

## Known limits

- The free PeerJS broker is a single point of failure. If it is down, nobody can join.
- The lobby count needs someone hosting the room, so a room with no host reads as empty.
- Five players is the intended ceiling, not a hard cap — the badge just says `full`.
- No DTMF, no screen share, no recording. Voice and chat only.

## Docs

`audio_chat_app_development_plan.md` is the full as-built reference: architecture, message
flows, timings, and the official Dota 2 palette table.
