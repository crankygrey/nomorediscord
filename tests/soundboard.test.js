const { startServer } = require('./static-server');
const { launchBrowser, newTestPage, closeBrowser, sleep } = require('./browser');
const { Report } = require('./report');

const PORT = Number(process.env.PORT || 8795);
const RUN_ID = Math.random().toString(36).slice(2, 7);
const ROOM = `board-${RUN_ID}`;

// Reads the RMS of one teammate's incoming stream, which is the only honest
// way to know a soundboard clip made it across the WebRTC mesh.
function listenFor(page, ms) {
  return page.evaluate(async (duration) => {
    const entry = Array.from(state.peers.values())[0];
    if (!entry || !entry.stream) {
      return { peak: -1, avg: -1, samples: 0 };
    }
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(entry.stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    let peak = 0;
    let sum = 0;
    let samples = 0;
    const until = performance.now() + duration;
    while (performance.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      analyser.getFloatTimeDomainData(buffer);
      let acc = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        acc += buffer[i] * buffer[i];
      }
      const rms = Math.sqrt(acc / buffer.length);
      if (rms > peak) {
        peak = rms;
      }
      sum += rms;
      samples += 1;
    }
    await ctx.close();
    return { peak, avg: sum / samples, samples };
  }, ms);
}

(async () => {
  const report = new Report();
  const site = await startServer(PORT);
  const browser = await launchBrowser();

  try {
    const open = async (name) => {
      const client = await newTestPage(browser, { label: name, viewport: { width: 1440, height: 900 } });
      await client.page.goto(`${site.origin}/?trace=1&room=${ROOM}&name=${name}`, { waitUntil: 'domcontentloaded' });
      return client;
    };

    console.log('\n[1] the session shows a three-clip soundboard');
    const sender = await open('Alpha');
    const listener = await open('Bravo');
    await sender.page.click('#join-btn');
    await sleep(800);
    await listener.page.click('#join-btn');
    await sleep(7000);

    const setup = await sender.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('#soundboard .snd'));
      const bar = document.getElementById('soundboard');
      return {
        mixer: Boolean(state.mixer),
        ctxState: state.mixer ? state.mixer.ctx.state : null,
        clipsCached: state.mixer ? state.mixer.clips.size : -1,
        boardOffline: state.mixer ? state.mixer.boardOffline : null,
        lines: Array.from(document.querySelectorAll('#chat-log .chat-line')).map((li) => li.textContent),
        outgoingTracks: state.localStream ? state.localStream.getAudioTracks().length : -1,
        ids: buttons.map((button) => button.dataset.snd),
        labels: buttons.map((button) => button.textContent.trim()),
        locked: buttons.some((button) => button.disabled),
        between:
          bar.getBoundingClientRect().bottom <= document.querySelector('.controls').getBoundingClientRect().top + 1
      };
    });
    console.log(`  setup -> ${JSON.stringify(setup)}`);
    report.expect('the mixer is running', [setup.mixer, setup.ctxState], [true, 'running']);
    report.expect('all three clips are preloaded at join', setup.clipsCached, 3);
    report.expect('nothing failed at preload', [setup.boardOffline, setup.lines.some((line) => /Soundboard is offline/.test(line))], [false, false]);
    report.expect('the outgoing stream is one mixed track', setup.outgoingTracks, 1);
    report.expect('the three buttons are there', setup.ids, ['ahh', 'horn', 'toot']);
    report.expect('every button is labelled', setup.labels.length, 3);
    report.expect('no button starts locked', setup.locked, false);
    report.expect('the bar sits above the controls', setup.between, true);

    console.log('\n[2] a muted player can still blast the soundboard');
    await sender.page.click('#mute-btn');
    await sleep(1500);

    const mutedBaseline = await listenFor(listener.page, 1500);
    console.log(`  muted baseline -> ${JSON.stringify(mutedBaseline)}`);
    report.expect('a muted mic sends silence', mutedBaseline.peak < 0.005, true);

    await sender.page.click('.snd[data-snd="horn"]');
    await sleep(700);

    const during = await sender.page.evaluate(() => ({
      soundActive: state.soundActive,
      locked: document.querySelector('.snd[data-snd="horn"]').disabled,
      mark: document.querySelector('.snd[data-snd="horn"]').classList.contains('playing'),
      trackEnabled: state.localStream.getAudioTracks()[0].enabled,
      micGain: state.mixer.micGain.gain.value
    }));
    console.log(`  during -> ${JSON.stringify(during)}`);
    report.expect('the clip counts as active', during.soundActive, 1);
    report.expect('the button locks while the clip plays', [during.locked, during.mark], [true, true]);
    report.expect('the mic stays gated under the clip', [during.trackEnabled, during.micGain], [true, 0]);

    const heard = await listenFor(listener.page, 2500);
    console.log(`  heard -> ${JSON.stringify(heard)}`);
    report.expectAtLeast('the clip reaches the teammate', Number(heard.peak.toFixed(4)), 0.01);

    const lines = await listener.page.evaluate(() =>
      Array.from(document.querySelectorAll('#chat-log .chat-line')).map((li) => li.textContent));
    console.log(`  listener lines -> ${JSON.stringify(lines)}`);
    report.expect('the teammate is told who played what', lines.some((line) => /Alpha played Sad horn/.test(line)), true);

    console.log('\n[3] everything resets when the clip ends');
    await sleep(5200);
    const after = await sender.page.evaluate(() => ({
      soundActive: state.soundActive,
      locked: document.querySelector('.snd[data-snd="horn"]').disabled,
      trackEnabled: state.localStream.getAudioTracks()[0].enabled,
      micGain: state.mixer.micGain.gain.value
    }));
    console.log(`  after -> ${JSON.stringify(after)}`);
    report.expect('the counter returns to zero', after.soundActive, 0);
    report.expect('the button unlocks', after.locked, false);
    report.expect('A is muted again once the clip is over', [after.trackEnabled, after.micGain], [false, 0]);

    const stillSilent = await listenFor(listener.page, 1200);
    report.expect('A stays silent after the clip', stillSilent.peak < 0.005, true);

    await sender.page.click('#mute-btn');
    await sleep(1200);
    const unmuted = await listenFor(listener.page, 1500);
    console.log(`  unmuted -> ${JSON.stringify(unmuted)}`);
    report.expectAtLeast('unmuting brings the mic back', Number(unmuted.peak.toFixed(4)), 0.01);

    console.log('\n[4] the bar fits narrow screens');
    for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 700 }]) {
      await sender.page.setViewport(viewport);
      await sleep(600);
      const fit = await sender.page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        clipped: Array.from(document.querySelectorAll('#soundboard .snd'))
          .some((button) => button.scrollWidth > button.clientWidth + 1),
        order: (() => {
          const bar = document.getElementById('soundboard');
          const body = document.querySelector('.session-body');
          const controls = document.querySelector('.controls');
          return bar.getBoundingClientRect().top >= body.getBoundingClientRect().bottom - 1
            && bar.getBoundingClientRect().bottom <= controls.getBoundingClientRect().top + 1;
        })()
      }));
      console.log(`  ${viewport.width}px -> ${JSON.stringify(fit)}`);
      report.expect(`${viewport.width}px has no horizontal overflow`, fit.overflow <= 0, true);
      report.expect(`${viewport.width}px keeps every label`, fit.clipped, false);
      report.expect(`${viewport.width}px keeps the bar between body and controls`, fit.order, true);
    }
  } finally {
    await closeBrowser(browser);
    await site.close();
  }

  report.finish('soundboard.test');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
