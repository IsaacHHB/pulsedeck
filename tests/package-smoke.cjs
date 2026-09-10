const { _electron: electron } = require('playwright');
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
async function main() {
  const results = path.join(__dirname, '..', 'test-results');
  await fs.mkdir(results, { recursive: true });
  const data = await fs.mkdtemp(path.join(results, 'package-'));
  const env = { ...process.env, PULSEDECK_HEADLESS: '1', PULSEDECK_DATA: data }; delete env.ELECTRON_RUN_AS_NODE; delete env.PULSEDECK_TEST;
  // Smoke-tests a packaged build (run `npm run dist` first).
  const executablePath = process.env.PULSEDECK_EXE || (process.platform === 'darwin' ? path.resolve(__dirname, '..', 'dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'PulseDeck.app/Contents/MacOS/PulseDeck') : path.resolve(__dirname, '..', 'dist', 'win-unpacked', 'PulseDeck.exe'));
  const app = await electron.launch({ executablePath, args: process.platform === 'linux' ? ['--no-sandbox'] : [], env, timeout: 30000 });
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(12000);
    await page.waitForFunction(() => Boolean(window.deck) && document.querySelector('#emptyState'));
    const info = await app.evaluate(({ app, BrowserWindow }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(), sandbox: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().sandbox }));
    assert.ok(info.packaged && info.sandbox && info.appPath.endsWith('app.asar'));
    const devices = await page.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).map(d => ({ kind: d.kind, label: d.label })));
    await page.evaluate(() => { document.querySelector('#toast').hidden = true; });
    await page.screenshot({ path: path.join(results, 'packaged-empty.png') });
    console.log(JSON.stringify({ ...info, devices, note: 'Read-only device enumeration. No microphone stream was requested. macOS package runs with the normal sandbox.' }, null, 2));
    await fs.writeFile(path.join(results, 'package-report.json'), JSON.stringify({ ...info, devices, sandboxDisabledForAutomation: process.platform === 'linux', captureStarted: false }, null, 2));
  } finally { await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
