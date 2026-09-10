// Opt-in test: plays two quiet tones separated by silence and records real Mac system audio.
// Run on a quiet Mac with system-audio capture permission: node tests/mac-replay-real.cjs
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
async function until(page, fn) {
  const deadline = Date.now() + 30000;
  while (!await page.evaluate(fn)) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for saved library state');
    await page.waitForTimeout(100);
  }
}
(async () => {
  assert.equal(process.platform, 'darwin');
  const results = path.resolve(__dirname, '../test-results');
  await fs.mkdir(results, { recursive: true });
  const data = process.env.PULSEDECK_REPLAY_RESUME || await fs.mkdtemp(path.join(results, 'real-minute-'));
  const rate = 48000, seconds = 68, bytes = Buffer.alloc(44 + rate * seconds * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let i = 0; i < rate * seconds; i++) {
    const t = i / rate, hz = t < 2 ? 731 : t >= 64 && t < 66 ? 1357 : 0;
    if (hz) bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * t) * 4000), 44 + i * 2);
  }
  const tone = path.join(data, 'timed-tones.wav'); await fs.writeFile(tone, bytes);
  const env = { ...process.env, PULSEDECK_HEADLESS: '1', PULSEDECK_NO_UPDATES: '1', PULSEDECK_DATA: path.join(data, 'library') };
  delete env.ELECTRON_RUN_AS_NODE; delete env.PULSEDECK_TEST;
  const executablePath = process.env.PULSEDECK_EXE || path.resolve(__dirname, '../dist/mac-arm64/PulseDeck.app/Contents/MacOS/PulseDeck');
  const app = await _electron.launch({ executablePath, env });
  const report = { mockedAudio: false, version: '0.6.1' };
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(30000);
    await page.waitForFunction(() => window.deck && document.querySelectorAll('[data-effect]').length === 25);
    report.shortcuts = await app.evaluate(({ globalShortcut }) => ({
      save: globalShortcut.isRegistered('Command+Alt+R'), stop: globalShortcut.isRegistered('Command+Alt+Space'),
      mute: globalShortcut.isRegistered('Command+Alt+M'), overlay: globalShortcut.isRegistered('Command+Alt+O'),
      oldControl: globalShortcut.isRegistered('Control+Alt+R')
    }));
    assert.ok(report.shortcuts.save && report.shortcuts.stop && report.shortcuts.mute && report.shortcuts.overlay && !report.shortcuts.oldControl);
    assert.equal(await page.locator('kbd').filter({ hasText: /^Ctrl$/ }).count(), 0);
    await page.click('#replayNav'); await page.selectOption('#replaySeconds', '60'); await page.check('#replayToggle');
    await page.waitForFunction(() => document.querySelector('#replayArm').classList.contains('armed'));
    console.log(process.env.PULSEDECK_REPLAY_RESUME ? 'Native capture armed. Checking the saved 68-second test run.' : 'Native capture armed. Playing 68-second sequence: two quiet tones with a minute of silence between them.');
    if (!process.env.PULSEDECK_REPLAY_RESUME) {
    const start = Date.now();
    await new Promise((resolve, reject) => { const audio = spawn('/usr/bin/afplay', ['-v', '0.15', tone]); audio.on('error', reject); audio.on('exit', code => code === 0 ? resolve() : reject(new Error(`afplay: ${code}`))); });
    report.elapsedSeconds = (Date.now() - start) / 1000;
    await page.click('#captureBtn');
    } else { report.reusedSavedCapture = true; await page.locator('.capture').first().click(); }
    await until(page, async () => (await window.deck.getLibrary()).captures.length === 1 && !document.querySelector('#editor').hidden);
    report.fullMinute = await page.evaluate(async () => {
      const capture = (await window.deck.getLibrary()).captures[0];
      const bytes = new Uint8Array(await window.deck.readCapture(capture.id));
      const ctx = new AudioContext({ sinkId: { type: 'none' } });
      const buffer = await ctx.decodeAudioData(bytes.buffer), samples = buffer.getChannelData(0);
      function strongest(hz) {
        let best = 0;
        const size = 4800, k = 2 * Math.cos(2 * Math.PI * hz / buffer.sampleRate);
        for (let start = 0; start + size <= samples.length; start += size) {
          let a = 0, b = 0;
          for (let i = start; i < start + size; i++) { const c = samples[i] + k * a - b; b = a; a = c; }
          best = Math.max(best, Math.sqrt(Math.max(0, a * a + b * b - k * a * b)) * 2 / size);
        }
        return best;
      }
      const result = { duration: buffer.duration, samples: samples.length, sampleRate: buffer.sampleRate, earlyTone: strongest(731), lateTone: strongest(1357), metadataDuration: capture.duration };
      await ctx.close(); return result;
    });
    console.log('Minute check:', report.fullMinute);
    assert.equal(report.fullMinute.duration, 60);
    assert.equal(report.fullMinute.samples, 60 * report.fullMinute.sampleRate);
    assert.equal(report.fullMinute.metadataDuration, 60);
    assert.ok(report.fullMinute.lateTone > 0.001, 'recent tone is missing');
    assert.ok(report.fullMinute.earlyTone < report.fullMinute.lateTone * 0.2, 'audio older than 60 seconds remains');
    // Trim through the actual editor and decode the soundboard file written by the app.
    await page.click('#selectAllBtn');
    await page.fill('#trimStart', '54'); await page.fill('#trimEnd', '59');
    await page.fill('#captureName', 'Mac minute verification'); await page.locator('#captureName').press('Tab');
    await page.click('#addCaptureBtn');
    await until(page, async () => (await window.deck.getLibrary()).clips.length === 1);
    report.trim = await page.evaluate(async () => {
      const clip = (await window.deck.getLibrary()).clips[0];
      const bytes = new Uint8Array(await window.deck.readSound(clip.id));
      const ctx = new AudioContext({ sinkId: { type: 'none' } }); const buffer = await ctx.decodeAudioData(bytes.buffer);
      const result = { duration: buffer.duration, samples: buffer.length, sampleRate: buffer.sampleRate, nonzero: buffer.getChannelData(0).some(n => Math.abs(n) > 0.001) }; await ctx.close(); return result;
    });
    assert.equal(report.trim.duration, 5); assert.ok(report.trim.nonzero);
    await page.waitForTimeout(1200);
    console.log('Before shortcut:', await page.evaluate(() => ({ armed: document.querySelector('#replayArm').classList.contains('armed'), toast: document.querySelector('#toast').textContent })));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle() === 'PulseDeck').webContents.send('shortcut', { type: 'capture' }));
    await until(page, async () => (await window.deck.getLibrary()).captures.length === 2);
    const overlayPromise = app.waitForEvent('window'); await page.click('#overlayBtn'); const overlay = await overlayPromise;
    await overlay.waitForFunction(() => !document.querySelector('#clipBtn').hidden); await overlay.click('#clipBtn');
    await until(page, async () => (await window.deck.getLibrary()).captures.length === 3);
    assert.match(await overlay.locator('#clipBtn').getAttribute('title'), /Cmd\+Option\+R/);
    report.savedByButtonShortcutAndOverlay = true;
    await page.uncheck('#replayToggle');
    await page.screenshot({ path: path.join(results, 'mac-minute-verified.png') });
    await page.reload();
    await until(page, async () => (await window.deck.getLibrary()).captures.length === 3);
    report.persisted = await page.evaluate(async () => { const s = await window.deck.getLibrary(); return s.clips.length === 1 && s.captures.length === 3; });
    assert.ok(report.persisted);
    await fs.writeFile(path.join(results, 'mac-minute-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
