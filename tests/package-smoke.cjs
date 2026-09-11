const { _electron: electron } = require('playwright');
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const MODULES = ['playback-region.js', 'waveform.js', 'region-editor.js', 'studio-model.js', 'studio-audio.js', 'studio-ui.js', 'dialogs.js', 'recorder.js', 'recorder-ui.js', 'recorder-worklet.js', 'ducking-worklet.js', 'limiter-worklet.js', 'replay-worklet.js', 'queue.js', 'queue-ui.js', 'tts-ui.js', 'tts.cjs', 'projects.cjs', 'backup.cjs', 'wav-header.cjs', 'library.cjs'];
async function main() {
  const results = path.join(__dirname, '..', 'test-results');
  await fs.mkdir(results, { recursive: true });
  const data = await fs.mkdtemp(path.join(results, 'package-'));
  const env = { ...process.env, PULSEDECK_HEADLESS: '1', PULSEDECK_DATA: data }; delete env.ELECTRON_RUN_AS_NODE; delete env.PULSEDECK_TEST; delete env.PULSEDECK_TTS;
  // Smoke-tests a packaged build (run `npm run dist` first).
  const executablePath = process.env.PULSEDECK_EXE || (process.platform === 'darwin' ? path.resolve(__dirname, '..', 'dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'PulseDeck.app/Contents/MacOS/PulseDeck') : path.resolve(__dirname, '..', 'dist', 'win-unpacked', 'PulseDeck.exe'));
  const app = await electron.launch({ executablePath, args: process.platform === 'linux' ? ['--no-sandbox'] : [], env, timeout: 30000 });
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(20000);
    await page.waitForFunction(() => Boolean(window.deck) && document.querySelector('#emptyState'));
    const info = await app.evaluate(({ app, BrowserWindow }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(), sandbox: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().sandbox }));
    assert.ok(info.packaged && info.sandbox && info.appPath.endsWith('app.asar'));
    assert.equal(await page.locator('#updateBtn').isVisible(), false, 'Packaged app must not offer restart before downloading an update');
    const present = await app.evaluate(({ app }, modules) => { const fs = process.getBuiltinModule('node:fs'), path = process.getBuiltinModule('node:path'); return modules.filter(m => fs.existsSync(path.join(app.getAppPath(), m))); }, MODULES);
    assert.deepEqual(present, MODULES, 'every feature module is packaged');
    const leaked = await app.evaluate(({ app }) => ['workorders', 'tests', 'test-results'].filter(d => process.getBuiltinModule('node:fs').existsSync(process.getBuiltinModule('node:path').join(app.getAppPath(), d))));
    assert.deepEqual(leaked, [], 'no work orders or tests in the package');
    // The packaged renderer loads every worklet from the archive (no device is opened).
    const worklets = await page.evaluate(async () => {
      const ctx = new OfflineAudioContext(2, 128, 48000);
      for (const file of ['./limiter-worklet.js', './ducking-worklet.js', './recorder-worklet.js', './replay-worklet.js']) await ctx.audioWorklet.addModule(file);
      return 'loaded';
    });
    // Real installed voices through the packaged helper path.
    const speech = await page.evaluate(async () => {
      const tts = await window.deck.ttsInfo();
      if (!tts.available) return { available: false, label: tts.label };
      const voices = await window.deck.ttsVoices(true);
      const voice = voices.find(v => v.available && /^en/i.test(v.language)) || voices.find(v => v.available);
      if (!voice) return { available: true, voices: 0 };
      const started = performance.now();
      const result = await window.deck.ttsSynthesize({ requestId: 'package-smoke', text: 'Hello team, the match starts now', voiceId: voice.id, speed: 0 });
      const bytes = new Uint8Array(result.bytes), view = new DataView(bytes.buffer, bytes.byteOffset);
      return { available: true, provider: tts.provider, voice: `${voice.name} (${voice.language})`, voices: voices.length, ms: Math.round(performance.now() - started), riff: String.fromCharCode(...bytes.slice(0, 4)), rate: view.getUint32(24, true), seconds: result.duration };
    });
    if (speech.available && speech.voices) assert.ok(speech.riff === 'RIFF' && speech.rate === 48000 && speech.seconds > 0.8, JSON.stringify(speech));
    const devices = await page.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).map(d => ({ kind: d.kind, label: d.label })));
    await page.evaluate(() => { document.querySelector('#toast').hidden = true; });
    await page.screenshot({ path: path.join(results, 'packaged-empty.png') });
    const report = { ...info, modules: present.length, worklets, speech, devices, sandboxDisabledForAutomation: process.platform === 'linux', captureStarted: false };
    console.log(JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(results, 'package-report.json'), JSON.stringify(report, null, 2));
  } finally { await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
