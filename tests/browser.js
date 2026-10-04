const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME_CANDIDATES = [
  ['PROGRAMFILES', 'Google\\Chrome\\Application\\chrome.exe'],
  ['PROGRAMFILES(X86)', 'Google\\Chrome\\Application\\chrome.exe'],
  ['LOCALAPPDATA', 'Google\\Chrome\\Application\\chrome.exe'],
  ['PROGRAMFILES', 'Microsoft\\Edge\\Application\\msedge.exe'],
  ['PROGRAMFILES(X86)', 'Microsoft\\Edge\\Application\\msedge.exe']
];

function findBrowser() {
  if (process.env.CHROME_PATH) {
    if (!fs.existsSync(process.env.CHROME_PATH)) {
      throw new Error(`CHROME_PATH does not exist: ${process.env.CHROME_PATH}`);
    }
    return process.env.CHROME_PATH;
  }

  const found = CHROME_CANDIDATES
    .map(([envKey, relative]) => path.join(process.env[envKey] || '', relative))
    .find((candidate) => fs.existsSync(candidate));

  if (!found) {
    throw new Error('Chrome or Edge was not found. Set CHROME_PATH to the browser executable.');
  }
  return found;
}

function launchBrowser(options) {
  const settings = options || {};
  return puppeteer.launch({
    executablePath: findBrowser(),
    headless: 'new',
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
      '--disable-dev-shm-usage'
    ].concat(settings.extraArgs || [])
  });
}

async function newTestPage(browser, settings) {
  const options = settings || {};
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  if (options.viewport) {
    await page.setViewport(options.viewport);
  }
  page.on('pageerror', (error) => console.log(`  [${options.label || 'page'}][pageerror] ${error.message}`));
  return { context, page };
}

async function closeBrowser(browser) {
  if (!browser) {
    return;
  }
  const process_ = browser.process();
  try {
    await browser.close();
  } catch (error) {
    void error;
  }
  // Puppeteer can leave the browser process alive, which would keep stale peers
  // connected to the shared rooms and pollute the next run.
  if (process_ && !process_.killed) {
    try {
      process_.kill();
    } catch (error) {
      void error;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { findBrowser, launchBrowser, newTestPage, closeBrowser, sleep };