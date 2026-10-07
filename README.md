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
  Public STUN is configured out of the box. A TURN relay is enabled as soon as you add
  credentials in `config.js` and leave `turnEnabled` on, so two players on strict networks can
  connect. See [Strict networks](#strict-networks).
- **Chat:** DataChannels, relayed by the host. The host keeps the transcript and hands it to
  the next host if it leaves.
- **Counts:** the lobby opens a throwaway peer, asks the room's host for its roster size, and
  refreshes every 12 seconds. No hosting, no players — reads as empty.
- **Host handover:** when the host leaves — cleanly or by closing the tab — the survivors race
  for the freed host ID and one of them takes over. Audio never routes through the host, so
  nobody's call drops. A player who cannot reach the host opens the room themselves instead of
  hanging on "Connecting".
- **Volume:** every roster row except your own has a big mic button followed by a volume slider.
  The slider sets how loud that person is for you; the mic button silences them completely and
  flips between the open-mic and off-mic icons. Both are local — remembered per name in
  `localStorage` under `nomorediscord:volumes` and `nomorediscord:muted` — and nobody else is
  told about them.
- **Soundboard:** the bar between the squad panel and the controls carries three clips (Ahh,
  Horn, Toot). The three files are fetched and decoded once when you join, so a click is
  instant: it mixes the clip into your outgoing audio with a WebAudio mixer, so it travels the
  same WebRTC link as your voice — teammates hear it through their volume sliders and mic
  buttons — and it still plays while your own mic is gated off. Whoever played it is announced
  with a system line in chat, and the clicker hears the clip on their own speakers too.
  Clips are loaded with `fetch`, which browsers refuse on `file://` pages, so the soundboard
  needs a server (`npm start`); opening `index.html` from disk shows
  `Soundboard is offline: …` instead.

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
config.js
images/
sounds/
```

No build step, no environment variables. **HTTPS is required** for microphone access once you
are off localhost.

## Strict networks

WebRTC needs a path between two machines. On most home networks STUN finds one. It fails when
either side sits behind **symmetric NAT**, when a router or corporate firewall **blocks UDP**, or
when two devices share a router **without NAT hairpinning** and mDNS is unavailable. In those
cases the guest waits on "Connecting" forever, because no candidate pair can ever be built.

A **TURN relay** is the only fix: it copies the traffic for you. You have two options.

### Do I even need TURN?

Set `turnEnabled: false` in `config.js` to run on public STUN alone — no credentials are fetched
and no relay candidate is offered. Let your actual players try a few games that way. If nobody gets
stuck on "Connecting", leave it off and keep the relay traffic at zero. If someone does get stuck,
switch it back on and hand them the `?turn=1` link. `?turn=0` / `?turn=1` in the URL overrides the
config for a single run, which is handy when a player reports trouble.

### Option A — free Metered relay (no server to run)

1. Create a free account at <https://dashboard.metered.ca/signup?tool=turnserver>.
2. Copy your **API key** and **app subdomain** from the dashboard.
3. Put them in `config.js`:

```js
window.NOMOREDISCORD_CONFIG = {
  meteredApp: 'myteam',                 // -> https://myteam.metered.live
  meteredApiKey: 'YOUR_API_KEY'
};
```

The app fetches short-lived TURN credentials on join, so nothing else changes. The free tier
includes **20 GB/month** of relay traffic — voice is about 50 kbps, so that is hundreds of hours.
The key is visible to anyone who loads the page, so use a dedicated account.

### Option B — your own coturn

Fully free once you have a machine with a public IP:

```bash
docker run -d --name coturn -p 3478:3478/tcp -p 3478:3478/udp -p 5349:5349/tcp \
  coturn/coturn -n --log-file=stdout \
  --external-ip=YOUR_PUBLIC_IP \
  --realm=turn.example.com --user=nomore:PASSWORD
```

Then put the credentials in `config.js`:

```js
window.NOMOREDISCORD_CONFIG = {
  turnServers: [
    { urls: 'turn:turn.example.com:3478?transport=tcp', username: 'nomore', credential: 'PASSWORD' },
    { urls: 'turns:turn.example.com:5349?transport=tcp', username: 'nomore', credential: 'PASSWORD' }
  ]
};
```

Both plain and TLS entries are listed because UDP is the first thing strict networks drop. Commit,
push, wait for the static host deploy, and hard-refresh.

To confirm what a browser can actually gather, open the app with `?trace=1` and attempt a join.
On failure the chat log prints the candidate tally, for example:

```
Connection check: ICE candidates seen - host 6, srflx 2.
No TURN relay candidate was reachable. That is why the two of you cannot meet...
```

If the tally shows no `srflx` or `relay`, the browser has no usable route at all and TURN is
required. `?debug=1` additionally turns on PeerJS's own logging.

## Tests

Both suites drive real Chrome or Edge. Install one, or point `CHROME_PATH` at it.

```bash
npm test            # 123 checks: mesh, chat relay, counts, host handover, mic modes, sounds, archives
npm run test:layout # 24 checks: overflow, clipping and squad scrollbars at 1280 / 900 / 390 / 320 px
```

## Known limits

- The free PeerJS broker is a single point of failure. If it is down, nobody can join.
- Without your own TURN relay, strict or symmetric networks cannot connect at all.
- The lobby count needs someone hosting the room, so a room with no host reads as empty.
- Five players is the intended ceiling, not a hard cap — the badge just says `full`.
- No DTMF, no screen share, no recording. Voice and chat only.

## Docs

`audio_chat_app_development_plan.md` is the full as-built reference: architecture, message
flows, timings, and the official Dota 2 palette table.
