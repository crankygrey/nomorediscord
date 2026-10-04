const { startServer } = require('./static-server');
const { launchBrowser, newTestPage, closeBrowser } = require('./browser');
const { Report } = require('./report');

const PORT = Number(process.env.LAYOUT_PORT || 8792);
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'tablet', width: 900, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'small', width: 320, height: 700 }
];

function inspect(page, showSession) {
  return page.evaluate((session) => {
    const lobby = document.getElementById('lobby');
    const sessionPanel = document.getElementById('session');

    if (session) {
      lobby.hidden = true;
      sessionPanel.hidden = false;
      document.getElementById('room-name').textContent = 'Roshan';
      document.getElementById('callsign').textContent = 'SwiftFox';
      document.getElementById('peer-count').textContent = '4';
      document.getElementById('peer-empty').hidden = true;

      const list = document.getElementById('peer-list');
      list.textContent = '';
      [
        ['SwiftFox (you)', 'connected', ['Host', 'You']],
        ['IronWolf', 'connected', []],
        ['NeonViper', 'connected', []],
        ['RapidLynx', 'connecting', []]
      ].forEach(([name, status, tags]) => {
        const item = document.createElement('li');
        item.className = name.includes('(you)') ? 'peer self' : 'peer';
        item.dataset.status = status;

        const dot = document.createElement('span');
        dot.className = 'peer-dot';
        const label = document.createElement('span');
        label.className = 'peer-name';
        label.textContent = name;
        item.append(dot, label);

        tags.forEach((tagText) => {
          const tag = document.createElement('span');
          tag.className = `tag ${tagText === 'Host' ? 'host' : 'you'}`;
          tag.textContent = tagText;
          item.appendChild(tag);
        });

        if (!name.includes('(you)')) {
          const stateText = document.createElement('span');
          stateText.className = 'peer-state';
          stateText.textContent = status === 'connected' ? 'connected' : 'connecting...';
          item.appendChild(stateText);
        }
        list.appendChild(item);
      });

      const log = document.getElementById('chat-log');
      log.textContent = '';
      const line = (kind, name, text) => {
        const item = document.createElement('li');
        item.className = 'chat-line';
        item.dataset.kind = kind;
        item.dataset.self = String(kind === 'chat' && name === 'SwiftFox');

        const time = document.createElement('time');
        time.textContent = '20:02';
        item.appendChild(time);

        if (kind === 'chat') {
          const who = document.createElement('span');
          who.className = 'chat-name';
          who.textContent = item.dataset.self ? `${name} (you)` : name;
          const body = document.createElement('span');
          body.className = 'chat-text';
          body.textContent = text;
          item.append(who, body);
        } else {
          const body = document.createElement('span');
          body.textContent = text;
          item.appendChild(body);
        }
        log.appendChild(item);
      };

      line('system', null, 'You opened Roshan. Mind the ramps.');
      line('system', null, 'IronWolf joined.');
      line('chat', 'IronWolf', 'anyone up for one more?');
      line('chat', 'SwiftFox', 'loading now, two minutes');
    }

    const problems = [];
    const width = window.innerWidth;
    document.querySelectorAll('#lobby *, #session *').forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        return;
      }
      if (rect.right > width + 1 || rect.left < -1) {
        problems.push(`${el.tagName}.${el.className || el.id} spans ${Math.round(rect.left)}..${Math.round(rect.right)}`);
      }
      if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2 && el.tagName !== 'INPUT') {
        problems.push(`${el.tagName}.${el.className || el.id} clips text (${el.scrollWidth} > ${el.clientWidth})`);
      }
    });

    return {
      viewport: width,
      scrollWidth: document.documentElement.scrollWidth,
      problems,
      pttClipped: (() => {
        const ptt = document.getElementById('ptt');
        return ptt.scrollWidth > ptt.clientWidth + 2;
      })()
    };
  }, showSession);
}

(async () => {
  const report = new Report();
  const site = await startServer(PORT);
  const browser = await launchBrowser({ extraArgs: [] });

  try {
    for (const viewport of VIEWPORTS) {
      const client = await newTestPage(browser, { label: viewport.name, viewport });
      await client.page.goto(`${site.origin}/`, { waitUntil: 'domcontentloaded' });
      await new Promise((resolve) => setTimeout(resolve, 400));

      const lobby = await inspect(client.page, false);
      console.log(`${viewport.name}/${viewport.width}px lobby: scrollWidth=${lobby.scrollWidth} problems=${lobby.problems.length}`);
      report.expect(`${viewport.name} lobby has no horizontal overflow`, lobby.scrollWidth <= lobby.viewport + 1, true);
      report.expect(`${viewport.name} lobby has no clipped elements`, lobby.problems, []);

      const session = await inspect(client.page, true);
      console.log(`${viewport.name}/${viewport.width}px session: scrollWidth=${session.scrollWidth} problems=${session.problems.length}`);
      if (session.problems.length) {
        session.problems.forEach((problem) => console.log(`      ${problem}`));
      }
      report.expect(`${viewport.name} session has no horizontal overflow`, session.scrollWidth <= session.viewport + 1, true);
      report.expect(`${viewport.name} push-to-talk label fits`, session.pttClipped, false);
      report.expect(`${viewport.name} session has no clipped elements`, session.problems, []);

      await client.context.close();
    }
  } catch (error) {
    console.error('LAYOUT FAILURE', error);
    process.exitCode = 1;
  } finally {
    await closeBrowser(browser);
    await site.close();
  }

  report.finish('layout.test');
})();