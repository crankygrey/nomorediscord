'use strict';

const QUERY = new URLSearchParams(location.search);
const TRACE = QUERY.has('trace') || QUERY.has('debug');
const DEBUG_ROOMS = TRACE;

// A TURN relay is what lets two players on strict networks meet at all. If both
// sit behind symmetric NAT, or either router blocks UDP, STUN alone can never
// produce a working candidate pair and the guest hangs on "Connecting" forever.
//
// The easiest fix is the free Metered Open Relay (20 GB/month, no server to run):
// create a free account, then put the API key and app name in config.js and the
// TURN credentials are fetched at join time. You can also hardcode your own
// coturn with config.js `turnServers` (see README "Strict networks").
const RUNTIME_CONFIG = (typeof window !== 'undefined' && window.NOMOREDISCORD_CONFIG) || {};

// A relay is a last resort: it copies the voice through a server, which costs a
// little delay but works on networks that block the direct line between players.
// It is off by default so nobody pays for it until they need it. Three sources,
// in order: `?turn=0` / `?turn=1` on the URL (one run), the checkbox in the lobby
// (remembered per browser), then `turnEnabled` in config.js.
const STUN_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'stun:stun.cloudflare.com:3478' }
];
const TURN_SERVERS = Array.isArray(RUNTIME_CONFIG.turnServers) ? RUNTIME_CONFIG.turnServers : [];
const METERED_APP = String(RUNTIME_CONFIG.meteredApp || '').trim();
const METERED_API_KEY = String(RUNTIME_CONFIG.meteredApiKey || '').trim();
const RELAY_STORAGE_KEY = 'nomorediscord:relay';
const VOLUME_STORAGE_KEY = 'nomorediscord:volumes';
const MUTED_STORAGE_KEY = 'nomorediscord:muted';

let turnEnabled = resolveTurnPreference();
let meteredServers = [];

const PEER_OPTIONS = {
  debug: QUERY.has('debug') ? 2 : 0,
  config: {
    iceCandidatePoolSize: 4,
    iceServers: STUN_SERVERS.slice()
  }
};

applyTurnPreference();

function resolveTurnPreference() {
  if (QUERY.has('turn')) {
    return QUERY.get('turn') !== '0' && QUERY.get('turn') !== 'false';
  }
  const stored = readStoredRelayPreference();
  if (stored !== null) {
    return stored;
  }
  return RUNTIME_CONFIG.turnEnabled !== false;
}

function readStoredRelayPreference() {
  try {
    const raw = window.localStorage.getItem(RELAY_STORAGE_KEY);
    return raw === null ? null : raw === '1';
  } catch (error) {
    return null;
  }
}

function saveRelayPreference(enabled) {
  try {
    window.localStorage.setItem(RELAY_STORAGE_KEY, enabled ? '1' : '0');
  } catch (error) {
    void error;
  }
}

// Per-person volume, remembered across reloads under `nomorediscord:volumes`.
// Keyed by lowercased name so a rejoin with the same name keeps its setting.
function peerKey(name) {
  return String(name || '').trim().toLowerCase();
}

function loadVolumes() {
  try {
    const raw = window.localStorage.getItem(VOLUME_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    void error;
    return {};
  }
}

function volumeFor(name) {
  const stored = loadVolumes()[peerKey(name)];
  const numeric = Number(stored);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 1 ? numeric : 1;
}

function saveVolume(name, volume) {
  try {
    const volumes = loadVolumes();
    volumes[peerKey(name)] = volume;
    window.localStorage.setItem(VOLUME_STORAGE_KEY, JSON.stringify(volumes));
  } catch (error) {
    void error;
  }
}

// Silencing one loud player is local: it only mutes that person's audio in this
// browser, under `nomorediscord:muted`, so it survives a reload like the slider.
function loadMutedPeers() {
  try {
    const raw = window.localStorage.getItem(MUTED_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    void error;
    return {};
  }
}

function mutedFor(name) {
  return Boolean(loadMutedPeers()[peerKey(name)]);
}

function saveMuted(name, muted) {
  try {
    const store = loadMutedPeers();
    if (muted) {
      store[peerKey(name)] = true;
    } else {
      delete store[peerKey(name)];
    }
    window.localStorage.setItem(MUTED_STORAGE_KEY, JSON.stringify(store));
  } catch (error) {
    void error;
  }
}

// Rebuilds the ICE server list, so ticking the checkbox in the lobby takes effect
// for the peer that opens next. A page loaded with `?turn=0` stays STUN only: the
// URL is the operator's call, not the player's.
function applyTurnPreference() {
  PEER_OPTIONS.config.iceServers = turnEnabled
    ? [...STUN_SERVERS, ...TURN_SERVERS, ...meteredServers]
    : STUN_SERVERS.slice();
  return PEER_OPTIONS.config.iceServers;
}

let turnReady = null;

// Metered hands out short-lived TURN credentials, so they are fetched once per
// page load and cached on PEER_OPTIONS before any peer is opened. A failure is
// non-fatal: voices still connect over STUN when the network allows it. Relaying
// being off is not cached, so ticking the checkbox in the lobby still fetches.
function ensureTurnServers() {
  if (meteredServers.length) {
    return Promise.resolve();
  }
  if (!turnEnabled) {
    trace('turn', 'relay switched off, STUN only');
    return Promise.resolve();
  }
  if (!METERED_APP || !METERED_API_KEY) {
    return Promise.resolve();
  }
  if (turnReady) {
    return turnReady;
  }
  turnReady = (async () => {
    const url = `https://${METERED_APP}.metered.live/api/v1/turn/credentials`
      + `?apiKey=${encodeURIComponent(METERED_API_KEY)}`;
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const servers = await response.json();
      if (Array.isArray(servers) && servers.length) {
        meteredServers = servers;
        applyTurnPreference();
        trace('turn', `loaded ${servers.length} Metered relay entries`);
      }
    } catch (error) {
      trace('turn', 'credential fetch failed', error && error.message);
    }
  })();
  return turnReady;
}

function hasTurnRelay() {
  return PEER_OPTIONS.config.iceServers.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((value) => typeof value === 'string' && value.startsWith('turn'));
  });
}

const MIC_CONSTRAINTS = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1
  },
  video: false
};

const TIMEOUTS = {
  peerConnect: 30000,
  streamArrival: 15000,
  parkedCall: 25000,
  mediaRetry: 1500,
  mediaAttempts: 3,
  hostReclaim: [1200, 4000, 10000],
  hostDial: 45000,
  probe: 4500
};

const ROOMS = [
  { id: 'roshan', label: 'Roshan' }
];

const HOST_PREFIX = 'nomorediscord';
const MAX_FEED = 60;
const MAX_CHAT_HISTORY = 100;
const MAX_STORED_LINES = 200;
const CHAT_STORE_PREFIX = 'nomorediscord:chat:';
const MAX_CHAT = 280;
const MAX_NAME = 16;
const MAX_SQUAD = 5;
const CHAT_COOLDOWN = 600;
const LOBBY_REFRESH = 12000;
const NAME_STORAGE_KEY = 'nomorediscord:name';
const SOUND_FILES = {
  join: 'sounds/join.mp3',
  out: 'sounds/out.mp3',
  message: 'sounds/message.mp3'
};
const SOUND_VOLUME = 0.4;
const soundClips = new Map();

// Soundboard clips ride the same WebRTC stream as the microphone (buildMixer),
// so they respect the per-player volume sliders and mute buttons on the far side.
const SOUNDBOARD = [
  { id: 'ahh', file: 'ahh', label: 'Ahh' },
  { id: 'horn', file: 'failure_trumpet', label: 'Sad horn' },
  { id: 'toot', file: 'fart', label: 'Toot' }
];
const SOUNDBOARD_VOLUME = 0.9;

const state = {
  peer: null,
  probePeer: null,
  probeTimer: null,
  roomCounts: {},
  forcedRoom: null,
  roomId: '',
  hostId: '',
  name: '',
  isHost: false,
  joined: false,
  busy: false,
  leaving: false,
  localStream: null,
  mixer: null,
  soundActive: 0,
  mode: 'open',
  userMuted: false,
  pttActive: false,
  peers: new Map(),
  pendingCalls: new Map(),
  probeTargets: new Map(),
  chatHistory: [],
  storedLines: [],
  lastChatAt: 0,
  stickToChat: true,
  status: 'connecting',
  migrating: false,
  reconnectTried: false
};

const dom = {};

window.addEventListener('DOMContentLoaded', init);

function init() {
  installIceTracing();
  ensureTurnServers();
  dom.relayToggle = document.getElementById('relay-toggle');
  dom.relayToggle.checked = turnEnabled;
  dom.relayToggle.disabled = QUERY.has('turn');
  dom.relayToggle.addEventListener('change', () => {
    turnEnabled = dom.relayToggle.checked;
    saveRelayPreference(turnEnabled);
    applyTurnPreference();
    trace('turn', turnEnabled ? 'relay switched on by player' : 'relay switched off by player');
    if (turnEnabled) {
      ensureTurnServers();
    }
  });
  dom.lobby = document.getElementById('lobby');
  dom.session = document.getElementById('session');
  dom.joinForm = document.getElementById('join-form');
  dom.joinBtn = document.getElementById('join-btn');
  dom.nameInput = document.getElementById('name-input');
  dom.roomCounts = new Map(
    ROOMS.map((room) => [room.id, document.getElementById(`count-${room.id}`)])
  );
  dom.lobbyError = document.getElementById('lobby-error');
  dom.sessionError = document.getElementById('session-error');
  dom.sessionErrorText = document.getElementById('session-error-text');
  dom.alertClose = document.getElementById('alert-close');
  dom.roomName = document.getElementById('room-name');
  dom.callsign = document.getElementById('callsign');
  dom.statusChip = document.getElementById('status-chip');
dom.micChip = document.getElementById('mic-chip');
  dom.peerList = document.getElementById('peer-list');
  dom.peerEmpty = document.getElementById('peer-empty');
  dom.peerCount = document.getElementById('peer-count');
  dom.chatLog = document.getElementById('chat-log');
  dom.chatForm = document.getElementById('chat-form');
  dom.chatInput = document.getElementById('chat-input');
  dom.chatHint = document.getElementById('chat-hint');
  dom.ptt = document.getElementById('ptt');
  dom.muteBtn = document.getElementById('mute-btn');
  dom.modePtt = document.getElementById('mode-ptt');
  dom.modeOpen = document.getElementById('mode-open');
  dom.leaveBtn = document.getElementById('leave-btn');
  dom.controlsHint = document.getElementById('controls-hint');
  dom.audioSinks = document.getElementById('audio-sinks');
  dom.browserNote = document.getElementById('browser-note');

  dom.nameInput.value = readSavedName();

  dom.joinForm.addEventListener('submit', onJoinSubmit);
  dom.alertClose.addEventListener('click', () => hideAlert(dom.sessionError));
  dom.chatForm.addEventListener('submit', onChatSubmit);
  dom.chatInput.addEventListener('keydown', onChatInputKeydown);
  dom.chatInput.addEventListener('input', autoGrowChatInput);
  dom.chatLog.addEventListener('scroll', () => {
    const distance = dom.chatLog.scrollHeight - dom.chatLog.scrollTop - dom.chatLog.clientHeight;
    state.stickToChat = distance < 32;
  });
  dom.muteBtn.addEventListener('click', toggleMute);
  dom.modePtt.addEventListener('click', () => setMode('ptt'));
  dom.modeOpen.addEventListener('click', () => setMode('open'));
  dom.leaveBtn.addEventListener('click', () => leaveRoom());
  dom.soundboard = document.getElementById('soundboard');
  if (dom.soundboard) {
    dom.soundboard.addEventListener('click', (event) => {
      const button = event.target.closest('.snd');
      if (button && dom.soundboard.contains(button)) {
        triggerSoundboard(button);
      }
    });
  }

  dom.ptt.addEventListener('pointerdown', onPttPointerDown);
  dom.ptt.addEventListener('pointerup', () => setPtt(false));
  dom.ptt.addEventListener('pointercancel', () => setPtt(false));
  dom.ptt.addEventListener('lostpointercapture', () => setPtt(false));
  dom.ptt.addEventListener('contextmenu', (event) => event.preventDefault());

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  window.addEventListener('focus', () => refreshRoomCounts());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshRoomCounts();
    }
  });
  window.addEventListener('blur', () => setPtt(false));
  window.addEventListener('beforeunload', () => {
    state.leaving = true;
    if (state.peer) {
      try {
        state.peer.destroy();
      } catch (error) {
        void error;
      }
    }
    stopCountPolling();
  });

  applyRoomFromUrl();
  updateJoinLabel();
  dom.nameInput.focus();

  dom.browserNote.textContent = typeof Peer === 'undefined'
    ? 'PeerJS failed to load - check your connection and refresh'
    : 'Works in Chrome, Edge, Firefox and Safari 15+';

  if (typeof Peer === 'undefined') {
    showAlert(dom.lobbyError, 'Could not load the PeerJS library. Refresh the page or check your network.', 'error');
    dom.joinBtn.disabled = true;
    return;
  }

  startCountPolling();
}

function applyRoomFromUrl() {
  const requested = (QUERY.get('room') || '').trim().toLowerCase();
  if (!requested) {
    return;
  }

  // Debug sessions (?trace=1 / ?debug=1) may point at any room id so automated
  // tests get a private room instead of fighting over the real one.
  if (!ROOMS.some((room) => room.id === requested) && DEBUG_ROOMS) {
    state.forcedRoom = { id: requested, label: requested };
  }
}

function updateJoinLabel() {
  const room = selectedRoom();
  if (!room) {
    return;
  }
  dom.joinBtn.textContent = state.busy ? 'Connecting...' : `Join ${room.label}`;
  renderRoomCounts();
}

function selectedRoom() {
  return state.forcedRoom || ROOMS[0];
}

function roomById(id) {
  const clean = String(id || '').trim().toLowerCase();
  return ROOMS.find((room) => room.id === clean)
    || (state.forcedRoom && state.forcedRoom.id === clean ? state.forcedRoom : null);
}

function onJoinSubmit(event) {
  event.preventDefault();
  joinRoom();
}

async function joinRoom() {
  if (state.busy || state.joined) {
    return;
  }

  const name = sanitizeName(dom.nameInput.value).slice(0, MAX_NAME);
  if (name.length < 2) {
    showAlert(dom.lobbyError, 'Type a name (at least two characters) so friends know who is talking.', 'error');
    dom.nameInput.focus();
    dom.nameInput.select();
    return;
  }

  const room = selectedRoom();
  hideAlert(dom.lobbyError);
  saveName(name);
  stopCountPolling();
  setBusy(true);

  try {
    if (!window.isSecureContext) {
      throw new Error('Microphone access needs a secure context. Use localhost or serve the site over HTTPS.');
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      throw new Error('This browser does not expose microphone capture (navigator.mediaDevices).');
    }

    state.name = name;
    state.roomId = room.id;
    state.hostId = hostIdFor(room.id);
    state.leaving = false;
    state.reconnectTried = false;
state.chatHistory = [];
    state.storedLines = loadStoredLines(state.roomId);
    dom.chatLog.textContent = '';
    dom.chatInput.value = '';
    autoGrowChatInput();

    if (state.storedLines.length) {
      state.chatHistory = state.storedLines.slice(-MAX_CHAT_HISTORY);
      adoptChatHistory(state.storedLines);
    }

    state.localStream = buildMixer(await acquireMic());
    applyAudioState();

    await ensureTurnServers();

    let peer = null;
    let isHost = false;
    try {
      peer = await openPeer(state.hostId);
      isHost = true;
    } catch (error) {
      if (!isUnavailableId(error)) {
        throw error;
      }
      peer = await openPeer();
      isHost = false;
    }

    state.peer = peer;
    state.isHost = isHost;
    state.joined = true;

    showSession();

    if (isHost) {
      state.status = 'host';
      logEvent(`You opened ${room.label}. Mind the ramps.`);
    } else {
      state.status = 'connecting';
      logEvent(`Connecting to the ${room.label} host...`);
      try {
        await dialHost();
      } catch (error) {
        if (state.leaving || !state.joined) {
          throw error;
        }
        const claimed = await claimHostSeat('Nobody was answering, so you opened the room. Guard the throne.');
        if (!claimed) {
          throw error;
        }
      }
    }

    playSound('join');

    render();
  } catch (error) {
    logEvent('');
    resetSession();
    showAlert(dom.lobbyError, error && error.message ? error.message : 'Could not join the room.', 'error');
    startCountPolling();
  } finally {
    setBusy(false);
  }
}

async function acquireMic() {
  try {
    return await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
  } catch (error) {
    const messages = {
      NotAllowedError: 'Microphone permission was denied. Allow mic access for this site, then join again.',
      PermissionDeniedError: 'Microphone permission was denied. Allow mic access for this site, then join again.',
      NotFoundError: 'No microphone was found. Plug in an input device and try again.',
      DevicesNotFoundError: 'No microphone was found. Plug in an input device and try again.',
      NotReadableError: 'Your microphone is busy in another application. Close it and try again.',
      TrackStartError: 'Your microphone is busy in another application. Close it and try again.',
      OverconstrainedError: 'Your microphone rejected the requested audio settings. Try a different input device.',
      SecurityError: 'The browser blocked microphone access on this page.'
    };
    const message = messages[error && error.name] || 'Could not access the microphone. Check your input device and permissions.';
    throw new Error(message);
  }
}

// Everyone hears the outgoing stream, so the microphone and the soundboard
// are mixed into a single track: a clip plays even while the mic itself is
// gated off. Returns the stream that PeerJS should send.
function buildMixer(micStream) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) {
    return micStream;
  }

  try {
    const ctx = new AudioCtx();
    const dest = ctx.createMediaStreamDestination();
    const micSource = ctx.createMediaStreamSource(micStream);
    const micGain = ctx.createGain();
    const boardGain = ctx.createGain();

    micGain.gain.value = 1;
    boardGain.gain.value = SOUNDBOARD_VOLUME;
    micSource.connect(micGain);
    micGain.connect(dest);
    boardGain.connect(dest);

    state.mixer = { ctx, micStream, micGain, boardGain, clips: new Map() };
    return dest.stream;
  } catch (error) {
    void error;
    state.mixer = null;
    return micStream;
  }
}

function openPeer(preferredId) {
  return new Promise((resolve, reject) => {
    if (typeof Peer === 'undefined') {
      reject(new Error('The PeerJS library is not available.'));
      return;
    }

    let peer;
    try {
      peer = preferredId ? new Peer(preferredId, PEER_OPTIONS) : new Peer(PEER_OPTIONS);
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;

    const onEarlyError = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        peer.destroy();
      } catch (destroyError) {
        void destroyError;
      }
      reject(error);
    };

    peer.on('error', onEarlyError);

    peer.on('open', () => {
      if (settled) {
        return;
      }
      settled = true;
      peer.off('error', onEarlyError);
      registerPeer(peer);
      resolve(peer);
    });
  });
}

function registerPeer(peer) {
  peer.on('connection', (conn) => {
    if (!state.joined || state.leaving) {
      conn.close();
      return;
    }
    if (conn.metadata && conn.metadata.probe) {
      answerCountProbe(conn);
      return;
    }
    acceptConnection(conn);
  });

  peer.on('call', (call) => {
    const entry = state.peers.get(call.peer);
    if (entry) {
      answerCall(entry, call);
      return;
    }
    parkCall(call);
  });

  peer.on('disconnected', () => {
    if (peer === state.peer && canReactToPeerEvents()) {
      onSignallingLost();
    }
  });

  peer.on('close', () => {
    if (peer === state.peer && canReactToPeerEvents()) {
      onSignallingLost(true);
    }
  });

  peer.on('error', (error) => {
    if (peer === state.peer) {
      handlePeerError(error);
    }
  });
}

function parkCall(call) {
  const existing = state.pendingCalls.get(call.peer);
  if (existing && existing.call !== call) {
    try {
      existing.call.close();
    } catch (error) {
      void error;
    }
  }
  const parked = { call, timer: null };
  parked.timer = setTimeout(() => {
    if (state.pendingCalls.get(call.peer) === parked) {
      state.pendingCalls.delete(call.peer);
      try {
        call.close();
      } catch (error) {
        void error;
      }
    }
  }, TIMEOUTS.parkedCall);
  state.pendingCalls.set(call.peer, parked);
  call.on('close', () => {
    if (state.pendingCalls.get(call.peer) === parked) {
      clearTimeout(parked.timer);
      state.pendingCalls.delete(call.peer);
    }
  });
  call.on('error', () => {});
}

function takeParkedCall(peerId) {
  const parked = state.pendingCalls.get(peerId);
  if (!parked) {
    return null;
  }
  clearTimeout(parked.timer);
  state.pendingCalls.delete(peerId);
  return parked.call;
}

function answerCall(entry, call) {
  if (!state.localStream || state.leaving) {
    try {
      call.close();
    } catch (error) {
      void error;
    }
    return;
  }
  try {
    call.answer(state.localStream);
  } catch (error) {
    void error;
  }
  wireMediaCall(entry, call);
}

function startMediaCall(entry) {
  if (!state.peer || !state.localStream || state.leaving) {
    return;
  }
  if (entry.call && entry.call.open) {
    return;
  }
  entry.mediaStarted = true;

  let call;
  try {
    call = state.peer.call(entry.id, state.localStream);
  } catch (error) {
    entry.mediaStarted = false;
    void error;
    return;
  }
  wireMediaCall(entry, call);
}

function wireMediaCall(entry, call) {
  entry.call = call;

  call.on('stream', (stream) => attachStream(entry, stream));

  call.on('close', () => {
    if (entry.call !== call) {
      return;
    }
    entry.call = null;
    if (state.peers.get(entry.id) !== entry || entry.status !== 'connected' || state.leaving) {
      return;
    }
    if (entry.hasMedia) {
      detachAudio(entry);
      entry.hasMedia = false;
      if (!entry.silent) {
        logEvent(`Voice link to ${entry.name} dropped, renegotiating...`);
      }
    }
    entry.silent = false;
    entry.mediaStarted = false;
    setTimeout(() => {
      if (state.peers.get(entry.id) !== entry || entry.status !== 'connected' || state.leaving) {
        return;
      }
      startMediaCall(entry);
      armMediaWatch(entry);
    }, TIMEOUTS.mediaRetry);
  });

  call.on('error', () => {});
}

function armMediaWatch(entry) {
  clearTimeout(entry.mediaTimer);
  entry.mediaTimer = setTimeout(() => {
    if (state.peers.get(entry.id) !== entry || entry.status !== 'connected' || state.leaving || entry.hasMedia) {
      return;
    }
    entry.mediaRetries += 1;
    if (entry.mediaRetries > TIMEOUTS.mediaAttempts) {
      logEvent(`No voice link to ${entry.name}. They may need to rejoin.`);
      render();
      return;
    }
    logEvent(`No voice from ${entry.name} yet, retrying the audio link...`);
    entry.call = null;
    entry.mediaStarted = false;
    startMediaCall(entry);
    armMediaWatch(entry);
  }, TIMEOUTS.streamArrival + Math.random() * 1500);
}

function canReactToPeerEvents() {
  return state.joined && !state.leaving && !state.migrating;
}

function dialHost() {
  return new Promise((resolve, reject) => {
    const entry = dialPeer({ id: state.hostId, name: 'Host', isHost: true });
    if (!entry) {
      reject(new Error('Could not start a connection to the room host.'));
      return;
    }

    // The host dial owns its own deadline. The generic per-peer timer would fire
    // first and treat a host we never reached as a host that just left.
    clearTimeout(entry.connectTimer);
    entry.connectTimer = null;

    const slowNote = setTimeout(() => {
      logEvent('Still trying to reach the host. Strict networks can take a while...');
    }, TIMEOUTS.hostDial / 2);

    const timer = setTimeout(() => {
      clearTimeout(slowNote);
      dropPeer(entry);
      logIceDiagnosis();
      reject(new Error(turnEnabled
        ? 'Could not reach the room host. If someone is already hosting, your network is blocking the direct voice link, and the relay could not reach you either. Otherwise, try again in a moment.'
        : 'Could not reach the room host. If someone is already hosting, your network is blocking the direct voice link. Tick "Use a relay server" under Stuck on "Connecting"? next time, or try again in a moment.'));
    }, TIMEOUTS.hostDial);

    entry.conn.once('open', () => {
      clearTimeout(timer);
      clearTimeout(slowNote);
      if (state.status !== 'host') {
        state.status = 'live';
      }
      resolve();
    });

    entry.conn.once('error', (error) => {
      clearTimeout(timer);
      clearTimeout(slowNote);
      reject(error);
    });
  });
}

function promoteToHost(candidate, message) {
  const previous = state.peer;
  state.peer = candidate;
  state.isHost = true;
  state.migrating = false;
  state.reconnectTried = false;
  try {
    if (previous && typeof previous.disconnect === 'function') {
      previous.disconnect();
    }
  } catch (error) {
    void error;
  }
  state.status = 'host';
  hideAlert(dom.sessionError);
  state.chatHistory = mergeChatLines(state.chatHistory, state.storedLines);
  logEvent(message || 'You are now hosting this room. Guard the throne.');
  broadcast({ type: 'host', peer: { id: candidate.id, name: state.name } });
  render();
}

async function claimHostSeat(message) {
  if (state.leaving || !state.joined || state.isHost || state.migrating) {
    return false;
  }

  logEvent('The host is not answering. Opening the room yourself...');
  render();

  for (const delay of [0, ...TIMEOUTS.hostReclaim]) {
    if (delay) {
      await sleep(delay);
    }
    if (state.leaving || !state.joined || state.isHost) {
      return false;
    }
    let candidate = null;
    try {
      candidate = await openPeer(state.hostId);
    } catch (error) {
      void error;
      continue;
    }
    promoteToHost(candidate, message);
    return true;
  }

  return false;
}

function acceptConnection(conn) {
  const id = conn.peer;
  const existing = state.peers.get(id);
  if (existing && existing.conn && existing.conn !== conn) {
    dropPeer(existing);
  }

  const metadata = conn.metadata || {};
  const entry = createEntry(conn, {
    id,
    name: sanitizeName(metadata.name),
    isHost: isHostId(id)
  });

  state.peers.set(id, entry);
  wireConnection(entry);
  render();
  return entry;
}

function dialPeer(info) {
  if (!state.peer || state.leaving) {
    return null;
  }

  const id = info.id;
  if (!id || id === state.peer.id) {
    return null;
  }

  const existing = state.peers.get(id);
  if (existing) {
    return existing;
  }

  const cleanName = sanitizeName(info.name);
  let superseded = null;
  if (cleanName) {
    superseded = Array.from(state.peers.values()).find(
      (entry) => entry.id !== id && !entry.isHost && entry.name === cleanName
    ) || null;
    if (superseded) {
      superseded.silent = true;
      dropPeer(superseded);
    }
  }

  let conn;
  try {
    conn = state.peer.connect(id, {
      reliable: true,
      serialization: 'json',
      metadata: { name: state.name }
    });
  } catch (error) {
    logEvent(`Could not reach ${cleanName || 'a player'} (${error && error.message ? error.message : 'unknown error'}).`);
    return null;
  }

  const entry = createEntry(conn, {
    id,
    name: cleanName,
    isHost: Boolean(info.isHost),
    dialedOut: true
  });

  if (superseded) {
    entry.silent = true;
  }

  state.peers.set(id, entry);
  entry.connectTimer = setTimeout(() => {
    if (entry.status !== 'connected') {
      logEvent(`Could not reach ${entry.name || 'a player'}. A strict network may be blocking the link.`);
      removePeer(entry, { log: false });
    }
  }, TIMEOUTS.peerConnect);

  wireConnection(entry);
  render();
  return entry;
}

function ensureEntry(peerId) {
  let entry = state.peers.get(peerId);
  if (!entry) {
    entry = createEntry(null, { id: peerId, name: 'Player', isHost: isHostId(peerId) });
    state.peers.set(peerId, entry);
  }
  return entry;
}

function createEntry(conn, data) {
  const name = sanitizeName(data.name) || 'Player';
  return {
    id: data.id,
    name,
    volume: volumeFor(name),
    volumeTouched: false,
    muted: mutedFor(name),
    muteTouched: false,
    conn,
    status: 'connecting',
    isHost: Boolean(data.isHost),
    dialedOut: Boolean(data.dialedOut),
    hasMedia: false,
    mediaStarted: false,
    mediaRetries: 0,
    call: null,
    stream: null,
    audioEl: null,
    connectTimer: null,
    mediaTimer: null
  };
}

function wireConnection(entry) {
  const conn = entry.conn;

  conn.on('open', () => onPeerOpen(entry));
  conn.on('data', (message) => {
    if (message && typeof message === 'object') {
      handleMessage(entry, message);
    }
  });
  conn.on('stream', (stream) => attachStream(entry, stream));
  conn.on('close', () => onPeerClosed(entry));
  conn.on('error', (error) => onConnectionError(entry, error));
}

function onPeerOpen(entry) {
  clearTimeout(entry.connectTimer);
  entry.connectTimer = null;
  entry.status = 'connected';

  sendMessage(entry, { type: 'meta', name: state.name });
  sendResume(entry);

  if (entry.dialedOut) {
    startMediaCall(entry);
  } else {
    const parked = takeParkedCall(entry.id);
    if (parked) {
      answerCall(entry, parked);
    }
  }

  armMediaWatch(entry);

  if (state.isHost && !entry.announced) {
    entry.announced = true;
    sendMessage(entry, {
      type: 'welcome',
      peers: connectedRoster(entry.id),
      chat: state.chatHistory.slice(-MAX_CHAT_HISTORY)
    });
    broadcast({ type: 'join', peer: { id: state.peer.id, name: state.name } }, entry.id);
    logEvent(`${entry.name} joined.`);
    playSound('join');
  }

  render();
}

function sendResume(entry) {
  if (!entry || !entry.isHost || !state.storedLines.length) {
    return;
  }
  sendMessage(entry, {
    type: 'resume',
    chat: state.storedLines.slice(-MAX_CHAT_HISTORY)
  });
}

function attachStream(entry, stream) {
  if (!stream || typeof stream.getAudioTracks !== 'function' || stream.getAudioTracks().length === 0) {
    return;
  }
  if (entry.hasMedia) {
    return;
  }

  clearTimeout(entry.mediaTimer);
  entry.mediaTimer = null;
  entry.hasMedia = true;
  entry.stream = stream;

  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.volume = entry.volume;
  audio.muted = entry.muted;
  audio.playsInline = true;
  audio.setAttribute('playsinline', '');
  audio.srcObject = stream;
  dom.audioSinks.appendChild(audio);

  const playback = audio.play();
  if (playback && typeof playback.catch === 'function') {
    playback.catch(() => {
      showAlert(dom.sessionError, 'The browser blocked audio playback. Click anywhere on the page and it will resume.', 'warn');
    });
  }

  entry.audioEl = audio;
  render();
}

function detachAudio(entry) {
  if (entry.audioEl) {
    entry.audioEl.pause();
    entry.audioEl.srcObject = null;
    if (entry.audioEl.parentNode) {
      entry.audioEl.parentNode.removeChild(entry.audioEl);
    }
    entry.audioEl = null;
  }
  entry.stream = null;
}

function handleMessage(entry, message) {
  trace('<-', entry.id, message.type, JSON.stringify(message).slice(0, 120));
  switch (message.type) {
    case 'meta':
      if (typeof message.name === 'string' && message.name) {
        entry.name = uniquePeerName(sanitizeName(message.name).slice(0, MAX_NAME), entry.id);
        if (!entry.volumeTouched) {
          entry.volume = volumeFor(entry.name);
          if (entry.audioEl) {
            entry.audioEl.volume = entry.volume;
          }
        }
        if (!entry.muteTouched) {
          entry.muted = mutedFor(entry.name);
          if (entry.audioEl) {
            entry.audioEl.muted = entry.muted;
          }
        }
        render();
      }
      break;

    case 'welcome':
      if (!state.isHost && Array.isArray(message.peers)) {
        message.peers.forEach((info) => {
          if (info && typeof info.id === 'string') {
            dialPeer({ id: info.id, name: info.name, isHost: isHostId(info.id) });
          }
        });
      }
      if (!state.isHost && Array.isArray(message.chat)) {
        adoptChatHistory(mergeChatLines(state.storedLines, message.chat));
      }
      break;

    case 'join':
      if (message.peer && typeof message.peer.id === 'string' && state.joined && !state.leaving) {
        const incoming = message.peer;
        const isNewHost = !state.isHost && isHostId(incoming.id);
        if (isNewHost) {
          adoptNewHost(incoming.id, sanitizeName(incoming.name));
        } else if (!state.peers.has(incoming.id)) {
          const entry = ensureEntry(incoming.id);
          entry.name = sanitizeName(incoming.name) || 'Player';
          entry.status = 'connecting';
          logEvent(`${entry.name} joined.`);
          playSound('join');
          render();
        }
      }
      break;

    case 'host':
      if (message.peer && typeof message.peer.id === 'string' && !state.isHost && state.joined && !state.leaving) {
        adoptNewHost(message.peer.id, sanitizeName(message.peer.name));
      }
      break;

    case 'leave':
      if (typeof message.peerId === 'string') {
        const departing = state.peers.get(message.peerId);
        if (departing) {
          logEvent(`${departing.name} left to farm.`);
          playSound('out');
          removePeer(departing, { log: false });
        }
      }
      break;

    case 'resume':
      if (Array.isArray(message.chat)) {
        rememberChatLines(message.chat);
        state.chatHistory = mergeChatLines(state.chatHistory, state.storedLines);
      }
      break;

    case 'count':
      break;

    case 'chat':
      if (state.isHost) {
        receiveChatFromPeer(entry, message);
      } else {
        receiveChat(message);
      }
      break;

    case 'soundboard':
      if (message.label && typeof message.name === 'string') {
        const player = sanitizeName(message.name).slice(0, MAX_NAME) || 'Player';
        const label = String(message.label).slice(0, 24);
        logEvent(`${player} played ${label}.`);
        const silenced = entry.muted ? 'muted' : (entry.volume <= 0.05 ? 'turned right down' : '');
        if (silenced) {
          logEvent(`Note: you have ${player} ${silenced} here, so their voice and soundboard stay silent.`);
        }
      }
      break;

    default:
      break;
  }
}

function uniquePeerName(name, peerId) {
  const base = name || 'Player';
  let candidate = base;
  let suffix = 2;

  while (Array.from(state.peers.values()).some((entry) => entry.id !== peerId && entry.name === candidate)) {
    candidate = `${base} (${suffix})`;
    suffix += 1;
    if (suffix > 9) {
      break;
    }
  }
  return candidate;
}

function hostEntry() {
  for (const entry of state.peers.values()) {
    if (entry.isHost && entry.status === 'connected') {
      return entry;
    }
  }
  return null;
}

function onChatSubmit(event) {
  event.preventDefault();
  sendChat(dom.chatInput.value);
  dom.chatInput.value = '';
  autoGrowChatInput();
  dom.chatInput.focus();
}

// Enter sends, Shift+Enter (or Alt/Ctrl+Enter) starts a new line. The textarea
// grows with the text up to its max-height, then scrolls.
function onChatInputKeydown(event) {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.isComposing) {
    return;
  }
  event.preventDefault();
  dom.chatForm.requestSubmit();
}

function autoGrowChatInput() {
  if (!dom.chatInput) {
    return;
  }
  dom.chatInput.style.height = 'auto';
  dom.chatInput.style.height = `${dom.chatInput.scrollHeight}px`;
}

function sendChat(rawText) {
  if (!state.joined || state.leaving) {
    return;
  }

  const text = cleanChatText(rawText);
  if (!text) {
    return;
  }

  const now = Date.now();
  if (now - state.lastChatAt < CHAT_COOLDOWN) {
    return;
  }
  state.lastChatAt = now;

  const message = {
    type: 'chat',
    id: `${state.peer ? state.peer.id : 'me'}:${now}`,
    name: state.name,
    text,
    at: now
  };

  if (state.isHost) {
    deliverChat(message);
    return;
  }

  const host = hostEntry();
  if (!host) {
    showAlert(dom.sessionError, 'Chat is re-linking to the new room host. Try again in a moment.', 'warn');
    return;
  }
  sendMessage(host, { type: 'chat', id: message.id, text });
}

function receiveChatFromPeer(entry, message) {
  const text = cleanChatText(message && message.text);
  if (!text) {
    return;
  }

  const now = Date.now();
  if (now - (entry.lastChatAt || 0) < CHAT_COOLDOWN) {
    return;
  }
  entry.lastChatAt = now;

  deliverChat({
    id: (message && message.id) || `${entry.id}:${now}`,
    name: entry.name || 'Player',
    text,
    at: now
  });
}

function mergeChatLines(...groups) {
  const byId = new Map();
  groups.forEach((group) => {
    (Array.isArray(group) ? group : []).forEach((line) => {
      if (!line || typeof line.text !== 'string') {
        return;
      }
      const text = cleanChatText(line.text);
      if (!text) {
        return;
      }
      const name = sanitizeName(line.name).slice(0, MAX_NAME) || 'Player';
      const at = Number(line.at) || Date.now();
      const id = typeof line.id === 'string' && line.id ? line.id : `${name}:${at}:${text.slice(0, 16)}`;
      byId.set(id, { id, name, text, at });
    });
  });

  return Array.from(byId.values())
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_CHAT_HISTORY);
}

function chatStoreKey(roomId) {
  return `${CHAT_STORE_PREFIX}${String(roomId || '').trim().toLowerCase()}`;
}

function loadStoredLines(roomId) {
  try {
    const raw = window.localStorage.getItem(chatStoreKey(roomId));
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    const lines = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.lines) ? parsed.lines : [];
    return mergeChatLines(lines).slice(-MAX_STORED_LINES);
  } catch {
    return [];
  }
}

function writeStoredLines() {
  try {
    window.localStorage.setItem(chatStoreKey(state.roomId), JSON.stringify(state.storedLines));
  } catch {
    void 0;
  }
}

function rememberChatLines(lines) {
  const merged = mergeChatLines(state.storedLines, lines);
  if (merged.length === state.storedLines.length) {
    return;
  }
  state.storedLines = merged.slice(-MAX_STORED_LINES);
  writeStoredLines();
}

function deliverChat(message) {
  const record = {
    id: message.id,
    name: message.name,
    text: message.text,
    at: message.at
  };

  state.chatHistory.push(record);
  while (state.chatHistory.length > MAX_CHAT_HISTORY) {
    state.chatHistory.shift();
  }

  rememberChatLines([record]);
  broadcast({ type: 'chat', ...record });
  appendChat(record);
}

function receiveChat(message) {
  if (!message || typeof message.text !== 'string') {
    return;
  }
  const text = cleanChatText(message.text);
  if (!text) {
    return;
  }
  const record = {
    id: message.id,
    name: sanitizeName(message.name).slice(0, MAX_NAME) || 'Player',
    text,
    at: Number(message.at) || Date.now()
  };
  rememberChatLines([record]);
  appendChat(record);
}

function adoptChatHistory(lines) {
  const cleaned = mergeChatLines(lines);

  dom.chatLog.textContent = '';
  cleaned.forEach((line) => appendChat(line, { autoscroll: false, sound: false }));
  state.stickToChat = true;
  scrollChatToEnd();
}

function appendChat(message, options) {
  if (!dom.chatLog || !message || !message.text) {
    return;
  }

  const settings = options || {};
  const isSelf = message.name === state.name;
  const sender = String(message.name || '');
  const previous = dom.chatLog.lastElementChild;
  const grouped = Boolean(previous)
    && previous.dataset.kind === 'chat'
    && previous.dataset.from === sender;

  const item = document.createElement('li');
  item.className = 'chat-line';
  item.dataset.kind = 'chat';
  item.dataset.self = String(isSelf);
  item.dataset.from = sender;
  item.dataset.grouped = String(grouped);

  const time = document.createElement('time');
  const when = new Date(message.at || Date.now());
  time.textContent = when.toTimeString().slice(0, 5);

  const name = document.createElement('span');
  name.className = 'chat-name';
  name.textContent = isSelf ? `${message.name} (you)` : message.name;

  const text = document.createElement('span');
  text.className = 'chat-text';
  text.textContent = message.text;

  item.appendChild(time);
  item.appendChild(name);
  item.appendChild(text);
  dom.chatLog.appendChild(item);

  while (dom.chatLog.childElementCount > MAX_FEED) {
    dom.chatLog.removeChild(dom.chatLog.firstElementChild);
  }

  if (settings.autoscroll !== false) {
    scrollChatToEnd();
  }

  if (!isSelf && settings.sound !== false) {
    playSound('message');
  }
}

function scrollChatToEnd() {
  if (!dom.chatLog || !state.stickToChat) {
    return;
  }
  dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
}

function adoptNewHost(hostPeerId, name) {
  const known = state.peers.get(hostPeerId);
  if (known) {
    known.isHost = true;
    known.name = sanitizeName(name) || known.name;
    sendResume(known);
    render();
    return;
  }

  const stale = state.peers.get(state.hostId);
  if (stale && stale.id === hostPeerId) {
    stale.isHost = true;
    stale.name = name || stale.name;
    sendResume(stale);
    render();
    return;
  }
  if (stale) {
    removePeer(stale, { log: false });
  }
  state.status = 'live';
  logEvent(`${name || 'A player'} took over the room.`);
  hideAlert(dom.sessionError);
  dialPeer({ id: hostPeerId, name, isHost: true });
  render();
}

function onConnectionError(entry, error) {
  if (entry.isHost && isPeerUnavailable(error)) {
    removePeer(entry, { log: false });
    claimHostSeat('The host vanished, so you opened the room instead. Guard the throne.');
    return;
  }
  removePeer(entry, { log: false });
}

function removePeer(entry, options) {
  const settings = options || {};

  if (state.peers.get(entry.id) !== entry) {
    return;
  }

  const wasHost = entry.isHost;

  if (settings.log !== false && !entry.silent && entry.status === 'connected') {
    logEvent(`${entry.name} disconnected. Rezzing next round.`);
    playSound('out');
  }

  dropPeer(entry);

  if (state.isHost && !state.leaving) {
    broadcast({ type: 'leave', peerId: entry.id });
  }

  render();

  if (wasHost && !state.leaving) {
    onHostLost();
  }
}

function onPeerClosed(entry) {
  removePeer(entry);
}

function dropPeer(entry) {
  clearTimeout(entry.connectTimer);
  clearTimeout(entry.mediaTimer);
  entry.connectTimer = null;
  entry.mediaTimer = null;
  detachAudio(entry);

  if (state.peers.get(entry.id) === entry) {
    state.peers.delete(entry.id);
  }

  state.pendingCalls.delete(entry.id);

  if (entry.call) {
    try {
      entry.call.removeAllListeners();
      entry.call.close();
    } catch (error) {
      void error;
    }
    entry.call = null;
  }

  if (entry.conn) {
    entry.conn.off('open');
    entry.conn.off('data');
    entry.conn.off('stream');
    entry.conn.off('close');
    entry.conn.off('error');
    try {
      entry.conn.close();
    } catch (error) {
      void error;
    }
  }
}

function onHostLost() {
  if (state.leaving || !state.peer) {
    return;
  }

  state.status = 'connecting';
  logEvent('The room host left. Holding your existing squad while the room re-forms...');
  render();
  migrateToHost();
}

async function migrateToHost() {
  if (state.migrating || state.leaving || !state.peer) {
    return;
  }
  state.migrating = true;

  try {
    for (const delay of TIMEOUTS.hostReclaim) {
      await sleep(delay);
      if (state.leaving || !state.peer) {
        return;
      }
      let candidate = null;
      try {
        candidate = await openPeer(state.hostId);
      } catch (error) {
        if (!isUnavailableId(error)) {
          logEvent(`Could not take over the room: ${error && error.message ? error.message : 'unknown error'}`);
          state.status = 'live';
          showAlert(dom.sessionError, 'The room host left and this device could not claim the room. Your current squad audio still works; new players should start a fresh room.', 'info');
          render();
          return;
        }
        continue;
      }

      promoteToHost(candidate);
      return;
    }

    state.status = 'live';
    logEvent('Another player took over the room. Your squad audio is unaffected.');
    showAlert(dom.sessionError, 'The room host left and someone else claimed the room. Your squad audio still works, but new players will link up through them.', 'info');
    render();
  } finally {
    state.migrating = false;
  }
}

function onSignallingLost(closed) {
  if (state.leaving || !state.joined) {
    return;
  }

  state.status = 'error';
  render();

  showAlert(
    dom.sessionError,
    closed
      ? 'The signalling connection closed. Squad audio keeps working, but new players cannot join until you reconnect.'
      : 'Signalling is offline. Squad audio keeps working; new players may not be able to join.',
    'warn'
  );

  if (closed && !state.reconnectTried && state.peer && typeof state.peer.reconnect === 'function') {
    state.reconnectTried = true;
    try {
      state.peer.reconnect();
      logEvent('Attempting to re-register with the signalling server...');
    } catch (error) {
      void error;
    }
  }
}

function handlePeerError(error) {
  const type = error && error.type;
  if (type) {
    console.warn('[peer error]', type, error.message || '');
  }

  switch (type) {
    case 'peer-unavailable':
      if (!state.isHost && state.joined) {
        claimHostSeat('The host is gone, so you opened the room instead. Guard the throne.');
      }
      break;
    case 'browser-incompatible':
      showAlert(dom.sessionError, 'This browser does not support WebRTC, which NoMoreDiscord needs.', 'error');
      break;
    case 'network':
    case 'socket-error':
    case 'socket-closed':
    case 'server-error':
    case 'disconnected':
      onSignallingLost(false);
      break;
    default:
      break;
  }
}

function leaveRoom() {
  if (!state.joined) {
    return;
  }
  broadcast({ type: 'leave', peerId: state.peer ? state.peer.id : '' });
  logEvent('You left the room. GG.');
  playSound('out');
  resetSession();
  showLobby();
}

function resetSession() {
  state.leaving = true;
  setPtt(false);

  state.peers.forEach((entry) => dropPeer(entry));
  state.peers.clear();

  if (state.peer) {
    try {
      state.peer.destroy();
    } catch (error) {
      void error;
    }
  }

  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => track.stop());
  }

  if (state.mixer) {
    try {
      state.mixer.ctx.close();
    } catch (error) {
      void error;
    }
    state.mixer.micStream.getTracks().forEach((track) => track.stop());
    state.mixer = null;
  }
  state.soundActive = 0;
  resetSoundboardButtons();

  state.peer = null;
  state.localStream = null;
  state.joined = false;
  state.isHost = false;
  state.status = 'connecting';
  state.migrating = false;
  state.reconnectTried = false;
  state.roomId = '';
  state.hostId = '';
  state.chatHistory = [];
  state.storedLines = [];
  state.lastChatAt = 0;
  state.stickToChat = true;

  if (dom.chatLog) {
    dom.chatLog.textContent = '';
  }
  if (dom.chatInput) {
    dom.chatInput.value = '';
    autoGrowChatInput();
  }
  hideAlert(dom.sessionError);
  render();
}

function showSession() {
  const room = roomById(state.roomId);
  dom.lobby.hidden = true;
  dom.session.hidden = false;
  dom.roomName.textContent = room ? room.label : state.roomId;
  dom.callsign.textContent = state.name;
  state.stickToChat = true;
  dom.chatLog.textContent = '';
  dom.chatInput.value = '';
  autoGrowChatInput();
  dom.ptt.focus({ preventScroll: true });
}

function showLobby() {
  dom.session.hidden = true;
  dom.lobby.hidden = false;
  hideAlert(dom.lobbyError);
  updateJoinLabel();
  refreshRoomCounts();
  startCountPolling();
  dom.nameInput.focus();
}

function setBusy(busy) {
  state.busy = busy;
  dom.joinBtn.disabled = busy;
  dom.nameInput.disabled = busy;
  const room = selectedRoom();
  dom.joinBtn.textContent = busy ? 'Connecting...' : `Join ${room.label}`;
}

function toggleMute() {
  state.userMuted = !state.userMuted;
  if (state.userMuted) {
    setPtt(false);
  }
  applyAudioState();
}

function setMode(mode) {
  state.mode = mode === 'open' ? 'open' : 'ptt';
  if (state.mode === 'open') {
    setPtt(false);
  }
  applyAudioState();
}

function setPtt(active) {
  const next = Boolean(active) && !state.userMuted;
  if (state.pttActive === next) {
    return;
  }
  state.pttActive = next;
  applyAudioState();
}

function isTransmitting() {
  if (!state.localStream) {
    return false;
  }
  if (state.userMuted) {
    return false;
  }
  return state.mode === 'open' ? true : state.pttActive;
}

function applyAudioState() {
  const transmitting = isTransmitting();
  const boardLive = state.soundActive > 0;
  const track = state.localStream ? state.localStream.getAudioTracks()[0] : null;

  // The mixer track stays open while a soundboard clip plays, but the
  // microphone side of the mix is gated with the gain so a muted mic never
  // leaks through underneath the clip.
  if (track) {
    track.enabled = transmitting || boardLive;
  }

  if (state.mixer) {
    state.mixer.micGain.gain.value = transmitting ? 1 : 0;
  }

  if (dom.ptt) {
    dom.ptt.dataset.live = String(transmitting);
    dom.ptt.setAttribute('aria-pressed', String(transmitting));
    dom.ptt.disabled = state.userMuted;
    dom.ptt.querySelector('.ptt-label').textContent = state.userMuted
      ? 'Mic muted'
      : (state.mode === 'open' ? 'Open mic - live' : 'Hold to talk');
  }

  if (dom.muteBtn) {
    dom.muteBtn.textContent = state.userMuted ? 'Unmute mic' : 'Mute';
    dom.muteBtn.setAttribute('aria-pressed', String(state.userMuted));
  }

  if (dom.modePtt && dom.modeOpen) {
    dom.modePtt.setAttribute('aria-pressed', String(state.mode === 'ptt'));
    dom.modeOpen.setAttribute('aria-pressed', String(state.mode === 'open'));
  }

  if (dom.micChip) {
    const micState = !state.localStream
      ? 'idle'
      : state.userMuted
        ? 'muted'
        : transmitting
          ? 'talking'
          : 'idle';
    dom.micChip.dataset.state = micState;
    dom.micChip.textContent = micState === 'muted'
      ? 'Mic muted'
      : micState === 'talking'
        ? 'Transmitting'
        : state.mode === 'open' ? 'Open mic' : 'Mic idle (PTT)';
  }

  if (dom.controlsHint) {
    dom.controlsHint.textContent = state.userMuted
      ? 'Mic is hard-muted. Even bards need breath.'
      : state.mode === 'open'
        ? 'Open mic is live. No take-backs.'
        : 'Push to talk: hold Space or the button.';
  }
}

function onPttPointerDown(event) {
  event.preventDefault();
  if (state.userMuted) {
    return;
  }
  if (typeof dom.ptt.setPointerCapture === 'function' && event.pointerId !== undefined) {
    try {
      dom.ptt.setPointerCapture(event.pointerId);
    } catch (error) {
      void error;
    }
  }
  setPtt(true);
}

function onKeyDown(event) {
  if (!isSpace(event)) {
    return;
  }
  if (isTypingTarget(event.target)) {
    return;
  }
  if (event.target && event.target.tagName === 'BUTTON' && event.target !== dom.ptt) {
    return;
  }
  if (!state.joined) {
    return;
  }
  event.preventDefault();
  if (event.repeat) {
    return;
  }
  setPtt(true);
}

function onKeyUp(event) {
  if (!isSpace(event)) {
    return;
  }
  if (isTypingTarget(event.target)) {
    return;
  }
  setPtt(false);
}

function isTypingTarget(target) {
  if (!target) {
    return false;
  }
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || Boolean(target.isContentEditable);
}

function isSpace(event) {
  return event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar' || event.key === 'Space';
}

function render() {
  if (dom.statusChip) {
    const labels = {
      host: 'Hosting room',
      live: 'In squad',
      connecting: 'Connecting',
      error: 'Reconnecting'
    };
    dom.statusChip.dataset.state = state.status;
    dom.statusChip.textContent = labels[state.status] || 'Status';
  }

  const rows = [];
  rows.push({
    id: state.peer ? state.peer.id : 'self',
    name: `${state.name} (you)`,
    status: 'connected',
    isSelf: true,
    isHost: state.isHost
  });

  Array.from(state.peers.values())
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .forEach((entry) => {
      rows.push({
        id: entry.id,
        name: entry.name,
        status: entry.status,
        isSelf: false,
        isHost: entry.isHost,
        entry
      });
    });

  dom.peerList.textContent = '';
  rows.forEach((row) => dom.peerList.appendChild(buildPeerRow(row)));

  const squadSize = rows.length;
  dom.peerCount.textContent = String(squadSize);
  dom.peerEmpty.hidden = state.peers.size > 0;

  if (dom.chatHint) {
    dom.chatHint.textContent = state.isHost
      ? 'you run the trash talk'
      : hostEntry()
        ? 'trash talk enabled'
        : 're-linking to the host...';
  }
}

function buildPeerRow(row) {
  const item = document.createElement('li');
  item.className = row.isSelf ? 'peer self' : 'peer';
  item.dataset.status = row.status;

  const dot = document.createElement('span');
  dot.className = 'peer-dot';

  const name = document.createElement('span');
  name.className = 'peer-name';
  name.textContent = row.name;

  item.appendChild(dot);
  item.appendChild(name);

  if (row.isHost) {
    item.appendChild(makeTag('host', 'Host'));
  }
  if (row.isSelf) {
    item.appendChild(makeTag('you', 'You'));
  }

  if (!row.isSelf) {
    const stateText = document.createElement('span');
    stateText.className = 'peer-state';
    stateText.textContent = row.status === 'connected' ? 'connected' : 'connecting...';
    item.appendChild(stateText);
  }

  if (row.entry) {
    item.appendChild(buildVolumeSlider(row.entry, row.name));
  }

  return item;
}

function buildVolumeSlider(entry, name) {
  const row = document.createElement('div');
  row.className = 'peer-volume-row';

  const mute = document.createElement('button');
  mute.type = 'button';
  mute.className = 'peer-mute';

  const muteIcon = document.createElement('img');
  muteIcon.className = 'peer-mute-icon';
  muteIcon.alt = '';
  mute.append(muteIcon);
  syncPeerMute(mute, muteIcon, entry, name);

  mute.addEventListener('click', () => {
    entry.muted = !entry.muted;
    entry.muteTouched = true;
    if (entry.audioEl) {
      entry.audioEl.muted = entry.muted;
    }
    syncPeerMute(mute, muteIcon, entry, name);
    saveMuted(entry.name, entry.muted);
  });

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'peer-volume';
  slider.min = '0';
  slider.max = '100';
  slider.step = '5';
  slider.value = String(Math.round(entry.volume * 100));
  slider.title = `${slider.value}%`;
  slider.setAttribute('aria-label', `Volume for ${name}`);

  slider.addEventListener('input', () => {
    const volume = Number(slider.value) / 100;
    entry.volume = volume;
    entry.volumeTouched = true;
    if (entry.audioEl) {
      entry.audioEl.volume = volume;
    }
    slider.title = `${slider.value}%`;
    saveVolume(entry.name, volume);
  });

  row.append(mute, slider);
  return row;
}

// The peer mute only stops that person's audio in this browser. The icon shows
// their mic as open (you can hear them) or off (you silenced them).
function syncPeerMute(button, icon, entry, name) {
  const label = entry.muted ? `Unmute ${name}` : `Mute ${name}`;
  button.setAttribute('aria-pressed', String(entry.muted));
  button.setAttribute('aria-label', label);
  button.title = label;
  icon.src = entry.muted ? 'images/off_mic.webp' : 'images/open_mic.webp';
}

function makeTag(text, kind) {
  const tag = document.createElement('span');
  tag.className = `tag ${kind}`;
  tag.textContent = text;
  return tag;
}

let iceCounts = null;

// PeerJS never surfaces ICE candidates or connection state, which makes a failed
// guest connection indistinguishable from a slow one. With ?trace=1 we wrap the
// constructor so candidate types and state changes are observable, and print the
// tally into the chat log on failure so it can be read without dev tools.
function installIceTracing() {
  if (!TRACE || !window.RTCPeerConnection) {
    return;
  }

  const Native = window.RTCPeerConnection;
  const counts = { host: 0, srflx: 0, prflx: 0, relay: 0 };
  const seen = new WeakSet();

  function TracedPeerConnection(...args) {
    const pc = new Native(...args);
    if (!seen.has(pc)) {
      seen.add(pc);
      pc.addEventListener('icecandidate', (event) => {
        if (!event.candidate) {
          return;
        }
        const type = (/\styp (\w+)/.exec(event.candidate.candidate || '') || [])[1] || 'unknown';
        counts[type] = (counts[type] || 0) + 1;
        console.log(`[ice] candidate ${type} ${iceSummary()}`);
      });
      pc.addEventListener('iceconnectionstatechange', () => {
        console.log(`[ice] connection ${pc.iceConnectionState} ${iceSummary()}`);
      });
      pc.addEventListener('icegatheringstatechange', () => {
        console.log(`[ice] gathering ${pc.iceGatheringState} ${iceSummary()}`);
      });
    }
    return pc;
  }

  TracedPeerConnection.prototype = Native.prototype;
  window.RTCPeerConnection = TracedPeerConnection;
  iceCounts = counts;
}

function iceSummary() {
  if (!iceCounts) {
    return '';
  }
  const parts = Object.keys(iceCounts)
    .filter((key) => iceCounts[key])
    .map((key) => `${key} ${iceCounts[key]}`);
  return parts.length ? parts.join(', ') : 'no candidates yet';
}

function logIceDiagnosis() {
  if (!TRACE || !iceCounts) {
    return;
  }
  logEvent(`Connection check: ICE candidates seen - ${iceSummary()}.`);
  if (iceCounts.relay) {
    return;
  }
  if (!hasTurnRelay()) {
    logEvent('No relay candidate, because the relay was switched off. If you get stuck like this on your own network, tick "Use a relay server" under Stuck on "Connecting"? in the lobby.');
    return;
  }
  logEvent('No TURN relay candidate was reachable. That is why the two of you cannot meet: this network gives WebRTC no direct path, and a relay is the only remaining option.');
}

function logEvent(text) {
  if (!text || !dom.chatLog) {
    return;
  }


  const item = document.createElement('li');
  item.className = 'chat-line';
  item.dataset.kind = 'system';

  const time = document.createElement('time');
  time.textContent = new Date().toTimeString().slice(0, 5);

  const message = document.createElement('span');
  message.textContent = text;

  item.appendChild(time);
  item.appendChild(message);
  dom.chatLog.appendChild(item);

  while (dom.chatLog.childElementCount > MAX_FEED) {
    dom.chatLog.removeChild(dom.chatLog.firstElementChild);
  }

  scrollChatToEnd();
}

function triggerSoundboard(button) {
  if (button.disabled) {
    return;
  }
  button.disabled = true;
  button.classList.add('playing');
  playSoundboard(button.dataset.snd).finally(() => {
    button.disabled = false;
    button.classList.remove('playing');
  });
}

function resetSoundboardButtons() {
  if (!dom.soundboard) {
    return;
  }
  dom.soundboard.querySelectorAll('.snd').forEach((button) => {
    button.disabled = false;
    button.classList.remove('playing');
  });
}

// Plays a soundboard clip into the outgoing stream. Resolves once the clip
// has finished (or immediately when it could not be played).
async function playSoundboard(id) {
  const clip = SOUNDBOARD.find((item) => item.id === id);
  if (!clip || !state.joined || state.leaving) {
    return false;
  }

  // The clicker hears the clip on this machine straight away, through the
  // same HTMLAudio path as the join/leave sounds, so pressing a button always
  // answers back - even when nobody else is connected.
  const local = new Audio(`sounds/soundboard/${clip.file}.mp3`);
  local.volume = SOUNDBOARD_VOLUME;
  local.play().catch(() => {});

  const mixer = state.mixer;
  if (!mixer) {
    logEvent('Soundboard could not join the voice stream in this browser.');
    return false;
  }

  let started = false;
  let done = false;
  const finish = () => {
    if (done) {
      return;
    }
    done = true;
    if (started && state.mixer === mixer) {
      state.soundActive = Math.max(0, state.soundActive - 1);
      applyAudioState();
    }
  };

  try {
    if (mixer.ctx.state !== 'running') {
      await mixer.ctx.resume();
    }
    if (mixer.ctx.state !== 'running') {
      throw new Error(`the audio engine is ${mixer.ctx.state}`);
    }

    const buffer = await loadSoundboardClip(mixer, clip.file);
    const source = mixer.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(mixer.boardGain);

    state.soundActive += 1;
    started = true;
    applyAudioState();
    broadcast({ type: 'soundboard', name: state.name, label: clip.label });
    logEvent(`You played ${clip.label}.`);
    source.start();

    // onended never fires while the context is suspended, so the watchdog
    // keeps the button from sticking in the "playing" state.
    const ended = new Promise((resolve) => {
      source.onended = () => {
        finish();
        resolve();
      };
    });
    const watchdog = new Promise((resolve) => setTimeout(resolve, buffer.duration * 1000 + 1500));
    await Promise.race([ended, watchdog]);
    finish();
    return true;
  } catch (error) {
    finish();
    const reason = error && error.message ? error.message : 'the clip could not be decoded';
    logEvent(`Soundboard failed: ${reason}.`);
    trace('soundboard', 'failed', reason);
    return false;
  }
}

function loadSoundboardClip(mixer, file) {
  const cached = mixer.clips.get(file);
  if (cached) {
    return cached;
  }

  const loading = fetch(`sounds/soundboard/${file}.mp3`)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`soundboard clip ${file} is missing`);
      }
      return response.arrayBuffer();
    })
    .then((data) => mixer.ctx.decodeAudioData(data))
    .catch((error) => {
      mixer.clips.delete(file);
      throw error;
    });

  mixer.clips.set(file, loading);
  return loading;
}

function playSound(name) {
  const src = SOUND_FILES[name];
  if (!src) {
    return;
  }

  let clip = soundClips.get(name);
  if (!clip) {
    clip = new Audio(src);
    clip.preload = 'auto';
    clip.volume = SOUND_VOLUME;
    soundClips.set(name, clip);
  }

  if (clip.currentTime > 0) {
    try {
      clip.currentTime = 0;
    } catch {
      void 0;
    }
  }

  const playback = clip.play();
  if (playback && typeof playback.catch === 'function') {
    playback.catch(() => {});
  }
}

function showAlert(container, message, kind) {
  if (kind === 'warn' || kind === 'info') {
    container.dataset.kind = kind;
  } else {
    container.dataset.kind = 'error';
  }
  if (container === dom.sessionError) {
    dom.sessionErrorText.textContent = message;
  } else {
    container.textContent = message;
  }
  container.hidden = false;
}

function hideAlert(container) {
  container.hidden = true;
  if (container === dom.sessionError) {
    dom.sessionErrorText.textContent = '';
  } else {
    container.textContent = '';
  }
}

function startCountPolling() {
  stopCountPolling();
  refreshRoomCounts();
  state.probeTimer = setInterval(() => refreshRoomCounts(), LOBBY_REFRESH);
}

function stopCountPolling() {
  clearInterval(state.probeTimer);
  state.probeTimer = null;
}

function refreshRoomCounts() {
  if (state.joined || state.leaving || typeof Peer === 'undefined') {
    return;
  }
  renderRoomCounts();

  ensureProbePeer()
    .then((probe) => Promise.all(ROOMS.map((room) => probeRoomCount(probe, room))))
    .then(() => renderRoomCounts())
    .catch(() => {
      ROOMS.forEach((room) => {
        if (state.roomCounts[room.id] === undefined) {
          state.roomCounts[room.id] = null;
        }
      });
      renderRoomCounts();
    });
}

function ensureProbePeer() {
  if (state.probePeer && !state.probePeer.destroyed) {
    return Promise.resolve(state.probePeer);
  }

  return new Promise((resolve, reject) => {
    let probe;
    try {
      probe = new Peer(PEER_OPTIONS);
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        probe.destroy();
      } catch (error) {
        void error;
      }
      reject(new Error('Count check timed out.'));
    }, TIMEOUTS.probe);

    probe.on('error', (error) => {
      handleProbePeerError(error);
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (state.probePeer === probe) {
        state.probePeer = null;
      }
      reject(error);
    });

    probe.on('open', () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      state.probePeer = probe;
      resolve(probe);
    });
  });
}

function handleProbePeerError(error) {
  if (!isPeerUnavailable(error)) {
    return;
  }

  const match = /connect to peer (\S+)/i.exec((error && error.message) || '');
  const target = match ? match[1] : null;

  if (target && state.probeTargets.has(target)) {
    const finish = state.probeTargets.get(target);
    state.probeTargets.delete(target);
    trace('probe', target, 'unavailable');
    finish(0);
    return;
  }

  if (!target && state.probeTargets.size === 1) {
    const only = state.probeTargets.keys().next().value;
    const finish = state.probeTargets.get(only);
    state.probeTargets.delete(only);
    trace('probe', only, 'unavailable');
    finish(0);
  }
}

function probeRoomCount(probe, room) {
  return new Promise((resolve) => {
    const hostId = hostIdFor(room.id);
    let conn = null;
    let settled = false;

    const finish = (count) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      state.probeTargets.delete(hostId);
      if (conn) {
        conn.off('open');
        conn.off('data');
        conn.off('error');
        try {
          conn.close();
        } catch (error) {
          void error;
        }
      }
      state.roomCounts[room.id] = count;
      resolve(count);
    };

    state.probeTargets.set(hostId, finish);

    const timer = setTimeout(() => {
      trace('probe', room.id, 'timeout');
      finish(null);
    }, TIMEOUTS.probe);

    try {
      conn = probe.connect(hostId, {
        reliable: true,
        serialization: 'json',
        metadata: { probe: true }
      });
    } catch (error) {
      trace('probe', room.id, 'throw', error && error.type);
      finish(0);
      return;
    }

    conn.on('open', () => {
      trace('probe', room.id, 'open');
      try {
        conn.send({ type: 'count' });
      } catch (error) {
        void error;
      }
    });

    conn.on('data', (message) => {
      if (message && message.type === 'count' && Number.isFinite(message.count)) {
        trace('probe', room.id, 'count', message.count);
        finish(message.count);
      }
    });

    conn.on('error', (error) => {
      trace('probe', room.id, 'error', error && error.type);
      finish(isPeerUnavailable(error) || (error && error.type) ? 0 : null);
    });
  });
}

function renderRoomCounts() {
  ROOMS.forEach((room) => {
    const badge = dom.roomCounts && dom.roomCounts.get(room.id);
    if (!badge) {
      return;
    }
    const count = state.roomCounts[room.id];
    badge.dataset.state = 'empty';
    badge.textContent = '';

    const value = document.createElement('span');
    value.className = 'room-count-value';

    if (count === undefined) {
      badge.dataset.state = 'loading';
      value.textContent = 'checking...';
    } else if (count === null) {
      badge.dataset.state = 'unknown';
      value.textContent = 'no reply';
    } else if (count >= MAX_SQUAD) {
      badge.dataset.state = 'full';
      value.textContent = `full · ${count}`;
    } else if (count > 0) {
      badge.dataset.state = 'live';
      value.textContent = `${count} online`;
    } else {
      value.textContent = 'empty';
    }

    badge.appendChild(value);
  });
}

function answerCountProbe(conn) {
  let settled = false;

  const reply = () => {
    if (settled) {
      return;
    }
    settled = true;
    try {
      conn.send({ type: 'count', count: connectedRoster().length + 1 });
    } catch (error) {
      void error;
    }
    setTimeout(() => {
      try {
        conn.close();
      } catch (error) {
        void error;
      }
    }, 120);
  };

  conn.on('open', reply);
  conn.on('data', () => reply());
  conn.on('error', () => {
    settled = true;
  });
  conn.on('close', () => {
    settled = true;
  });
  setTimeout(() => {
    if (!settled) {
      settled = true;
      try {
        conn.close();
      } catch (error) {
        void error;
      }
    }
  }, TIMEOUTS.probe + 2000);
}

function connectedRoster(excludeId) {
  const list = [];
  state.peers.forEach((entry, id) => {
    if (id !== excludeId && entry.status === 'connected') {
      list.push({ id, name: entry.name });
    }
  });
  return list;
}

function sendMessage(entry, message) {
  if (!entry || !entry.conn) {
    return;
  }
  trace('->', entry.id, message.type);
  try {
    entry.conn.send(message);
  } catch (error) {
    void error;
  }
}

function trace(...args) {
  if (TRACE) {
    console.log('[trace]', state.name || 'me', ...args);
  }
}

function broadcast(message, excludeId) {
  state.peers.forEach((entry, id) => {
    if (id !== excludeId) {
      sendMessage(entry, message);
    }
  });
}

function hostIdFor(roomId) {
  const base = roomId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+/, '')
    .replace(/[-_]+$/, '')
    .slice(0, 32) || 'room';

  let hash = 5381;
  const source = roomId.trim().toLowerCase();
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash * 33) ^ source.charCodeAt(index)) >>> 0;
  }

  return `${HOST_PREFIX}-${base}-${hash.toString(36)}-host`;
}

function isHostId(id) {
  return Boolean(state.hostId) && id === state.hostId;
}

function isUnavailableId(error) {
  return Boolean(error) && error.type === 'unavailable-id';
}

function isPeerUnavailable(error) {
  return Boolean(error) && error.type === 'peer-unavailable';
}

function cleanChatText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
    .slice(0, MAX_CHAT);
}

function sanitizeName(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const cleaned = value.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 24);
  return cleaned;
}

function readNameFromUrl() {
  const name = new URLSearchParams(location.search).get('name');
  return name ? sanitizeName(name).slice(0, MAX_NAME) : '';
}

function readSavedName() {
  return readNameFromUrl() || readStoredName();
}

function readStoredName() {
  try {
    const stored = window.localStorage.getItem(NAME_STORAGE_KEY);
    return stored ? sanitizeName(stored).slice(0, MAX_NAME) : '';
  } catch (error) {
    return '';
  }
}

function saveName(name) {
  try {
    window.localStorage.setItem(NAME_STORAGE_KEY, name);
  } catch (error) {
    void error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
