// Opt-in: quit PulseDeck first. Launches the installed app through macOS, so TCC
// uses PulseDeck's permissions instead of the terminal's. Plays two quiet tones.
const { chromium } = require('playwright');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

async function until(fn) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { if (await fn()) return; } catch { /* app may still be starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for PulseDeck');
}

(async () => {
  assert.equal(process.platform, 'darwin');
  const results = path.resolve(__dirname, '../test-results');
  await fs.mkdir(results, { recursive: true });
  const data = await fs.mkdtemp(path.join(results, 'launch-services-'));
  const rate = 48000, bytes = Buffer.alloc(44 + rate * 68 * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let i = 0; i < rate * 68; i++) {
    const t = i / rate, hz = t < 2 ? 731 : t >= 64 && t < 66 ? 1357 : 0;
    if (hz) bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * t) * 4000), 44 + i * 2);
  }
  const tone = path.join(data, 'tones.wav'); await fs.writeFile(tone, bytes);
  execFileSync('/usr/bin/open', ['-n', '-g', '--env', `PULSEDECK_DATA=${path.join(data, 'library')}`,
    '--env', 'PULSEDECK_HEADLESS=1', '--env', 'PULSEDECK_NO_UPDATES=1',
    '/Applications/PulseDeck.app', '--args', '--remote-debugging-port=9447', '--remote-debugging-address=127.0.0.1', '--inspect=9448']);
  let browser, pid;
  try {
    await until(async () => (await fetch('http://127.0.0.1:9448/json/list')).ok);
    const [target] = await (await fetch('http://127.0.0.1:9448/json/list')).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
    const infoPromise = new Promise(resolve => ws.addEventListener('message', event => {
      const result = JSON.parse(event.data); if (result.id === 1) resolve(result.result.result.value);
    }));
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
      expression: `({pid:process.pid,screenPermission:process.mainModule.require('electron').systemPreferences.getMediaAccessStatus('screen')})`, returnByValue: true
    } }));
    const info = await infoPromise; ws.close(); pid = info.pid;
    if (process.env.PULSEDECK_EXPECT_SCREEN_DENIED === '1') assert.equal(info.screenPermission, 'denied');
    browser = await chromium.connectOverCDP('http://127.0.0.1:9447');
    const page = browser.contexts()[0].pages().find(p => p.url().endsWith('/index.html'));
    await until(() => page.evaluate(() => window.deck && document.querySelector('#versionBtn').textContent.includes('PulseDeck · v')));
    await page.click('#replayNav'); await page.check('#replayToggle');
    await until(() => page.evaluate(() => document.querySelector('#replayArm').classList.contains('armed')));
    console.log('Replay armed through a normal Mac launch. Screen permission:', info.screenPermission);
    await new Promise((resolve, reject) => {
      const audio = spawn('/usr/bin/afplay', ['-v', '0.15', tone]);
      audio.on('error', reject); audio.on('exit', code => code === 0 ? resolve() : reject(new Error(`afplay: ${code}`)));
    });
    await page.click('#replayNav');
    await page.click('#captureBtn');
    await until(() => page.evaluate(async () => (await window.deck.getLibrary()).captures.length === 1));
    const report = await page.evaluate(async () => {
      const capture = (await window.deck.getLibrary()).captures[0];
      const ctx = new AudioContext({ sinkId: { type: 'none' } });
      const buffer = await ctx.decodeAudioData(new Uint8Array(await window.deck.readCapture(capture.id)).buffer);
      const samples = buffer.getChannelData(0), size = 4800;
      function strongest(hz) {
        let best = 0; const k = 2 * Math.cos(2 * Math.PI * hz / buffer.sampleRate);
        for (let start = 0; start + size <= samples.length; start += size) {
          let a = 0, b = 0;
          for (let i = start; i < start + size; i++) { const c = samples[i] + k * a - b; b = a; a = c; }
          best = Math.max(best, Math.sqrt(Math.max(0, a * a + b * b - k * a * b)) * 2 / size);
        }
        return best;
      }
      const result = { version: await window.deck.version(), duration: buffer.duration, samples: buffer.length,
        sampleRate: buffer.sampleRate, earlyTone: strongest(731), lateTone: strongest(1357) };
      await ctx.close(); return result;
    });
    assert.equal(report.duration, 60); assert.equal(report.samples, report.sampleRate * 60);
    assert.ok(report.lateTone > 0.001, 'Recent system audio missing');
    assert.ok(report.earlyTone < report.lateTone * 0.2, 'Audio older than 60 seconds remains');
    await page.fill('#trimStart', '54'); await page.fill('#trimEnd', '59'); await page.click('#addCaptureBtn');
    await until(() => page.evaluate(async () => (await window.deck.getLibrary()).clips.length === 1));
    const trimmed = await page.evaluate(async () => {
      const clip = (await window.deck.getLibrary()).clips[0];
      const ctx = new AudioContext({ sinkId: { type: 'none' } });
      const buffer = await ctx.decodeAudioData(new Uint8Array(await window.deck.readSound(clip.id)).buffer);
      const result = { duration: buffer.duration, audible: buffer.getChannelData(0).some(x => Math.abs(x) > 0.001) };
      await ctx.close(); return result;
    });
    assert.equal(trimmed.duration, 5); assert.ok(trimmed.audible);
    await page.reload();
    await until(() => page.evaluate(async () => (await window.deck.getLibrary()).captures.length === 1));
    const fullReport = { ...report, ...info, trimmed, persisted: true, launch: 'macOS Launch Services', mockedAudio: false };
    await fs.writeFile(path.join(results, 'mac-audio-permission-report.json'), JSON.stringify(fullReport, null, 2));
    console.log(fullReport);
  } finally {
    await browser?.close();
    if (pid) { try { process.kill(pid, 'SIGTERM'); } catch { /* already closed */ } }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
