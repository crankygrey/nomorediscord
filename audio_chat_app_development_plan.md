# NoMoreDiscord — As Built

Reference for the code that actually ships. It replaces the original build plan, which
described a room-ID lobby with no chat and no open-mic default.

## What it is

Peer-to-peer voice chat for dota nights. Static files, no backend, no accounts. Audio goes
browser to browser over WebRTC; only PeerJS's free public broker is used for signaling.

- **Shipped files:** `index.html`, `styles.css`, `app.js`, `images/jug-drinks-your-tears.png`,
  `sounds/` (join, out, message)
- **Dev-only:** `tests/`, `package.json`, `node_modules/` (puppeteer-core)
- **Squad size:** up to 5 (`MAX_SQUAD` in `app.js`)
- **Theme:** Dota 2 — single room named **Roshan**, Dire red + gold palette

## Flow

1. **Lobby** — enter a name (required, max 16, saved in `localStorage` under
   `nomorediscord:name`), see the live player count for Roshan, press **Join Roshan**.
2. **Join** — the app claims the room host ID `nomorediscord-<room>-<hash>-host`
   (djb2 hash of the room id). First claimer becomes host; if the ID is taken the app joins
   as a regular peer. Either way it dials every existing member to form the mesh.
3. **Session** — open mic is on by default, chat is relayed by the host, and leaving tears
   down every peer call cleanly.

### URL parameters

| Parameter | Effect |
| --- | --- |
| `?room=<id>` | Selects a room. Unknown ids are ignored (single-room app); stale `general`/`turbo` links still land in Roshan. |
| `?name=<name>` | Prefills the name field. |
| `?trace=1` / `?debug=1` | Verbose logging, and unlocks arbitrary room ids. Used by the test suite to get a private room instead of fighting over Roshan. |

## Voice

- `getUserMedia` with `echoCancellation`, `noiseSuppression`, `autoGainControl`, `channelCount: 1`.
- ICE uses three STUN servers plus a TURN relay (`turn:global.relay.metered.ca`, TCP first) in
  `PEER_OPTIONS`. The relay is not optional in practice: without it, two players behind
  symmetric NAT or a network that blocks UDP can never connect, even though the same build
  works fine on localhost.
- Media rides `peer.call()` / `call.answer()`; DataConnections carry chat and signaling only.
- Incoming calls are answered with the local stream, with retries if no audio arrives.
- Modes: **open mic** (default, always transmitting), **push to talk** (hold Space or the
  button), plus a hard **mute** that survives mode switches.
- Mic access needs a secure context: HTTPS, or localhost.

## Chat

- Relayed through the host over the DataConnection mesh; everyone else sees a system line
  while the host is unreachable.
- 280 characters per message, 600 ms per-sender cooldown, 60 lines kept in the DOM.
- Rendered with `textContent`, so messages can never inject markup.
- Consecutive messages from the same person hide the repeated name (`data-grouped`).

### Where history lives

Three copies, none of them on a server:

| Copy | Lives in | Survives |
| --- | --- | --- |
| `state.chatHistory` | The host's RAM, last 100 lines | Until the host leaves |
| `state.storedLines` → `localStorage` | Every browser, last 200 lines per room under `nomorediscord:chat:<room>` | Reload, closing the tab, rejoining |
| DOM | The visible log, last 60 lines | Until the page is closed |

On join, a browser loads its own archive, renders it silently, then merges it with whatever
the host sends in `welcome`. Lines are deduplicated by id and sorted by timestamp, so merging
the same message from three sources is harmless.

When the host leaves, the survivors hand their archives to whoever takes over: on every
connection to a host entry, a browser sends a `resume` message with its stored lines, and the
new host merges them into its own memory and store. That is why a late joiner still sees the
conversation after a handover.

Nothing is written to `localStorage` for system lines, and a room's archive is only ever read
back into the same room, so nothing leaks between rooms. Clearing site data wipes it; there is
no UI to delete a single archive yet.

## Palette

Official Dota 2 colors. Keep this table as the source of truth for any new surface.

| Token | Name | Hex | RGB | Used for |
| --- | --- | --- | --- | --- |
| `--accent` | Dota Red | `#BF2E1A` | 191, 46, 26 | Primary actions (Join Roshan, Send), active highlights, logos |
| `--accent-2` | Radiant Gold | `#E7A34B` | 231, 163, 75 | Special notifications, prominent badges, active mic mode, focus rings |
| `--bg` | Ancient Slate | `#181818` | 24, 24, 24 | App background |
| `--card` | Fog of War Gray | `#232323` | 35, 35, 35 | Cards, panels, chat containers |
| `--line` | Rune Border | `#3C3C3C` | 60, 60, 60 | Dividers and borders |
| `--text` | Scroll Parchment | `#F4E9D6` | 244, 233, 214 | Primary text |
| `--muted` | Spectator Gray | `#B8B8B8` | 184, 184, 184 | Names, timestamps, secondary text |
| — | Creep Gray | `#7A7A7A` | 122, 122, 122 | Placeholders, inactive elements |
| `--good` | Victory Green | `#6BBF47` | 107, 191, 71 | Online, connected, success |
| `--bad` | Defeat Red | `#D9483B` | 217, 72, 59 | Errors, disconnected |
| `--warn` | Warning Amber | `#F3C13A` | 243, 193, 58 | Alerts |

Contrast ratios that matter, measured: Scroll Parchment on Dota Red **4.83:1**, Ancient Slate
on Radiant Gold **8.23:1** — both pass WCAG AA for normal text. Dota Red on Fog of War Gray is
2.71:1, so red is never used for text on a panel.

Gradient policy: flat fills only on buttons. Depth comes from a 1px lighter border, a 1px
`inset` top highlight, and a soft shadow — never a gradient fill.

Adoption status: the three action buttons (`.btn-primary`, active `.seg`) use the official
Dota Red and Radiant Gold values. The rest of the app still runs on the earlier hand-tuned
values in `:root` (`#d0392b` red, `#e8b13a` gold, `#0c0807` background); migrating them to
this palette is a pending pass.

## Sounds

`sounds/` holds three short clips, played by `playSound()` through cached `Audio` elements at
40% volume. Files are only fetched the first time a cue fires.

| Clip | Fires when |
| --- | --- |
| `join.mp3` | You enter a room, and whenever another player joins |
| `out.mp3` | You leave, and whenever another player leaves |
| `message.mp3` | An incoming chat message |

Your own chat messages and replayed history stay silent, so joining a busy room does not fire
40 notifications. Browser autoplay rules are satisfied because playback is always a result of
the Join or Leave click.

## Counts

No backend, so the lobby asks the room's host directly: it opens a throwaway PeerJS probe
peer, connects to the host ID with `{ probe: true }`, and the host replies with its roster
size. A room with no host answers as empty. Refreshed every 12 s.

## Resilience

- Host leaves → survivors race for the freed host ID; the winner becomes host, everyone keeps
  their existing audio, and new joiners connect through them. The winner also inherits the
  squad's chat archive.
- If someone else claims the room ID, the app warns but stays in the squad.
- Per-peer status (`connecting` / `connected` / `unreachable`), media retry timers, and
  recoverable errors for denied mic, unreachable peers, and failed handovers.

## Tests

```bash
npm start           # dev server on http://localhost:8787
npm test            # 116 checks: mesh, chat, counts, host handover, mic modes, sounds, archives
npm run test:layout # 20 checks: overflow and clipping at 1280 / 900 / 390 / 320 px
```

Both suites drive real Chrome/Edge through puppeteer-core, each in a private `?trace=1`
room, and close their browsers on the way out. There are no unit tests; everything is
verified end to end in a browser.

## Deploying

Upload `index.html`, `styles.css`, `app.js`, `images/`, and `sounds/` to any static host
(Netlify, Vercel, GitHub Pages, S3). HTTPS is required for microphone access once you leave
localhost. Nothing else is needed — no build step, no environment variables.

## Limits worth knowing

- The free PeerJS broker is a single point of failure; if it is down, nobody can join.
- Counts need someone hosting the room, so an empty room reads as empty rather than unknown.
- 5 players is the intended ceiling, but there is no hard join rejection — the count badge
  just shows `full` at 5.