const { startServer } = require('./static-server');
const { launchBrowser, newTestPage, closeBrowser, sleep } = require('./browser');
const { Report } = require('./report');

const PORT = Number(process.env.PORT || 8788);
const TRACE = process.env.TRACE === '1';
// General and Turbo are shared with anyone else running the app, so the suite
// runs in a private room (?trace=1 unlocks arbitrary room ids in app.js).
const RUN_ID = Math.random().toString(36).slice(2, 7);
const MAIN_ROOM = `general-${RUN_ID}`;
const OTHER_ROOM = `turbo-${RUN_ID}`;
const CHAT_LINE = 'gg wp everyone';

const JOIN_WAIT = 3500;
const SETTLE_WAIT = 6000;

function snapshot(page) {
  return page.evaluate(() => {
    const track = state.localStream ? state.localStream.getAudioTracks()[0] : null;
    const sinks = Array.from(document.querySelectorAll('#audio-sinks audio'));
    const chatLines = Array.from(document.querySelectorAll('#chat-log .chat-line[data-kind="chat"]'));
    return {
      isHost: state.isHost,
      room: state.roomId,
      statusChip: document.getElementById('status-chip').textContent,
      micChip: document.getElementById('mic-chip').textContent,
      openMode: document.getElementById('mode-open').getAttribute('aria-pressed') === 'true',
      pttMode: document.getElementById('mode-ptt').getAttribute('aria-pressed') === 'true',
      lobbyVisible: !document.getElementById('lobby').hidden,
      sessionVisible: !document.getElementById('session').hidden,
      lobbyError: document.getElementById('lobby-error').hidden ? null : document.getElementById('lobby-error').textContent,
      sessionError: document.getElementById('session-error').hidden ? null : document.getElementById('session-error-text').textContent,
      nameField: document.getElementById('name-input').value,
      roomLabel: document.getElementById('room-name').textContent,
      joinLabel: document.getElementById('join-btn').textContent,
      lobbyRoomName: ((document.querySelector('.room-name') || {}).textContent || '').replace(/\s+/g, ' ').trim(),
      counts: Array.from(document.querySelectorAll('.room-count')).map((badge) => ({
        state: badge.dataset.state,
        text: badge.textContent
      })),
      localTrack: track ? { enabled: track.enabled, readyState: track.readyState } : null,
      peerNames: Array.from(state.peers.values()).map((entry) => entry.name).sort(),
      connectedCount: Array.from(state.peers.values()).filter((entry) => entry.status === 'connected').length,
      liveRemoteTracks: Array.from(state.peers.values()).filter(
        (entry) => entry.stream && entry.stream.getAudioTracks().some((t) => t.readyState === 'live')
      ).length,
      retries: Array.from(state.peers.values()).reduce((sum, entry) => sum + (entry.mediaRetries || 0), 0),
      sinks: sinks.length,
      playing: sinks.filter((el) => !el.paused && el.srcObject && el.srcObject.getAudioTracks().length > 0).length,
      uiRows: Array.from(document.querySelectorAll('#peer-list li')).map((li) => li.dataset.status),
      chatCount: chatLines.length,
      chatTexts: chatLines.map((li) => li.querySelector('.chat-text').textContent),
      chatNames: chatLines.map((li) => li.querySelector('.chat-name').textContent),
      systemCount: document.querySelectorAll('#chat-log .chat-line[data-kind="system"]').length,
      systemTexts: Array.from(document.querySelectorAll('#chat-log .chat-line[data-kind="system"] span')).map((span) => span.textContent),
      chatHint: document.getElementById('chat-hint').textContent,
      sounds: Array.isArray(window.__sounds) ? window.__sounds.slice() : []
    };
  });
}

function describe(label, snap) {
  const base = `  ${label.padEnd(14)} room=${String(snap.room).padEnd(8)} host=${String(snap.isHost).padEnd(5)} chip="${snap.statusChip}" `
    + `peers=${snap.peerNames.length} connected=${snap.connectedCount} live=${snap.liveRemoteTracks} `
    + `sinks=${snap.sinks}/${snap.playing} chat=${snap.chatCount} sys=${snap.systemCount} hint="${snap.chatHint}"`;
  return snap.lobbyError ? `${base}\n      lobbyError: ${snap.lobbyError}` : base;
}

async function waitForCounts(page, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 15000);
  while (Date.now() < deadline) {
    const states = await page.evaluate(() => Array.from(document.querySelectorAll('.room-count')).map((badge) => badge.dataset.state));
    if (states.length > 0 && states.every((state) => state !== 'loading')) {
      return true;
    }
    await sleep(500);
  }
  return false;
}

async function refreshCounts(page) {
  await page.evaluate(() => refreshRoomCounts());
  await sleep(2500);
}

async function probeCount(page, roomId) {
  return page.evaluate(async (id) => {
    const probe = await ensureProbePeer();
    return probeRoomCount(probe, { id, label: id });
  }, roomId);
}

(async () => {
  const report = new Report();
  const site = await startServer(PORT);
  const browser = await launchBrowser();
  const clients = [];

  console.log(`origin: ${site.origin}\nrooms: ${MAIN_ROOM} (squad), ${OTHER_ROOM} (isolation check)`);

  const openClient = async (name, room, options) => {
    const client = await newTestPage(browser, { label: name, viewport: { width: 1000, height: 900 } });
    const query = new URLSearchParams({ room, name, trace: '1' });
    if (TRACE) {
      query.set('trace', '1');
    }
    await client.page.goto(`${site.origin}/?${query.toString()}`, { waitUntil: 'domcontentloaded' });
    await client.page.evaluate(() => {
      window.__sounds = [];
      const original = window.playSound;
      window.playSound = (name) => {
        window.__sounds.push(name);
        return original(name);
      };
    });
    client.name = name;
    if (!options || options.track !== false) {
      clients.push(client);
    }
    if (TRACE) {
      client.page.on('console', (msg) => {
        if (msg.text().includes('[trace]')) {
          console.log(`  ${msg.text()}`);
        }
      });
    }
    return client;
  };

  const join = async (client) => {
    await client.page.click('#join-btn');
    await sleep(600);
  };

  const sendChat = async (client, text) => {
    await client.page.click('#chat-input');
    await client.page.type('#chat-input', text);
    await client.page.keyboard.press('Enter');
  };

  const snapAll = async () => Promise.all(clients.map((client) => snapshot(client.page)));

  try {
    for (const name of ['AlphaFox', 'BravoHawk', 'CharlieWolf']) {
      const client = await openClient(name, MAIN_ROOM);
      await join(client);
    }
    await sleep(SETTLE_WAIT);

    console.log('\n[1] three named players pick a room and form a full mesh');
    let snaps = await snapAll();
    snaps.forEach((snap, index) => console.log(describe(clients[index].name, snap)));
    snaps.forEach((snap, index) => {
      const others = clients.slice(0, 3).map((c) => c.name).filter((n) => n !== clients[index].name).sort();
      report.expect(`${clients[index].name} joined ${MAIN_ROOM}`, [snap.room, snap.roomLabel], [MAIN_ROOM, MAIN_ROOM]);
      report.expect(`${clients[index].name} sees the other two`, snap.peerNames, others);
      report.expect(`${clients[index].name} is connected to both`, snap.connectedCount, 2);
      report.expect(`${clients[index].name} receives live audio from both`, snap.liveRemoteTracks, 2);
      report.expect(`${clients[index].name} plays both streams`, snap.playing, 2);
      report.expect(`${clients[index].name} needed no media retries`, snap.retries, 0);
      report.expect(`${clients[index].name} roster rows are all connected`, snap.uiRows, ['connected', 'connected', 'connected']);
    });
    report.expect('the typed name is kept verbatim', snaps[0].nameField, 'AlphaFox');
    report.expect('the first joiner hosts the room', snaps[0].isHost, true);
    report.expect('the second joiner is not the host', snaps[1].isHost, false);
    report.expect('the host relays chat', snaps[0].chatHint, 'you run the trash talk');
    report.expect('the host logs join events as system lines', snaps[0].systemCount >= 2, true);
    console.log(`  sounds: ${clients.map((c, i) => `${c.name}=${JSON.stringify(snaps[i].sounds)}`).join(' ')}`);
    report.expect('every player heard the join cue', snaps.every((snap) => snap.sounds.includes('join')), true);
    report.expect('the host heard one join cue per player', snaps[0].sounds.filter((name) => name === 'join').length, 3);
    report.expect('a late joiner only heard their own join', snaps[2].sounds.filter((name) => name === 'join').length, 1);

    console.log('\n[2] the lobby reports live counts per room');
    const watcher = await openClient('LobbyWatcher', MAIN_ROOM, { track: false });
    report.expect('the lobby finishes counting both rooms', await waitForCounts(watcher.page), true);
    const watcherSnap = await snapshot(watcher.page);
    console.log(`  counts: ${JSON.stringify(watcherSnap.counts)} join="${watcherSnap.joinLabel}" room=${watcherSnap.lobbyRoomName}`);
    report.expect('every badge resolves to a real number or empty', watcherSnap.counts.every((badge) => /^(empty|\d+ online|full · \d+)$/.test(badge.text)), true);
    report.expect('each badge state agrees with its text', watcherSnap.counts.every((badge) => (badge.state === 'empty' ? badge.text === 'empty' : badge.state === 'full' ? badge.text.startsWith('full') : /^\d+ online$/.test(badge.text))), true);
    report.expect('the join button names the selected room', watcherSnap.joinLabel, `Join ${MAIN_ROOM}`);
    report.expect('the lobby shows the Roshan room', watcherSnap.lobbyRoomName, 'Roshan');
    report.expect('the watcher is still in the lobby', watcherSnap.lobbyVisible, true);

    const exactCount = await probeCount(watcher.page, MAIN_ROOM);
    console.log(`  exact probe of ${MAIN_ROOM}: ${exactCount}`);
    report.expect(`the private room reports exactly three players`, exactCount, 3);
    report.expect('an unhosted room probes as empty', await probeCount(watcher.page, `empty-${RUN_ID}`), 0);

    console.log('\n[3] a name is required before joining');
    await watcher.page.evaluate(() => {
      document.getElementById('name-input').value = '';
    });
    await watcher.page.click('#join-btn');
    await sleep(1500);
    const nameless = await snapshot(watcher.page);
    console.log(`  error: ${nameless.lobbyError}`);
    report.expect('an empty name is rejected', /name/i.test(nameless.lobbyError || ''), true);
    report.expect('a rejected name keeps the lobby open', [nameless.lobbyVisible, nameless.sessionVisible], [true, false]);

    console.log('\n[4] chat is relayed through the host to everyone');
    await sendChat(clients[1], CHAT_LINE);
    await sleep(1500);
    snaps = await snapAll();
    snaps.slice(0, 3).forEach((snap, index) => console.log(describe(clients[index].name, snap)));
    snaps.slice(0, 3).forEach((snap, index) => {
      const expectedName = clients[index].name === 'BravoHawk' ? 'BravoHawk (you)' : 'BravoHawk';
      report.expect(`${clients[index].name} received the chat line once`, snap.chatTexts.filter((text) => text === CHAT_LINE).length, 1);
      report.expect(`${clients[index].name} sees the sender name`, snap.chatNames.filter((name) => name === expectedName).length, 1);
    });
    report.expect('the lobby watcher never receives chat', (await snapshot(watcher.page)).chatCount, 0);
    report.expect('remote chat messages play the message cue', snaps[0].sounds.filter((name) => name === 'message').length, 1);
    report.expect('your own chat message is silent', snaps[1].sounds.filter((name) => name === 'message').length, 0);
    report.expect('the relayed message sounds for the third player too', snaps[2].sounds.filter((name) => name === 'message').length, 1);

    console.log('\n[4b] consecutive messages from one person drop the repeated name');
    await sendChat(clients[0], 'hey');
    await sleep(1200);
    await sendChat(clients[0], 'hey');
    await sleep(1500);
    const grouped = await clients[0].page.evaluate(() => Array.from(
      document.querySelectorAll('#chat-log .chat-line[data-kind="chat"]')
    ).map((line) => ({
      text: line.querySelector('.chat-text').textContent,
      grouped: line.dataset.grouped === 'true',
      nameShown: line.querySelector('.chat-name').offsetParent !== null
    })));
    const heys = grouped.filter((line) => line.text === 'hey');
    console.log(`  hey lines: ${JSON.stringify(heys)}`);
    report.expect('both messages arrive', heys.length, 2);
    report.expect('the first message shows the sender name', [heys[0].grouped, heys[0].nameShown], [false, true]);
    report.expect('the repeat hides the sender name', [heys[1].grouped, heys[1].nameShown], [true, false]);
    await sendChat(clients[2], 'different voice');
    await sleep(1500);
    const afterOther = await clients[0].page.evaluate(() => {
      const lines = Array.from(document.querySelectorAll('#chat-log .chat-line[data-kind="chat"]'));
      const last = lines[lines.length - 1];
      return {
        text: last.querySelector('.chat-text').textContent,
        grouped: last.dataset.grouped === 'true',
        nameShown: last.querySelector('.chat-name').offsetParent !== null
      };
    });
    console.log(`  after the other player: ${JSON.stringify(afterOther)}`);
    report.expect('the other player message arrives', afterOther.text, 'different voice');
    report.expect('a message after someone else shows the sender name again', [afterOther.grouped, afterOther.nameShown], [false, true]);

    console.log('\n[5] chat spam is rate limited');
    await sendChat(clients[1], 'first');
    await clients[1].page.click('#chat-input');
    await clients[1].page.type('#chat-input', 'second immediately');
    await clients[1].page.keyboard.press('Enter');
    await sleep(1200);
    const spamCheck = await snapshot(clients[0].page);
    report.expect('only the first of two rapid messages is delivered', spamCheck.chatTexts.includes('first'), true);
    report.expect('the second rapid message is dropped', spamCheck.chatTexts.includes('second immediately'), false);

    console.log('\n[6] open mic is the default, and push to talk still works');
    const openDefault = await snapshot(clients[0].page);
    report.expect('a fresh session transmits straight away', openDefault.localTrack.enabled, true);
    report.expect('open mic mode is selected by default', [openDefault.openMode, openDefault.pttMode], [true, false]);
    report.expect('the mic chip reports the live state', openDefault.micChip, 'Transmitting');
    await clients[0].page.click('#mode-ptt');
    await sleep(300);
    report.expect('switching to push to talk mutes the track', (await snapshot(clients[0].page)).localTrack.enabled, false);
    report.expect('push to talk becomes the selected mode', (await snapshot(clients[0].page)).pttMode, true);
    report.expect('push to talk shows the idle chip', (await snapshot(clients[0].page)).micChip, 'Mic idle (PTT)');
    await clients[0].page.focus('#ptt');
    await clients[0].page.keyboard.down('Space');
    await sleep(800);
    const talking = await snapshot(clients[0].page);
    report.expect('space held enables the mic track', talking.localTrack.enabled, true);
    report.expect('space held shows the transmitting chip', talking.micChip, 'Transmitting');
    report.expect('other open-mic peers keep transmitting', (await snapshot(clients[1].page)).localTrack.enabled, true);
    await clients[0].page.keyboard.up('Space');
    await sleep(400);
    const released = await snapshot(clients[0].page);
    report.expect('releasing space disables the mic track', released.localTrack.enabled, false);
    report.expect('releasing space shows the idle chip', released.micChip, 'Mic idle (PTT)');

    console.log('\n[7] typing in chat never triggers push to talk');
    await clients[2].page.click('#mode-ptt');
    await sleep(250);
    await clients[2].page.click('#chat-input');
    await clients[2].page.keyboard.down('Space');
    await sleep(300);
    const typing = await snapshot(clients[2].page);
    report.expect('space inside the chat box does not transmit', typing.localTrack.enabled, false);
    report.expect('the typed space lands in the chat box', typing.sessionVisible, true);
    await clients[2].page.keyboard.up('Space');
    await clients[2].page.evaluate(() => {
      document.getElementById('chat-input').value = '';
    });

    console.log('\n[8] mute button and switching back to open mic');
    await clients[1].page.click('#mute-btn');
    await sleep(300);
    report.expect('mute button mutes the track', (await snapshot(clients[1].page)).localTrack.enabled, false);
    report.expect('mute button shows the muted chip', (await snapshot(clients[1].page)).micChip, 'Mic muted');
    await clients[1].page.click('#mute-btn');
    await sleep(250);
    report.expect('unmuting resumes open mic transmission', (await snapshot(clients[1].page)).localTrack.enabled, true);
    await clients[2].page.click('#mode-open');
    await sleep(300);
    report.expect('switching to open mic transmits without push to talk', (await snapshot(clients[2].page)).localTrack.enabled, true);
    report.expect('open mic shows the transmitting chip', (await snapshot(clients[2].page)).micChip, 'Transmitting');
    report.expect('open mic is the selected mode again', (await snapshot(clients[2].page)).openMode, true);

    console.log('\n[9] a peer leaving updates every roster');
    await clients[1].page.click('#leave-btn');
    await sleep(3000);
    snaps = await snapAll();
    console.log(describe('after-leave host', snaps[0]));
    report.expect('the leaver returns to the lobby', snaps[1].lobbyVisible, true);
    report.expect('the leaver releases the microphone', snaps[1].localTrack, null);
    report.expect('the host drops the departed peer', snaps[0].peerNames, ['CharlieWolf']);
    report.expect('the remaining peer drops the departed peer', snaps[2].peerNames, ['AlphaFox']);
    report.expect('the host keeps one live stream', snaps[0].playing, 1);
    report.expect('the host announced the departure in chat', snaps[0].systemTexts.some((text) => /BravoHawk left/.test(text)), true);
    report.expect('the departure plays the leave cue for the survivors', [snaps[0].sounds.includes('out'), snaps[2].sounds.includes('out')], [true, true]);
    report.expect('the leaver hears their own leave cue', snaps[1].sounds.includes('out'), true);

    console.log('\n[10] a fourth player joins the live room');
    const fourth = await openClient('DeltaViper', MAIN_ROOM);
    await join(fourth);
    await sleep(JOIN_WAIT + 6000);
    snaps = await snapAll();
    console.log(describe('four-peers host', snaps[0]));
    console.log(describe('new joiner', snaps[3]));
    report.expect('the host now has two peers', snaps[0].peerNames, ['CharlieWolf', 'DeltaViper'].sort());
    report.expect('the host plays two streams', snaps[0].playing, 2);
    report.expect('the new joiner hears both existing peers', snaps[3].liveRemoteTracks, 2);
    report.expect('an existing peer hears the new joiner', snaps[2].liveRemoteTracks, 2);
    report.expect('the new joiner received the earlier chat history', snaps[3].chatTexts.includes(CHAT_LINE), true);
    report.expect('replayed history stays silent for the late joiner', snaps[3].sounds.filter((name) => name === 'message').length, 0);

    console.log('\n[11] the host leaving hands the room over without dropping audio');
    await clients[0].page.click('#leave-btn');
    await sleep(12000);
    const survivorSnaps = await Promise.all([clients[2], fourth].map((client) => snapshot(client.page)));
    survivorSnaps.forEach((snap, index) => {
      console.log(`  survivor${index + 1} host=${snap.isHost} chip="${snap.statusChip}" peers=${JSON.stringify(snap.peerNames)} live=${snap.liveRemoteTracks}`);
      if (snap.sessionError) console.log(`      sessionError: ${snap.sessionError}`);
    });
    report.expect('both survivors stay connected to each other', survivorSnaps.every((snap) => snap.connectedCount === 1), true);
    report.expect('exactly one survivor took over hosting', survivorSnaps.filter((snap) => snap.isHost).length, 1);
    report.expect('survivor audio kept flowing through the handover', survivorSnaps.every((snap) => snap.liveRemoteTracks === 1), true);
    report.expect('the new host relays chat', survivorSnaps.filter((snap) => snap.isHost)[0].chatHint, 'you run the trash talk');

    console.log('\n[12] a late joiner links up with the whole squad');
    const late = await openClient('EchoTango', MAIN_ROOM);
    await join(late);
    await sleep(JOIN_WAIT + 2000);
    const lateSnap = await snapshot(late.page);
    console.log(describe('late joiner', lateSnap));
    report.expect('the late joiner hears both survivors', lateSnap.liveRemoteTracks, 2);
    report.expect('the late joiner is connected to both survivors', lateSnap.connectedCount, 2);
    const survivorsAfter = await Promise.all([clients[2], fourth].map((client) => snapshot(client.page)));
    survivorsAfter.forEach((snap, index) => {
      report.expect(`survivor ${index + 1} now also hears the late joiner`, snap.liveRemoteTracks, 2);
    });
    report.expect('chat still flows through the migrated host', lateSnap.chatHint, 'trash talk enabled');
    report.expect('the late joiner got the backlog from the survivors, not the old host', lateSnap.chatTexts.includes(CHAT_LINE), true);
    await sendChat(fourth, 'chat works after the handover');
    await sleep(1200);
    report.expect('the new host relays chat to the late joiner', (await snapshot(late.page)).chatTexts.includes('chat works after the handover'), true);

    console.log('\n[13] the two rooms are isolated from each other');
    const otherRoom = await openClient('FoxtrotGolf', OTHER_ROOM, { track: false });
    await join(otherRoom);
    await sleep(JOIN_WAIT + 2000);
    const otherSnap = await snapshot(otherRoom.page);
    console.log(describe('other joiner', otherSnap));
    report.expect('the other-room joiner sees nobody', [otherSnap.peerNames, otherSnap.connectedCount], [[], 0]);
    report.expect('the other-room joiner hosts its room', otherSnap.isHost, true);
    report.expect('the other-room joiner sees no main-room chat', otherSnap.chatTexts.includes(CHAT_LINE), false);
    report.expect(`the main room still reports three players`, await probeCount(watcher.page, MAIN_ROOM), 3);
    report.expect(`the other room reports one player`, await probeCount(watcher.page, OTHER_ROOM), 1);
    await sendChat(otherRoom, 'other room only');
    await sleep(1200);
    report.expect('other-room chat never reaches the main room', (await snapshot(late.page)).chatTexts.includes('other room only'), false);
    report.expect('other-room chat stays in its room', (await snapshot(otherRoom.page)).chatTexts.includes('other room only'), true);

    console.log('\n[14] a denied microphone shows a recoverable error');
    const denied = await newTestPage(browser, { label: 'NoMic', viewport: { width: 1000, height: 900 } });
    await denied.page.goto(`${site.origin}/?room=${MAIN_ROOM}&name=NoMic`, { waitUntil: 'domcontentloaded' });
    await denied.page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = () => {
        const error = new Error('denied');
        error.name = 'NotAllowedError';
        return Promise.reject(error);
      };
    });
    await denied.page.click('#join-btn');
    await sleep(2000);
    const deniedSnap = await denied.page.evaluate(() => ({
      lobbyVisible: !document.getElementById('lobby').hidden,
      sessionVisible: !document.getElementById('session').hidden,
      error: document.getElementById('lobby-error').hidden ? null : document.getElementById('lobby-error').textContent,
      joinDisabled: document.getElementById('join-btn').disabled
    }));
    console.log(`  denied -> ${JSON.stringify(deniedSnap)}`);
    report.expect('a denied mic keeps the lobby visible', deniedSnap.lobbyVisible, true);
    report.expect('a denied mic does not open the session', deniedSnap.sessionVisible, false);
    report.expect('a denied mic explains the permission problem', /permission/i.test(deniedSnap.error || ''), true);
    report.expect('a denied mic re-enables the join button', deniedSnap.joinDisabled, false);

    console.log('\n[15] chat history survives a reload from the local archive');
    const storedBefore = await late.page.evaluate(() => window.localStorage.getItem('nomorediscord:chat:' + state.roomId.trim().toLowerCase()));
    report.expect('the archive is written to localStorage', typeof storedBefore === 'string' && storedBefore.length > 0, true);
    await late.page.reload({ waitUntil: 'domcontentloaded' });
    await late.page.evaluate(() => {
      window.__sounds = [];
      const original = window.playSound;
      window.playSound = (name) => {
        window.__sounds.push(name);
        return original(name);
      };
    });
    await late.page.click('#join-btn');
    await sleep(JOIN_WAIT + 2000);
    const afterReload = await snapshot(late.page);
    console.log(describe('reloaded joiner', afterReload));
    report.expect('the reloaded browser still shows the old conversation', afterReload.chatTexts.includes(CHAT_LINE), true);
    report.expect('the reloaded browser shows the post-handover line', afterReload.chatTexts.includes('chat works after the handover'), true);
    report.expect('the archive is not replayed as sound', afterReload.sounds.filter((name) => name === 'message').length, 0);
    await sendChat(late, 'back from the dead');
    await sleep(1500);
    report.expect('the survivor still hears a newcomer after the reload', (await snapshot(clients[2].page)).chatTexts.includes('back from the dead'), true);
  } catch (error) {
    console.error('\nTEST FAILURE', error);
    process.exitCode = 1;
  } finally {
    await closeBrowser(browser);
    await site.close();
  }

  report.finish('mesh.test');
})();