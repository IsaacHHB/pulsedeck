/**
 * End-to-end checks for regions, Studio, recording, speech, organization, queue, ducking, export, and backup.
 * The real app runs with PULSEDECK_TEST=1. Only hardware is stubbed (output sinks, microphone/system streams,
 * device lists, media-element sinks, native dialogs). Mixing, decoding, worklets, persistence, and IPC are real;
 * audio is verified by recording what actually reaches the soundboard bus.
 */
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.join(__dirname, '..');
const results = path.join(root, 'test-results');
const RATE = 48000;

/** 60 s fixture whose pitch encodes time: second k is a sine at 300 + 20k Hz. Seconds 50–54 are silent. */
function timecodeWav(seconds = 60) {
  const frames = RATE * seconds, data = Buffer.alloc(44 + frames * 2);
  header(data, frames, 1);
  let phase = 0;
  for (let i = 0; i < frames; i++) {
    const second = Math.floor(i / RATE);
    phase += 2 * Math.PI * (300 + 20 * second) / RATE;
    const amplitude = second >= 50 && second < 55 ? 0 : 0.3;
    data.writeInt16LE(Math.round(Math.sin(phase) * amplitude * 32767), 44 + i * 2);
  }
  return data;
}
function header(data, frames, channels) {
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(channels, 22);
  data.writeUInt32LE(RATE, 24); data.writeUInt32LE(RATE * 2 * channels, 28); data.writeUInt16LE(2 * channels, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(frames * 2 * channels, 40);
}
function toneWav(hz, seconds, amplitude = 0.3) {
  const frames = Math.round(RATE * seconds), data = Buffer.alloc(44 + frames * 2);
  header(data, frames, 1);
  for (let i = 0; i < frames; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * i / RATE) * amplitude * 32767), 44 + i * 2);
  return data;
}
const sha = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
async function until(page, fn, arg, timeout = 15000) {
  const started = Date.now();
  while (true) {
    if (await page.evaluate(fn, arg)) return;
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for: ' + fn.toString().slice(0, 160));
    await pause(page,100);
  }
}

/**
 * Waits for `ms` of audio time. On busy CI machines the audio clock can run slower than the wall clock,
 * so waits that let audio play (or let taps flush) follow the engine's clock. Before the engine exists it
 * falls back to wall time.
 */
async function pause(page, ms) {
  const target = await page.evaluate(s => { const ctx = window.__test?.engine?.context; return ctx && ctx.state === 'running' ? ctx.currentTime + s : null; }, ms / 1000).catch(() => null);
  if (target === null) { await new Promise(resolve => setTimeout(resolve, ms)); return; }
  // Poll on a timer: the default polls on animation frames, which barely run in the hidden test window.
  await page.waitForFunction(t => (window.__test?.engine?.context?.currentTime ?? Infinity) >= t, target, { timeout: Math.max(30000, ms * 8), polling: 25 });
}

/** Replaces only the hardware boundary inside the page. */
async function stubHardware(page) {
  await page.evaluate(() => {
    window.testSinks = []; window.testSinkFailure = false; window.testMediaSinks = []; window.testMediaSinkFailure = false;
    AudioContext.prototype.setSinkId = async function(id) { window.testSinks.push(id); if (window.testSinkFailure) throw new DOMException('Output device is unavailable', 'NotFoundError'); };
    window.testTracks = []; window.testMicHz = 880; window.testMicGain = 0.2;
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext({ sampleRate: 48000, sinkId: { type: 'none' } });
      const oscillator = ctx.createOscillator(), gain = ctx.createGain(), destination = ctx.createMediaStreamDestination();
      oscillator.frequency.value = window.testMicHz; gain.gain.value = window.testMicGain; oscillator.connect(gain); gain.connect(destination); oscillator.start(); await ctx.resume();
      window.testMicGainNode = gain;
      window.testTracks.push(...destination.stream.getTracks()); return destination.stream;
    };
    navigator.mediaDevices.getDisplayMedia = async () => navigator.mediaDevices.getUserMedia();
    window.testDevices = [
      { kind: 'audioinput', deviceId: 'test-mic', label: 'Test physical microphone' },
      { kind: 'audioinput', deviceId: 'test-mic-2', label: 'Second test microphone' },
      { kind: 'audiooutput', deviceId: 'test-cable', label: window.deck.platform === 'darwin' ? 'BlackHole 2ch' : 'CABLE Input (test)' },
      { kind: 'audiooutput', deviceId: 'test-phones', label: 'Test headphones' }
    ];
    navigator.mediaDevices.enumerateDevices = async () => window.testDevices;
    HTMLMediaElement.prototype.setSinkId = async function(id) { window.testMediaSinks.push(id); window.testMonitorSink = id; if (window.testMediaSinkFailure) throw new DOMException('Headphones unavailable', 'NotFoundError'); };
    HTMLMediaElement.prototype.play = async function() {};
  });
}

/** Records what reaches a node of the real engine (the soundboard bus by default). */
async function installTap(page, node = 'board') {
  await page.evaluate(async node => {
    const { engine } = window.__test;
    await engine.init();
    const ctx = engine.context;
    window.taps = window.taps || {};
    const tap = { chunks: [], on: false, processor: ctx.createScriptProcessor(2048, 2, 2) };
    tap.processor.onaudioprocess = event => {
      if (!tap.on) return;
      tap.chunks.push([new Float32Array(event.inputBuffer.getChannelData(0)), new Float32Array(event.inputBuffer.getChannelData(1))]);
    };
    const silent = ctx.createGain(); silent.gain.value = 0;
    engine[node].connect(tap.processor); tap.processor.connect(silent); silent.connect(ctx.destination);
    window.taps[node] = tap;
  }, node);
}
const tapStart = (page, node = 'board') => page.evaluate(node => { const tap = window.taps[node]; tap.chunks = []; tap.on = true; }, node);
/** Stops recording and summarizes: audible span, pitch at the start and end of the audible span, and peak. */
async function tapStop(page, node = 'board', { threshold = 0.01 } = {}) {
  return page.evaluate(({ node, threshold }) => {
    const tap = window.taps[node]; tap.on = false;
    const length = tap.chunks.reduce((n, c) => n + c[0].length, 0), left = new Float32Array(length), right = new Float32Array(length);
    let offset = 0; for (const [l, r] of tap.chunks) { left.set(l, offset); right.set(r, offset); offset += l.length; }
    window.lastTap = { left, right };
    let first = -1, last = -1, peak = 0;
    for (let i = 0; i < length; i++) { const v = Math.abs(left[i]); if (v > peak) peak = v; if (v > threshold) { if (first < 0) first = i; last = i; } }
    const hz = (from, to) => { let crossings = 0; for (let i = Math.max(1, from); i < Math.min(length, to); i++) if ((left[i - 1] < 0) !== (left[i] < 0)) crossings++; return crossings / 2 / ((Math.min(length, to) - Math.max(1, from)) / 48000); };
    const audible = first < 0 ? 0 : (last - first + 1) / 48000;
    return { seconds: length / 48000, audible, peak, startHz: first < 0 ? 0 : hz(first + 2400, first + 12000), endHz: first < 0 ? 0 : hz(last - 12000, last - 2400) };
  }, { node, threshold });
}

async function launch(dataDir) {
  const env = { ...process.env, PULSEDECK_TEST: '1', PULSEDECK_DATA: dataDir }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['--no-sandbox', root], env, timeout: 30000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') console.log('renderer:', message.text()); });
  await page.waitForFunction(() => Boolean(window.deck && window.__test));
  await stubHardware(page);
  return { app, page, errors };
}
async function connect(page, mic = 'none') {
  await page.click('#refreshDevices'); await page.waitForFunction(() => document.querySelector('#outputDevice').value === 'test-cable');
  await page.selectOption('#micDevice', mic); await page.click('#connectBtn');
  await page.waitForFunction(() => document.querySelector('#statusPill').classList.contains('live'));
}
const library = page => page.evaluate(() => window.deck.getLibrary());
const clipNamed = async (page, name) => (await library(page)).clips.find(c => c.name === name);
const padIndex = async (page, name) => page.evaluate(name => [...document.querySelectorAll('.sound-pad .pad-name')].findIndex(n => n.textContent === name), name);
async function openMenu(page, name, action) {
  const index = await padIndex(page, name);
  await page.locator('.sound-pad').nth(index).locator('.pad-edit').click({ force: true });
  await page.click(`#padMenu [data-action=${action}]`);
}
/** Every toast shown in test mode, so a later toast cannot hide an earlier message. */
const toastSeen = (page, text, timeout = 15000) => page.waitForFunction(t => (window.__toasts || []).some(m => m.includes(t)), text, { timeout });
const toastText = page => page.evaluate(() => document.querySelector('#toast').hidden ? '' : document.querySelector('#toastText').textContent);
/** Clicks immediately. Playwright's click waits on animation frames, which barely run in the hidden test window. */
const press = (page, selector) => page.$eval(selector, element => element.click());
const hideToast = page => page.evaluate(() => { document.querySelector('#toast').hidden = true; });

const checks = [];
const pass = item => { checks.push(item); console.log('PASS:', item); };

/* ─── Milestone A: reversible playback regions ─── */
async function regions(ctx) {
  const { page, app, dataDir } = ctx;
  await page.click('#boardNav');
  await page.evaluate(async () => { await window.__test.engine.init(); });
  await installTap(page);
  const clip = await clipNamed(page, 'Timecode');
  assert.equal(clip.duration, 0, 'metadata duration is unknown until decode');
  assert.equal(await page.locator('.sound-pad').nth(await padIndex(page, 'Timecode')).locator('.pad-time').textContent(), 'Ready');
  const file = path.join(dataDir, 'clips', clip.file), sourceHash = await sha(file);

  // Editor: cancel and invalid input do not mutate the clip.
  await openMenu(page, 'Timecode', 'region');
  await page.waitForFunction(() => document.querySelector('#regionSource').textContent === '1:00.000');
  await page.fill('#regionStart', '20'); await page.fill('#regionEnd', '10');
  await page.waitForFunction(() => !document.querySelector('#regionError').hidden && document.querySelector('#regionSave').disabled);
  await page.fill('#regionEnd', '70'); await page.waitForFunction(() => document.querySelector('#regionError').textContent.includes('past the end'));
  await page.fill('#regionStart', '1'); await page.fill('#regionEnd', '2'); await page.fill('#regionFadeIn', '800'); await page.fill('#regionFadeOut', '800');
  await page.waitForFunction(() => document.querySelector('#regionError').textContent.includes('longer than'));
  await page.click('#regionCancel');
  assert.equal((await clipNamed(page, 'Timecode')).playback, null, 'cancel does not mutate the clip');
  pass('Region editor rejects inverted, out-of-range, and over-long fade input; Cancel leaves the clip unchanged');

  // Preview needs private headphones and never reaches the soundboard bus.
  await openMenu(page, 'Timecode', 'region');
  await page.waitForFunction(() => document.querySelector('#regionSource').textContent === '1:00.000');
  await page.fill('#regionStart', '12.5'); await page.fill('#regionEnd', '17.25'); await page.fill('#regionFadeIn', '0'); await page.fill('#regionFadeOut', '0');
  await page.waitForFunction(() => document.querySelector('#regionPlayed').textContent === '0:04.750');
  await page.click('#regionPreview');
  await page.waitForFunction(() => document.querySelector('#toastText').textContent.includes('Choose your headphones') && !document.querySelector('#toastAction').hidden);
  assert.equal(await page.evaluate(() => window.__test.engine.auditionSession), null, 'no preview starts without headphones');
  await page.click('#toastAction');
  await page.waitForFunction(() => !document.querySelector('#regionDialog').open && document.activeElement?.id === 'monitorDevice');
  await page.click('#refreshDevices'); await page.waitForFunction(() => [...document.querySelector('#monitorDevice').options].some(o => o.value === 'test-phones'));
  await page.selectOption('#monitorDevice', 'test-phones');
  await until(page, async () => (await window.deck.getLibrary()).settings.monitorId === 'test-phones');
  await openMenu(page, 'Timecode', 'region');
  await page.waitForFunction(() => document.querySelector('#regionSource').textContent === '1:00.000');
  await page.fill('#regionStart', '12.5'); await page.fill('#regionEnd', '17.25'); await page.fill('#regionFadeIn', '0'); await page.fill('#regionFadeOut', '0');
  await page.waitForFunction(() => document.querySelector('#regionPlayed').textContent === '0:04.750');
  await tapStart(page);
  await page.click('#regionPreview');
  await page.waitForFunction(() => window.__test.engine.auditionSession && document.querySelector('#regionPreview').textContent.includes('Stop'));
  await pause(page,700);
  const previewTap = await tapStop(page);
  assert.equal(previewTap.audible, 0, 'preview audio never enters the soundboard bus');
  assert.ok(await page.evaluate(() => window.testMediaSinks.includes('test-phones')));
  await page.click('#regionPreview'); await page.waitForFunction(() => !window.__test.engine.auditionSession);
  pass('Preview requires chosen headphones, offers a setup action, and stays off the soundboard/broadcast bus');

  await page.click('#regionSave');
  await page.waitForFunction(() => !document.querySelector('#regionDialog').open);
  let saved = await clipNamed(page, 'Timecode');
  assert.deepEqual(saved.playback, { startSeconds: 12.5, endSeconds: 17.25, fadeInMs: 0, fadeOutMs: 0 });
  assert.equal(saved.duration, 60);
  await page.waitForFunction(() => [...document.querySelectorAll('.pad-time')].some(t => t.textContent === '0:04'));

  // Every trigger path plays exactly 12.500–17.250: pitch 540 Hz at the start, 640 Hz at the end, 4.75 s long.
  const expectRegion = (tap, label) => {
    assert.ok(Math.abs(tap.audible - 4.75) < 0.06, `${label}: audible ${tap.audible}`);
    assert.ok(Math.abs(tap.startHz - 540) < 12, `${label}: start ${tap.startHz} Hz`);
    assert.ok(Math.abs(tap.endHz - 640) < 12, `${label}: end ${tap.endHz} Hz`);
  };
  await page.click('#monitorToggle').catch(() => {});
  await connect(page);
  const trigger = {
    pad: async () => page.locator('.sound-pad').nth(await padIndex(page, 'Timecode')).locator('.pad-main').click(),
    shortcut: async () => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows().find(w => w.getTitle() === 'PulseDeck').webContents.send('shortcut', { type: 'play', id }), saved.id),
    overlay: async () => {
      const overlayPromise = app.waitForEvent('window');
      await page.click('#overlayBtn');
      const overlay = await overlayPromise; overlay.setDefaultTimeout(15000);
      await overlay.waitForFunction(() => document.querySelectorAll('.pad').length > 0);
      await overlay.locator('.pad').nth(await padIndex(page, 'Timecode')).click();
      ctx.overlay = overlay;
    }
  };
  for (const [label, run] of Object.entries(trigger)) {
    await tapStart(page); await run();
    await page.waitForFunction(() => document.querySelector('.sound-pad.playing'));
    await page.waitForFunction(() => !document.querySelector('.sound-pad.playing'), undefined, { timeout: 30000 });
    await pause(page,150);
    expectRegion(await tapStop(page), label);
  }
  await ctx.overlay.click('#hideBtn');
  assert.equal(await sha(file), sourceHash);
  pass('A 60 s source with a 12.500–17.250 region plays exactly 4.750 s from the pad, a global shortcut event, and the overlay; source bytes unchanged');

  // Loops stay inside the region for three cycles, restart progress each cycle, and repeat fades per cycle.
  await page.evaluate(async id => window.deck.editSound(id, { loop: true, playback: { startSeconds: 20, endSeconds: 20.5, fadeInMs: 100, fadeOutMs: 100 } }), saved.id);
  await page.reload(); await page.waitForFunction(() => Boolean(window.__test)); await stubHardware(page); await installTap(page); await connect(page);
  await tapStart(page);
  await page.locator('.sound-pad').nth(await padIndex(page, 'Timecode')).locator('.pad-main').click();
  const wraps = await page.evaluate(async id => {
    const values = [], ctx = window.__test.engine.context, started = ctx.currentTime;
    while (ctx.currentTime - started < 1.7) { const p = window.__test.engine.progress(id); if (p !== null) values.push(p); await new Promise(r => setTimeout(r, 20)); }
    let wraps = 0; for (let i = 1; i < values.length; i++) if (values[i] < values[i - 1] - 0.5) wraps++;
    return wraps;
  }, saved.id);
  await press(page, '#stopAll');
  const loopTap = await tapStop(page);
  assert.ok(wraps >= 3, `progress wrapped ${wraps} times`);
  const loopHz = await page.evaluate(() => {
    const { left } = window.lastTap; let first = left.findIndex(v => Math.abs(v) > 0.01);
    const hz = (a, b) => { let c = 0; for (let i = a + 1; i < b; i++) if ((left[i - 1] < 0) !== (left[i] < 0)) c++; return c / 2 / ((b - a) / 48000); };
    const rms = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += left[i] * left[i]; return Math.sqrt(s / (b - a)); };
    const out = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      const at = first + cycle * 24000;
      out.push({ hz: hz(at + 6000, at + 18000), middle: rms(at + 10000, at + 14000), edge: rms(at + 23500, at + 24500) });
    }
    return out;
  });
  for (const cycle of loopHz) {
    assert.ok(Math.abs(cycle.hz - 700) < 12, `loop stays at second 20: ${JSON.stringify(loopHz)}`);
    assert.ok(cycle.edge < cycle.middle * 0.25, `fade repeats at each wrap: ${JSON.stringify(loopHz)}`);
  }
  assert.ok(loopTap.audible > 1.4);
  assert.equal(await page.evaluate(() => window.__test.engine.instances.size), 0);
  // The tap's ScriptProcessor delivers audio about two buffers late; let it flush before measuring silence.
  await pause(page,250);
  await tapStart(page); await pause(page,600);
  const afterStop = await tapStop(page);
  assert.equal(afterStop.audible, 0, 'Stop all cancels every scheduled node: ' + JSON.stringify(afterStop));
  pass('A looping region stays inside its interval for 3+ cycles, progress resets each cycle, fades repeat per cycle, and Stop all silences it');

  // Silent region: measured as silent, no extreme boost. One-sample region plays and ends.
  await page.evaluate(async id => window.deck.editSound(id, { loop: false, playback: { startSeconds: 50, endSeconds: 54 } }), saved.id);
  await page.reload(); await page.waitForFunction(() => Boolean(window.__test)); await stubHardware(page); await installTap(page); await connect(page);
  await page.locator('.sound-pad').nth(await padIndex(page, 'Timecode')).locator('.pad-main').click();
  await until(page, async id => { const c = (await window.deck.getLibrary()).clips.find(x => x.id === id); return c.analysisKey === '50:54'; }, saved.id);
  saved = await clipNamed(page, 'Timecode');
  assert.equal(saved.loudness, null); assert.equal(await page.evaluate(id => window.__test.engine.clipGain(window.__test.state().clips.find(c => c.id === id)), saved.id), 1);
  await press(page, '#stopAll');
  await page.evaluate(async id => window.deck.editSound(id, { playback: { startSeconds: 1, endSeconds: 1 + 1 / 48000 } }), saved.id);
  await page.reload(); await page.waitForFunction(() => Boolean(window.__test)); await stubHardware(page); await connect(page);
  await page.locator('.sound-pad').nth(await padIndex(page, 'Timecode')).locator('.pad-main').click();
  await until(page, () => window.__test.engine.instances.size === 0);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.pad-name')].length > 0), true);
  pass('A silent region gets no auto-level boost; a one-sample region plays and finishes cleanly');

  // A shorter replacement source: a stale region outside it falls back to the whole sound with a visible warning.
  await page.evaluate(async id => window.deck.editSound(id, { playback: { startSeconds: 30, endSeconds: 40 } }), saved.id);
  await fs.writeFile(file, toneWav(500, 2));
  await page.reload(); await page.waitForFunction(() => Boolean(window.__test)); await stubHardware(page); await installTap(page); await connect(page);
  await tapStart(page);
  await page.locator('.sound-pad').nth(await padIndex(page, 'Timecode')).locator('.pad-main').click();
  await toastSeen(page, 'outside this sound');
  await page.waitForFunction(() => !document.querySelector('.sound-pad.playing'), undefined, { timeout: 30000 });
  const fallback = await tapStop(page);
  assert.ok(Math.abs(fallback.audible - 2) < 0.06, JSON.stringify(fallback));
  await fs.writeFile(file, timecodeWav());
  // The test swapped the file behind the app's back; drop the decoded copy so later sections hear the real source.
  await page.evaluate(id => window.__test.engine.forget(id), saved.id);
  await page.evaluate(async id => window.deck.editSound(id, { playback: { startSeconds: 12.5, endSeconds: 17.25 } }), saved.id);
  pass('A shorter replacement file plays in full with a visible warning instead of failing or playing nothing');
}

/* ─── Milestone A: capture → expandable pad ─── */
async function captureToPad(ctx) {
  const { page, dataDir } = ctx;
  await page.click('#replayNav'); await page.check('#replayToggle');
  await page.waitForFunction(() => document.querySelector('#replayArm').classList.contains('armed'));
  await pause(page,2200);
  await page.click('#captureBtn');
  await page.waitForFunction(() => document.querySelectorAll('.capture').length >= 1 && !document.querySelector('#editor').hidden);
  const capture = (await library(page)).captures[0];
  await page.fill('#trimStart', '0.5'); await page.fill('#trimEnd', '1.25');
  await page.fill('#captureName', 'Expandable line'); await page.locator('#captureName').press('Tab');
  await page.click('#addCaptureFullBtn');
  await until(page, async () => (await window.deck.getLibrary()).clips.some(c => c.name === 'Expandable line'));
  const clip = await clipNamed(page, 'Expandable line');
  assert.deepEqual(clip.playback, { startSeconds: 0.5, endSeconds: 1.25, fadeInMs: 0, fadeOutMs: 0 });
  assert.ok(Math.abs(clip.duration - capture.duration) < 0.01);
  const captureBytes = await fs.readFile(path.join(dataDir, 'captures', capture.file));
  await page.click('#deleteCapture'); await page.click('#deleteCapture');
  await until(page, async id => !(await window.deck.getLibrary()).captures.some(c => c.id === id), capture.id);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'clips', clip.file)), captureBytes, 'the pad owns the full capture bytes');
  await page.uncheck('#replayToggle');
  await page.click('#boardNav');
  await openMenu(page, 'Expandable line', 'region');
  await page.waitForFunction(() => document.querySelector('#regionSource').textContent !== 'Loading…' && document.querySelector('#regionStart').value !== '');
  await page.click('#regionReset');
  await page.click('#regionSave'); await page.waitForFunction(() => !document.querySelector('#regionDialog').open);
  assert.equal((await clipNamed(page, 'Expandable line')).playback, null);
  pass('“Add selection as pad (keep full audio)” copies the whole capture; the pad expands to the full source after the capture is deleted');
}

/* ─── Milestone B: Sound Studio ─── */
const studioRegions = page => page.evaluate(() => window.__test.studio.current?.project.regions || []);
async function askText(page, text) {
  await page.waitForSelector('#textDialog[open]');
  await page.fill('#textDialogInput', text);
  await page.click('#textDialog button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('#textDialog'));
}
async function choose(page, choice) {
  await page.waitForSelector('#choiceDialog[open]');
  await page.click(`#choiceDialog [data-choice=${choice}]`);
  await page.waitForFunction(() => !document.querySelector('#choiceDialog'));
}
async function selectSource(page, name) {
  await page.locator('#studioSourceList .source-row', { hasText: name }).first().click();
}
async function regionBox(page, index) {
  const id = (await studioRegions(page))[index].id;
  return page.locator(`.studio-region[data-id="${id}"]`).boundingBox();
}

async function studioDsp(ctx) {
  const report = await ctx.page.evaluate(async () => {
    const m = await import('./studio-model.js'), a = await import('./studio-audio.js');
    const R = 48000, ids = ['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000c'];
    const tone = (hz, seconds, amp = 0.25, rightHz = null) => {
      const b = new AudioBuffer({ length: Math.round(R * seconds), numberOfChannels: rightHz ? 2 : 1, sampleRate: R });
      for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c), f = c ? rightHz : hz; for (let i = 0; i < d.length; i++) d[i] = Math.sin(2 * Math.PI * f * i / R) * amp; }
      return b;
    };
    const power = (data, hz, from, to) => { const k = 2 * Math.cos(2 * Math.PI * hz / R); let s1 = 0, s2 = 0; for (let i = Math.round(from * R); i < Math.round(to * R); i++) { const s0 = data[i] + k * s1 - s2; s2 = s1; s1 = s0; } return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2)) / ((to - from) * R); };
    const peak = (data, from = 0, to = data.length / R) => { let p = 0; for (let i = Math.round(from * R); i < Math.round(to * R); i++) p = Math.max(p, Math.abs(data[i])); return p; };
    const base = () => { let p = m.newProject('dsp'); p = m.addAsset(p, { id: ids[0], file: 'a.wav', name: 'A', duration: 1, channels: 1 }); p = m.addAsset(p, { id: ids[1], file: 'b.wav', name: 'B', duration: 1, channels: 1 }); p = m.addAsset(p, { id: ids[2], file: 'c.wav', name: 'C', duration: 1, channels: 2 }); return p; };
    const buffers = new Map([[ids[0], tone(440, 1)], [ids[1], tone(660, 1)], [ids[2], tone(440, 1, 0.25, 880)]]);
    const out = {};
    // Overlap: 440 Hz at 0–1 s, 660 Hz at 0.5–1.5 s.
    let p = m.placeAsset(base(), { assetId: ids[0], mode: 'append' }).project;
    p = m.placeAsset(p, { assetId: ids[1], mode: 'layer', playhead: 0.5 }).project;
    let r = await a.renderProject(p, buffers); let L = r.buffer.getChannelData(0);
    out.overlap = { duration: r.buffer.duration, a1: power(L, 440, 0.1, 0.4), b1: power(L, 660, 0.1, 0.4), a2: power(L, 440, 0.6, 0.9), b2: power(L, 660, 0.6, 0.9), a3: power(L, 440, 1.1, 1.4), b3: power(L, 660, 1.1, 1.4), limited: r.limited };
    // Gap: 0–1 s then 2–3 s.
    p = m.placeAsset(base(), { assetId: ids[0], mode: 'append' }).project;
    p = m.placeAsset(p, { assetId: ids[1], mode: 'insert', playhead: 2 }).project;
    r = await a.renderProject(p, buffers); L = r.buffer.getChannelData(0);
    out.gap = { duration: r.buffer.duration, silence: peak(L, 1.05, 1.95), after: peak(L, 2.1, 2.9) };
    // Pan, mono duplication, stereo preservation, gain, fades, trims.
    const one = (patch, asset = ids[0]) => { const placed = m.placeAsset(base(), { assetId: asset, mode: 'append' }); return m.updateRegion(placed.project, placed.regionId, patch); };
    const render = async project => { const res = await a.renderProject(project, buffers); return [res.buffer.getChannelData(0), res.buffer.getChannelData(1), res.buffer]; };
    let [l, rr] = await render(one({}));
    out.mono = { left: peak(l, 0.1, 0.9), right: peak(rr, 0.1, 0.9) };
    [l, rr] = await render(one({ pan: -1 })); out.panLeft = { left: peak(l, 0.1, 0.9), right: peak(rr, 0.1, 0.9) };
    [l, rr] = await render(one({ pan: 1 })); out.panRight = { left: peak(l, 0.1, 0.9), right: peak(rr, 0.1, 0.9) };
    [l, rr] = await render(one({}, ids[2])); out.stereo = { left440: power(l, 440, 0.1, 0.9), left880: power(l, 880, 0.1, 0.9), right880: power(rr, 880, 0.1, 0.9), right440: power(rr, 440, 0.1, 0.9) };
    [l] = await render(one({ gainDb: -6 })); out.gain = peak(l, 0.1, 0.9);
    [l] = await render(one({ fadeInMs: 200, fadeOutMs: 100 })); out.fade = { start: peak(l, 0, 0.01), mid: peak(l, 0.09, 0.11), full: peak(l, 0.4, 0.6), end: peak(l, 0.99, 1) };
    let [, , trimmed] = await render(one({ inSeconds: 0.25, outSeconds: 0.75 })); out.trim = trimmed.duration;
    // Mute and solo.
    p = m.placeAsset(base(), { assetId: ids[0], mode: 'append' }).project; p = m.placeAsset(p, { assetId: ids[1], mode: 'layer', playhead: 0 }).project;
    let muted = m.updateTrack(p, p.tracks[0].id, { mute: true }); [l] = await render(muted); out.mute = { a: power(l, 440, 0.1, 0.9), b: power(l, 660, 0.1, 0.9) };
    let solo = m.updateTrack(p, p.tracks[0].id, { solo: true }); [l] = await render(solo); out.solo = { a: power(l, 440, 0.1, 0.9), b: power(l, 660, 0.1, 0.9) };
    // Split and duplicate: the same audio at the same times.
    p = m.placeAsset(base(), { assetId: ids[0], mode: 'append' }).project; const whole = (await render(p))[0];
    const split = m.splitRegion(p, p.regions[0].id, 0.5).project; const parts = (await render(split))[0];
    let diff = 0; for (let i = 0; i < whole.length; i++) if (Math.abs(i - 24000) > 200) diff = Math.max(diff, Math.abs(whole[i] - parts[i]));
    out.split = diff;
    const dup = m.duplicateRegion(p, p.regions[0].id).project; const [dl, , dupBuffer] = await render(dup);
    out.duplicate = { duration: dupBuffer.duration, second: power(dl, 440, 1.1, 1.9) };
    // Overload: two loud layers are limited to the ceiling without changing length.
    const loud = new Map([[ids[0], tone(440, 1, 0.9)], [ids[1], tone(440, 1, 0.9)]]);
    p = m.placeAsset(base(), { assetId: ids[0], mode: 'append' }).project; p = m.placeAsset(p, { assetId: ids[1], mode: 'layer', playhead: 0 }).project;
    r = await a.renderProject(p, loud);
    out.limit = { limited: r.limited, before: r.peakBefore, after: r.peak, duration: r.buffer.duration, ceiling: a.RENDER_CEILING };
    // 44.1 kHz source resamples to 48 kHz without changing duration or pitch.
    const frames = 44100, data = new Int16Array(frames); for (let i = 0; i < frames; i++) data[i] = Math.round(Math.sin(2 * Math.PI * 441 * i / 44100) * 8000);
    const wavBytes = new Uint8Array(44 + frames * 2), view = new DataView(wavBytes.buffer), text = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
    text(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); text(8, 'WAVEfmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 44100, true); view.setUint32(28, 88200, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, frames * 2, true);
    new Int16Array(wavBytes.buffer, 44).set(data);
    const decoded = await window.__test.engine.context.decodeAudioData(wavBytes.buffer.slice(0));
    const asset = a.canonicalAsset(decoded);
    let crossings = 0; const d0 = decoded.getChannelData(0); for (let i = 4800; i < 43200; i++) if ((d0[i - 1] < 0) !== (d0[i] < 0)) crossings++;
    out.resample = { rate: decoded.sampleRate, duration: asset.duration, hz: crossings / 2 / 0.8, channels: asset.channels };
    // 3-minute stereo exceeds the pad limit; the size is known before encoding.
    out.padLimit = m.wavBytes(180 * R, 2) > m.STUDIO_LIMITS.padBytes;
    return out;
  });
  const o = report;
  assert.ok(Math.abs(o.overlap.duration - 1.5) < 1e-6, JSON.stringify(o.overlap));
  assert.ok(o.overlap.a1 > 0.05 && o.overlap.b1 < 0.005 && o.overlap.a2 > 0.05 && o.overlap.b2 > 0.05 && o.overlap.a3 < 0.005 && o.overlap.b3 > 0.05, JSON.stringify(o.overlap));
  assert.ok(Math.abs(o.gap.duration - 3) < 1e-6 && o.gap.silence < 1e-4 && o.gap.after > 0.2, JSON.stringify(o.gap));
  assert.ok(Math.abs(o.mono.left - 0.25) < 0.01 && Math.abs(o.mono.right - 0.25) < 0.01, 'mono is duplicated at unity: ' + JSON.stringify(o.mono));
  assert.ok(o.panLeft.right < 1e-4 && o.panLeft.left > 0.24 && o.panRight.left < 1e-4 && o.panRight.right > 0.24, JSON.stringify([o.panLeft, o.panRight]));
  assert.ok(o.stereo.left440 > 0.05 && o.stereo.left880 < 0.005 && o.stereo.right880 > 0.05 && o.stereo.right440 < 0.005, 'stereo channels stay distinct: ' + JSON.stringify(o.stereo));
  assert.ok(Math.abs(o.gain - 0.25 * 10 ** (-6 / 20)) < 0.01, 'gain ' + o.gain);
  assert.ok(o.fade.start < 0.02 && Math.abs(o.fade.mid - 0.125) < 0.02 && o.fade.full > 0.24 && o.fade.end < 0.03, JSON.stringify(o.fade));
  assert.ok(Math.abs(o.trim - 0.5) < 1e-6);
  assert.ok(o.mute.a < 0.005 && o.mute.b > 0.05 && o.solo.a > 0.05 && o.solo.b < 0.005, JSON.stringify([o.mute, o.solo]));
  assert.ok(o.split < 1e-6, 'split renders identically away from the cut: ' + o.split);
  assert.ok(Math.abs(o.duplicate.duration - 2) < 1e-6 && o.duplicate.second > 0.05);
  assert.ok(o.limit.limited && o.limit.before > 1.5 && o.limit.after <= o.limit.ceiling + 1e-6 && Math.abs(o.limit.duration - 1) < 1e-6, JSON.stringify(o.limit));
  assert.ok(o.resample.rate === 48000 && Math.abs(o.resample.duration - 1) < 1 / 48000 + 1e-9 && Math.abs(o.resample.hz - 441) < 2 && o.resample.channels === 1, JSON.stringify(o.resample));
  assert.ok(o.padLimit);
  pass('Studio render: 0–1 s + 0.5–1.5 s tones give a 1.5 s result that overlaps only at 0.5–1.0 s; gaps, trims, gain, balance, mono duplication, stereo separation, fades, mute/solo, split, and duplicate render as specified');
  pass('Studio render protection: overloaded layers are limited below −1 dBFS by the shared limiter with unchanged length; 44.1 kHz audio resamples to 48 kHz without changing duration or pitch');
  ctx.dsp = report;
}

const mainWindow = (app, width, height) => app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows().find(w => w.getTitle() === 'PulseDeck').setSize(size[0], size[1]), [width, height]);

async function studioFlow(ctx) {
  const { page, app, base, dataDir } = ctx;
  // Near the minimum window size, Studio switches to one column; every control must stay clickable.
  await mainWindow(app, 1024, 740);
  try { await studioSteps(ctx); } finally { await mainWindow(app, 1280, 860); }
}

async function studioSteps(ctx) {
  const { page, app, base, dataDir } = ctx;
  await page.click('#studioNav');
  await page.waitForFunction(() => !document.querySelector('#studioView').hidden && !document.querySelector('#studioEmpty').hidden);
  await page.click('#studioEmptyNew'); await askText(page, 'Victory combo');
  await page.waitForFunction(() => window.__test.studio.current?.project.name === 'Victory combo');
  const projectId = await page.evaluate(() => window.__test.studio.current.id);
  ctx.projectId = projectId;

  // An existing pad keeps its playback region as source bounds.
  await selectSource(page, 'Timecode'); await page.click('#srcAppend');
  await until(page, () => window.__test.studio.current.project.regions.length === 1);
  let list = await studioRegions(page);
  assert.deepEqual([list[0].atSeconds, list[0].inSeconds, list[0].outSeconds], [0, 12.5, 17.25]);

  // A replay capture selection, sent from the capture editor.
  await page.click('#replayNav'); await page.check('#replayToggle');
  await page.waitForFunction(() => document.querySelector('#replayArm').classList.contains('armed'));
  await pause(page,2200); await page.click('#captureBtn');
  await page.waitForFunction(() => !document.querySelector('#editor').hidden);
  await page.fill('#trimStart', '0.2'); await page.fill('#trimEnd', '1');
  await page.click('#captureToStudio'); await choose(page, 'current');
  await until(page, () => window.__test.studio.current.project.regions.length === 2);
  list = await studioRegions(page);
  assert.deepEqual([list[1].atSeconds, list[1].inSeconds, list[1].outSeconds], [4.75, 0.2, 1]);
  ctx.captureRegionAsset = list[1].assetId;

  // Grab recent audio without interrupting the buffer; label the shorter history; undo and redo.
  await page.click('#studioGrab');
  await until(page, () => window.__test.studio.current.project.regions.length === 3);
  assert.match(await toastText(page), /had only/);
  assert.ok(await page.evaluate(() => Boolean(window.__test.engine.replay)), 'the replay buffer keeps running');
  await page.click('#studioUndo'); await until(page, () => window.__test.studio.current.project.regions.length === 2);
  await page.click('#studioRedo'); await until(page, () => window.__test.studio.current.project.regions.length === 3);
  await page.keyboard.press('Control+z'); await until(page, () => window.__test.studio.current.project.regions.length === 2);
  await page.click('#replayNav'); await page.uncheck('#replayToggle'); await page.click('#studioNav');

  // Layer at the playhead on a new track, then edit it in the inspector.
  await selectSource(page, 'Timecode'); await page.click('#srcLayer');
  await until(page, () => window.__test.studio.current.project.tracks.length === 2 && window.__test.studio.current.project.regions.length === 3);
  await page.fill('#inspGain', '-6'); await page.locator('#inspGain').press('Enter');
  await until(page, () => window.__test.studio.current.project.regions[2].gainDb === -6);
  await page.fill('#inspPan', '0.5'); await page.locator('#inspPan').press('Enter');
  await until(page, () => window.__test.studio.current.project.regions[2].pan === 0.5);

  // Drag the layered region right; one completed drag is one undo step.
  const pastBefore = await page.evaluate(() => window.__test.studio.current.project.regions[2].atSeconds);
  const box = await regionBox(page, 2);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 6 }); await page.mouse.up();
  const moved = await page.evaluate(() => window.__test.studio.current.project.regions[2].atSeconds);
  assert.ok(moved > pastBefore + 0.5, `drag moved the region (${pastBefore} → ${moved})`);
  await page.click('#studioUndo'); await until(page, at => window.__test.studio.current.project.regions[2].atSeconds === at, pastBefore);
  await page.click('#studioRedo'); await until(page, at => window.__test.studio.current.project.regions[2].atSeconds === at, moved);

  // Split at the playhead, duplicate, remove.
  const layer = (await studioRegions(page))[2];
  const lane = await page.locator(`.track-lane[data-track="${layer.trackId}"]`).boundingBox();
  const pps = (await regionBox(page, 2)).width / 4.75;
  await page.mouse.click(lane.x + (layer.atSeconds + 2) * pps, lane.y + lane.height / 2 - 40 > lane.y ? lane.y + 3 : lane.y + 3);
  await page.locator(`.studio-region[data-id="${layer.id}"]`).click({ position: { x: 10, y: 10 } });
  await page.click('#studioSplit');
  await until(page, () => window.__test.studio.current.project.regions.length === 4);
  await page.click('#studioDuplicate'); await until(page, () => window.__test.studio.current.project.regions.length === 5);
  await page.click('#studioRemove'); await until(page, () => window.__test.studio.current.project.regions.length === 4);
  pass('Studio timeline: add a pad (keeping its region bounds), a replay selection, and a live replay grab; layer, inspector gain/pan, drag, split, duplicate, remove, and undo/redo');

  await page.click('#studioSave');
  await until(page, () => window.__test.studio.current.project.revision === 1 && !window.__test.studio.hasUnsaved);

  // Preview plays only on the preview bus, never the soundboard.
  await installTap(page, 'previewBus');
  await tapStart(page, 'previewBus'); await tapStart(page, 'board');
  const playheadInfo = () => page.evaluate(async () => { const m = await import('./studio-model.js'); const s = window.__test.studio; return { playhead: s.playhead, end: m.timelineDuration(s.current.project), audition: window.__test.engine.auditionSession?.owner || null, label: document.querySelector('#studioPlay').textContent }; });
  const beforePlay = await playheadInfo();
  await press(page, '#studioPlay'); await pause(page,300);
  const playing = await playheadInfo();
  await pause(page,900); await press(page, '#studioPlay'); await pause(page,100);
  const paused = await playheadInfo();
  const heard = await tapStop(page, 'previewBus'), leaked = await tapStop(page, 'board');
  assert.ok(heard.audible > 0.8, JSON.stringify(heard)); assert.equal(leaked.audible, 0, 'Studio preview never reaches the soundboard bus');
  assert.ok(paused.audition === null && paused.playhead > beforePlay.playhead + 0.8 - (beforePlay.playhead >= beforePlay.end - 0.01 ? beforePlay.playhead : 0), 'pausing keeps the playhead where preview stopped: ' + JSON.stringify({ beforePlay, playing, paused }));
  pass('Studio preview plays through headphones only; pausing keeps the playhead position');

  // Save as a new sound: rendered from the saved revision, stereo, with provenance.
  await page.click('#studioRender'); await askText(page, 'Studio combo');
  await until(page, async () => (await window.deck.getLibrary()).clips.some(c => c.name === 'Studio combo'), undefined, 30000);
  const rendered = await clipNamed(page, 'Studio combo');
  assert.deepEqual([rendered.source.kind, rendered.source.projectId, rendered.source.revision], ['studio', projectId, 1]);
  const info = await page.evaluate(async id => { const b = await window.__test.engine.context.decodeAudioData(new Uint8Array(await window.deck.readSound(id)).buffer); return { channels: b.numberOfChannels, duration: b.duration }; }, rendered.id);
  const expectedLength = await page.evaluate(async () => { const m = await import('./studio-model.js'); return m.renderRange(window.__test.studio.current.project).endSeconds; });
  assert.equal(info.channels, 2); assert.ok(Math.abs(info.duration - expectedLength) < 1e-3, JSON.stringify({ info, expectedLength }));
  await page.click('#boardNav');
  await tapStart(page, 'board');
  await page.locator('.sound-pad').nth(await padIndex(page, 'Studio combo')).locator('.pad-main').click();
  await pause(page,700); await press(page, '#stopAll');
  assert.ok((await tapStop(page, 'board')).audible > 0.4, 'the rendered pad plays through the soundboard');
  await openMenu(page, 'Studio combo', 'source');
  await page.waitForFunction(id => window.__test.studio.current?.id === id && !document.querySelector('#studioView').hidden, projectId);
  pass('Save as new sound renders the saved revision to a stereo pad with project provenance; the pad plays on the board and opens its source project');

  // Export WAV: cancel writes nothing; a write failure keeps nothing partial; success writes a valid stereo WAV.
  const target = path.join(base, 'export.wav');
  await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true }); });
  await page.click('#studioExport'); await pause(page,800);
  await assert.rejects(fs.access(target));
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, path.join(base, 'missing-folder', 'x.wav'));
  await page.click('#studioExport');
  await page.waitForFunction(() => document.querySelector('#toast.error') && !document.querySelector('#toast').hidden);
  await hideToast(page);
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, target);
  await page.click('#studioExport');
  await until(page, () => document.querySelector('#toastText').textContent.startsWith('Exported'), undefined, 20000);
  const exported = await fs.readFile(target);
  assert.equal(exported.toString('ascii', 0, 4), 'RIFF'); assert.equal(exported.readUInt16LE(22), 2); assert.equal(exported.readUInt32LE(24), 48000);
  assert.ok(Math.abs(exported.readUInt32LE(40) / 4 / 48000 - expectedLength) < 1e-3);
  assert.deepEqual((await fs.readdir(base)).filter(n => n.includes('.tmp')), [], 'no temporary files remain');
  pass('Export WAV writes a stereo 48 kHz file through the native dialog; Cancel writes nothing and a failed write leaves no partial file');

  // A cancelled render never saves.
  const padCount = (await library(page)).clips.length;
  await page.evaluate(() => { const observer = new MutationObserver(() => { if (!document.querySelector('#studioProgress').hidden) { document.querySelector('#studioCancelRender').click(); observer.disconnect(); } }); observer.observe(document.querySelector('#studioProgress'), { attributes: true }); });
  await page.click('#studioRender'); await askText(page, 'Never saved');
  await page.waitForFunction(() => document.querySelector('#toastText').textContent.includes('Render cancelled'));
  await pause(page,600);
  assert.equal((await library(page)).clips.length, padCount);
  pass('Cancelling a render discards its result: no pad is created');

  // An edit after saving is kept in a recovery draft for the next launch.
  await page.locator(`.studio-region[data-id="${(await studioRegions(page))[0].id}"]`).click({ position: { x: 8, y: 8 } });
  await page.fill('#inspGain', '-3'); await page.locator('#inspGain').press('Enter');
  await pause(page,1500);
  const draft = JSON.parse(await fs.readFile(path.join(dataDir, 'projects', projectId, 'draft.json'), 'utf8'));
  assert.equal(draft.project.regions[0].gainDb, -3); assert.equal(draft.baseRevision, 1);
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'projects', projectId, 'project.json'), 'utf8'));
  assert.notEqual(saved.regions[0].gainDb, -3, 'the explicit save is unchanged by the draft');
}

async function studioAfterRestart(ctx) {
  const { page, dataDir, projectId } = ctx;
  await page.click('#studioNav');
  await page.waitForFunction(() => !document.querySelector('#studioRecovery').hidden);
  await page.click('#studioRecover');
  await page.waitForFunction(id => window.__test.studio.current?.id === id, projectId);
  assert.equal((await studioRegions(page))[0].gainDb, -3); assert.ok(await page.evaluate(() => window.__test.studio.hasUnsaved));
  pass('After restarting, the recovery draft restores unsaved Studio edits without replacing the last explicit save');
  await page.click('#studioSave'); await until(page, () => !window.__test.studio.hasUnsaved);

  // Delete the source pad and captures; the project still renders from its own copies.
  await page.click('#boardNav');
  for (const name of ['Timecode']) { await openMenu(page, name, 'edit'); await page.click('#deleteSound'); await page.click('#deleteSound'); await until(page, async n => !(await window.deck.getLibrary()).clips.some(c => c.name === n), name); }
  for (const capture of (await library(page)).captures) await page.evaluate(id => window.deck.removeCapture(id), capture.id);
  await page.click('#studioNav');
  await page.click('#studioRender'); await askText(page, 'After deletions');
  await until(page, async () => (await window.deck.getLibrary()).clips.some(c => c.name === 'After deletions'), undefined, 30000);
  pass('Deleting the source pad and replay captures does not break the project; it renders again from its own audio');

  // A missing asset produces an actionable error, and nothing is saved.
  const assetFile = path.join(dataDir, 'projects', projectId, 'assets', `${ctx.captureRegionAsset}.wav`);
  const bytes = await fs.readFile(assetFile);
  await fs.rm(assetFile);
  await page.evaluate(() => window.__test.studio.stopPreview());
  await page.evaluate(async id => { await window.deck.closeProject(id); }, projectId).catch(() => {});
  await page.reload(); await page.waitForFunction(() => Boolean(window.__test)); await stubHardware(page);
  await page.click('#studioNav'); await page.selectOption('#studioProject', projectId);
  await page.waitForFunction(() => document.querySelector('#toast.error') && document.querySelector('#toastText').textContent.includes('missing'));
  await hideToast(page);
  const before = (await library(page)).clips.length;
  await page.click('#studioRender'); await askText(page, 'Broken render');
  await page.waitForFunction(() => document.querySelector('#toast.error') && !document.querySelector('#toast').hidden && document.querySelector('#toastText').textContent.includes('missing'));
  assert.equal((await library(page)).clips.length, before, 'a render with missing audio creates nothing');
  await fs.writeFile(assetFile, bytes);
  await hideToast(page);
  await page.click('#studioRender'); await askText(page, 'Restored render');
  await until(page, async () => (await window.deck.getLibrary()).clips.some(c => c.name === 'Restored render'), undefined, 30000);
  pass('Missing project audio is reported when the project opens and blocks rendering with a clear error; restoring the file makes it render again');
}

/* ─── Milestone C: microphone recording ─── */
/** Pitch (zero crossings) and 880 Hz vs 540 Hz energy of the current take. */
const takeInfo = page => page.evaluate(() => {
  const take = window.__test.recorder.take;
  if (!take) return null;
  const s = take.samples, from = Math.floor(s.length * 0.3), to = Math.floor(s.length * 0.7);
  let crossings = 0; for (let i = from + 1; i < to; i++) if ((s[i - 1] < 0) !== (s[i] < 0)) crossings++;
  const power = hz => { const k = 2 * Math.cos(2 * Math.PI * hz / 48000); let a = 0, b = 0; for (let i = from; i < to; i++) { const c = s[i] + k * a - b; b = a; a = c; } return Math.sqrt(Math.max(0, a * a + b * b - k * a * b)) / (to - from); };
  let peak = 0; for (const v of s) peak = Math.max(peak, Math.abs(v));
  return { seconds: take.seconds, hz: crossings / 2 / ((to - from) / 48000), p880: power(880), p540: power(540), peak, processed: take.processed, reason: take.reason };
});
const micStreams = page => page.evaluate(() => window.__test.engine.micStreams());
const liveTracks = page => page.evaluate(() => window.testTracks.filter(t => t.readyState === 'live').length);
async function openRecorder(page) {
  await page.click('#boardNav'); await page.click('#recordBtn');
  await page.waitForSelector('#recordDialog[open]');
}
async function recordFor(page, ms, { mode = 'dry', device = 'test-mic' } = {}) {
  await page.selectOption('#recMic', device);
  await page.check(`input[name=recMode][value=${mode}]`);
  await press(page, '#recRecord');
  await page.waitForFunction(() => window.__test.recorder.state === 'recording');
  await pause(page,ms);
  await press(page, '#recStop');
  await page.waitForFunction(() => window.__test.recorder.state === 'idle');
}

async function recorderFlow(ctx) {
  const { page } = ctx;
  if (await page.locator('#statusPill.live').count()) await page.click('#connectBtn');
  await page.waitForFunction(() => !document.querySelector('#statusPill').classList.contains('live'));
  await page.click('#refreshDevices');
  const baseline = await micStreams(page);
  assert.equal(baseline, 0);

  // Permission denial gives a next step and leaves no stream behind.
  await page.evaluate(() => { const real = navigator.mediaDevices.getUserMedia; navigator.mediaDevices.getUserMedia = async constraints => { navigator.mediaDevices.getUserMedia = real; throw new DOMException('Permission denied', 'NotAllowedError'); }; });
  await openRecorder(page);
  await page.selectOption('#recMic', 'test-mic'); await press(page, '#recRecord');
  await page.waitForFunction(() => !document.querySelector('#recError').hidden && document.querySelector('#recError').textContent.includes('denied'));
  assert.equal(await micStreams(page), 0);
  pass('A denied microphone permission explains the next step and leaves no stream open');

  // Dry take while the broadcast is disconnected; muting the live mic does not affect it.
  await page.selectOption('#recMic', 'test-mic'); await page.check('input[name=recMode][value=dry]');
  await press(page, '#recRecord'); await page.waitForFunction(() => window.__test.recorder.state === 'recording');
  assert.equal(await page.locator('#statusPill.live').count(), 0, 'recording never connects the broadcast');
  await page.evaluate(() => window.__test.engine.toggleMute());
  await pause(page,1200);
  await press(page, '#recStop'); await page.waitForFunction(() => window.__test.recorder.state === 'idle' && window.__test.recorder.take);
  await page.evaluate(() => window.__test.engine.toggleMute());
  const dry = await takeInfo(page);
  // At least the 1.2 s of audio that passed; the upper bound only guards against a runaway take.
  assert.ok(dry.seconds > 0.9 && dry.seconds < 3.5 && Math.abs(dry.hz - 880) < 15 && dry.peak > 0.1, JSON.stringify(dry));
  assert.equal(await micStreams(page), 0, 'the recorder released its stream');
  await press(page, '#recPreview');
  await page.waitForFunction(() => window.__test.engine.auditionSession?.owner === 'recorder-take');
  await press(page, '#recPreview');
  await page.fill('#recName', 'Take one'); await page.click('#recSave');
  await page.waitForFunction(() => !document.querySelector('#recordDialog').open);
  const saved = await clipNamed(page, 'Take one');
  assert.equal(saved.source.kind, 'recording'); assert.equal(saved.playback, null);
  pass('A dry take records with the broadcast disconnected and the live mic muted, previews in headphones, and saves as a full-source pad');

  // Processed take differs from the dry one; it can be added to the open Studio project.
  await page.click('#voiceNav'); await page.click('[data-effect=chipmunk]');
  await until(page, async () => (await window.deck.getLibrary()).settings.effect === 'chipmunk');
  await openRecorder(page);
  await recordFor(page, 1000, { mode: 'processed' });
  const processed = await takeInfo(page);
  assert.ok(processed.processed && Math.abs(processed.hz - 880 * 2 ** (7 / 12)) < 25, JSON.stringify(processed));
  const regionsBefore = (await studioRegions(page)).length;
  await page.fill('#recName', 'Chipmunk take'); await page.click('#recAppend');
  await page.waitForFunction(() => !document.querySelector('#recordDialog').open);
  assert.equal((await studioRegions(page)).length, regionsBefore + 1);
  assert.equal((await studioRegions(page)).at(-1).label, 'Chipmunk take');
  pass('A take “with current voice effect” differs from the dry take (chipmunk pitch) and inserts into the Studio project');

  // During a live call on the same device: the stream is shared, the board mix is not recorded, and the call survives.
  await page.click('#voiceNav'); await page.click('[data-effect=clean]');
  await page.click('#boardNav'); await connect(page, 'test-mic');
  assert.equal(await micStreams(page), 1);
  const tracksBefore = await liveTracks(page);
  await openRecorder(page);
  await page.selectOption('#recMic', 'test-mic'); await press(page, '#recRecord');
  await page.waitForFunction(() => window.__test.recorder.state === 'recording');
  assert.equal(await micStreams(page), 1, 'the live stream is reused, not doubled');
  assert.equal(await liveTracks(page), tracksBefore, 'no second capture of the same microphone');
  await app(ctx).evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows().find(w => w.getTitle() === 'PulseDeck').webContents.send('shortcut', { type: 'play', id }), (await clipNamed(page, 'Studio combo')).id);
  await pause(page,1000);
  await press(page, '#recStop'); await page.waitForFunction(() => window.__test.recorder.state === 'idle');
  const live = await takeInfo(page);
  assert.ok(live.p880 > live.p540 * 20, 'the take holds the microphone, not the board mix: ' + JSON.stringify(live));
  assert.ok(await page.evaluate(() => window.__test.engine.connected && Boolean(window.__test.engine.source)), 'the live microphone keeps running');
  assert.equal(await micStreams(page), 1);
  assert.equal(await liveTracks(page), tracksBefore);
  await page.click('#recDiscard');

  // A different device uses its own stream, released afterwards.
  await page.selectOption('#recMic', 'test-mic-2'); await press(page, '#recRecord');
  await page.waitForFunction(() => window.__test.recorder.state === 'recording');
  assert.equal(await micStreams(page), 2);
  await pause(page,300); await press(page, '#recStop'); await page.waitForFunction(() => window.__test.recorder.state === 'idle');
  assert.equal(await micStreams(page), 1);
  pass('Recording during a live call shares the same microphone stream, excludes the board mix, and never interrupts the call; another device gets its own stream');

  // Rapid Record/Cancel while the microphone is still opening releases the late stream.
  await page.evaluate(() => { const real = navigator.mediaDevices.getUserMedia; navigator.mediaDevices.getUserMedia = async c => { await new Promise(r => setTimeout(r, 400)); navigator.mediaDevices.getUserMedia = real; return real(c); }; });
  await page.selectOption('#recMic', 'test-mic-2'); await press(page, '#recRecord');
  await page.waitForFunction(() => window.__test.recorder.state === 'acquiring');
  await press(page, '#recStop');
  await pause(page,700);
  assert.equal(await page.evaluate(() => window.__test.recorder.state), 'idle');
  assert.equal(await micStreams(page), 1, 'a stream that arrived after cancel was released');

  // Too short, unplugged, and the length limit.
  await page.selectOption('#recMic', 'test-mic-2'); await press(page, '#recRecord');
  await page.waitForFunction(() => window.__test.recorder.state === 'recording'); await press(page, '#recStop');
  await page.waitForFunction(() => !document.querySelector('#recError').hidden && document.querySelector('#recError').textContent.includes('too short'));
  assert.equal(await page.evaluate(() => window.__test.recorder.take), null);
  await page.selectOption('#recMic', 'test-mic-2'); await press(page, '#recRecord');
  await page.waitForFunction(() => window.__test.recorder.state === 'recording'); await pause(page,600);
  await page.evaluate(() => { const track = window.testTracks.filter(t => t.readyState === 'live').at(-1); track.dispatchEvent(new Event('ended')); });
  await page.waitForFunction(() => window.__test.recorder.state === 'idle' && window.__test.recorder.take);
  assert.match(await page.locator('#recStatus').textContent(), /microphone disconnected/);
  assert.ok((await takeInfo(page)).seconds > 0.3, 'samples recorded before the unplug are kept');
  assert.ok(await page.evaluate(() => window.__test.engine.connected), 'unplugging the recording device does not end the call on another device');
  await page.click('#recDiscard');
  const limited = await page.evaluate(async () => {
    const recorder = window.__test.recorder;
    const ended = new Promise(resolve => recorder.addEventListener('ended', e => resolve(e.detail), { once: true }));
    await recorder.start({ deviceId: 'test-mic', maxSeconds: 0.5 });
    const detail = await ended;
    return { reason: detail.reason, message: detail.message, seconds: detail.take?.seconds };
  });
  assert.equal(limited.reason, 'limit'); assert.match(limited.message, /limit/); assert.ok(Math.abs(limited.seconds - 0.5) < 0.01, JSON.stringify(limited));
  await page.click('#recDiscard');
  pass('Cancel while opening, too-short takes, an unplugged microphone (keeping recorded audio), and the length limit all end cleanly');

  // Repeated takes replace the previous one; closing the dialog mid-take releases only the recorder.
  await recordFor(page, 400); const first = await takeInfo(page);
  await recordFor(page, 900); const second = await takeInfo(page);
  assert.ok(second.seconds > first.seconds + 0.3);
  await page.selectOption('#recMic', 'test-mic-2'); await press(page, '#recRecord');
  await page.waitForFunction(() => window.__test.recorder.state === 'recording');
  await page.click('#closeRecord');
  await page.waitForFunction(() => window.__test.recorder.state === 'idle');
  assert.equal(await micStreams(page), 1); assert.ok(await page.evaluate(() => window.__test.engine.connected));
  await page.click('#connectBtn');
  await page.waitForFunction(() => !document.querySelector('#statusPill').classList.contains('live'));
  assert.equal(await micStreams(page), 0); assert.equal(await liveTracks(page), 0, 'every microphone track is stopped');
  pass('Repeated takes replace each other; closing the recorder mid-take releases only its own stream; disconnecting releases every microphone track');
}
const app = ctx => ctx.app;

/* ─── Milestone D: text to speech (test provider; real voices are checked by tests/tts-real.cjs) ─── */
const PHRASE = 'Hello team, the match starts now';
const ttsStatus = page => page.evaluate(() => window.__test.tts.status);
async function ttsFlow(ctx) {
  const { page, dataDir } = ctx;
  await page.click('#boardNav'); await page.click('#ttsBoardBtn');
  await page.waitForFunction(() => !document.querySelector('#ttsView').hidden && document.querySelectorAll('#ttsVoice option').length >= 2);
  assert.match(await page.locator('#ttsProvider').textContent(), /not cloud voices|automated tests/i);
  await page.fill('#ttsText', PHRASE); await page.selectOption('#ttsVoice', 'test-voice-en');

  // Speak now while disconnected keeps the text and offers Connect audio; nothing plays anywhere.
  await tapStart(page, 'board');
  await press(page, '#ttsSpeak');
  await page.waitForFunction(() => document.querySelector('#toastText').textContent.includes('Connect audio') && !document.querySelector('#toastAction').hidden);
  assert.equal(await page.inputValue('#ttsText'), PHRASE);
  assert.equal(await page.evaluate(() => window.__test.engine.instances.size + (window.__test.engine.auditionSession ? 1 : 0)), 0);
  await hideToast(page);

  // Preview: headphones only; a failed headphone selection stops and explains.
  await page.evaluate(() => { window.testMediaSinkFailure = true; });
  await page.click('#ttsPreview');
  await page.waitForFunction(() => document.querySelector('#toastText').textContent.includes('could not play in your headphones'));
  assert.equal(await page.evaluate(() => window.__test.engine.auditionSession), null);
  await page.evaluate(() => { window.testMediaSinkFailure = false; }); await hideToast(page);
  await tapStart(page, 'previewBus'); await tapStart(page, 'board');
  await page.click('#ttsPreview');
  await page.waitForFunction(() => window.__test.engine.auditionSession?.owner === 'tts');
  await pause(page,900);
  const previewHeard = await tapStop(page, 'previewBus'), previewLeak = await tapStop(page, 'board');
  assert.ok(previewHeard.audible > 0.5 && previewLeak.audible === 0, JSON.stringify({ previewHeard, previewLeak }));
  await press(page, '#ttsStop');
  pass('Speak now while disconnected keeps the text and offers Connect audio; Preview plays only in headphones and a failed headphone route stops cleanly');

  // Speak now through the connected board, the limiter, and the broadcast route.
  await connect(page);
  await page.click('#ttsNav');
  await tapStart(page, 'board');
  await press(page, '#ttsSpeak');
  await page.waitForFunction(() => window.__test.tts.status === 'speaking');
  await page.waitForFunction(() => window.__test.tts.status === 'ready', undefined, { timeout: 30000 });
  await pause(page,150);
  const spoken = await tapStop(page, 'board');
  const expected = await page.evaluate(() => window.__test.tts.result.duration);
  assert.ok(Math.abs(spoken.audible - expected) < 0.08, JSON.stringify({ spoken, expected }));
  pass('Speak now sends real generated audio through the soundboard bus when connected');

  // Stop all ends speech; a pending Speak now that finishes generating after Stop all never plays.
  await press(page, '#ttsSpeak'); await page.waitForFunction(() => window.__test.tts.status === 'speaking');
  await press(page, '#stopAll');
  await page.waitForFunction(() => window.__test.engine.instances.size === 0);
  await page.fill('#ttsText', `${PHRASE}!`);
  assert.equal(await page.evaluate(() => window.__test.tts.result), null, 'an edit invalidates the previous result');
  await press(page, '#ttsSpeak');
  await page.waitForFunction(() => window.__test.tts.status === 'generating');
  await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle() === 'PulseDeck').webContents.send('shortcut', { type: 'stop' }));
  await pause(page,250); await tapStart(page, 'board'); await pause(page,700);
  assert.equal((await tapStop(page, 'board')).audible, 0, 'late speech never starts after Stop all');
  assert.equal(await page.evaluate(() => window.__test.engine.clipCount('tts')), 0);

  // Cancel during generation, zero-length output, and a missing voice leave no audio, pads, or temp files.
  await page.selectOption('#ttsVoice', 'test-voice-hang');
  await page.click('#ttsPreview'); await page.waitForFunction(() => window.__test.tts.status === 'generating');
  await press(page, '#ttsStop'); await page.waitForFunction(() => window.__test.tts.status === 'cancelled');
  const padCount = (await library(page)).clips.length;
  await page.selectOption('#ttsVoice', 'test-voice-empty'); await page.click('#ttsSave');
  await page.waitForFunction(() => document.querySelector('#toast.error') && document.querySelector('#toastText').textContent.includes('no audio'));
  await hideToast(page);
  // A voice that is not installed cannot be chosen in the UI, and main rejects it at the IPC boundary.
  await page.evaluate(() => { const o = new Option('Removed voice', 'Removed voice'); document.querySelector('#ttsVoice').add(o); document.querySelector('#ttsVoice').value = 'Removed voice'; document.querySelector('#ttsVoice').dispatchEvent(new Event('change')); });
  assert.ok(await page.evaluate(() => ['#ttsSave', '#ttsSpeak', '#ttsPreview', '#ttsInsert'].every(s => document.querySelector(s).disabled)), 'actions are disabled for a voice that is not installed');
  const removed = await page.evaluate(() => window.deck.ttsSynthesize({ requestId: 'x', text: 'hello', voiceId: 'Removed voice', speed: 0 }).then(() => 'accepted', error => error.message));
  assert.match(removed, /no longer installed/);
  assert.equal((await library(page)).clips.length, padCount, 'failed synthesis never creates a pad');
  assert.equal(await page.inputValue('#ttsText'), `${PHRASE}!`, 'the phrase is kept for retry');
  await pause(page,300);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'tmp', 'tts')), [], 'no temporary speech files remain');
  await page.evaluate(() => document.querySelector('#ttsVoice option[value="Removed voice"]').remove());
  await hideToast(page);
  pass('Stop all ends speech and cancels pending auto-play; cancelling generation, empty output, and a removed voice fail cleanly without pads, audio, or temp files');

  // Unicode, quotes, newlines, and command-like text are plain data end to end; language limits are explained.
  await page.selectOption('#ttsVoice', 'test-voice-en');
  await page.fill('#ttsText', 'Quotes "yes" \'no\' 🎮 日本語\n$(calc) `whoami` <speak>tag</speak>');
  await page.waitForFunction(() => !document.querySelector('#ttsLanguageNote').hidden);
  await page.fill('#ttsName', 'Hostile text'); await page.click('#ttsSave');
  await until(page, async () => (await window.deck.getLibrary()).clips.some(c => c.name === 'Hostile text'));
  const hostile = await clipNamed(page, 'Hostile text');
  assert.equal(hostile.source.text, 'Quotes "yes" \'no\' 🎮 日本語\n$(calc) `whoami` <speak>tag</speak>');

  // Save the phrase as a pad; insert it between two Studio regions.
  await page.fill('#ttsText', PHRASE); await page.fill('#ttsName', 'Match start');
  await page.click('#ttsSave');
  await until(page, async () => (await window.deck.getLibrary()).clips.some(c => c.name === 'Match start'));
  const pad = await clipNamed(page, 'Match start');
  assert.deepEqual([pad.source.kind, pad.source.voice, pad.source.provider, pad.source.text], ['tts', 'Test Voice', 'test', PHRASE]);
  ctx.ttsPad = pad.id;
  await page.click('#studioNav');
  const track1 = await page.evaluate(() => window.__test.studio.current.project.tracks[0].id);
  const lane = await page.locator(`.track-lane[data-track="${track1}"]`).boundingBox();
  const visible = await page.locator('#studioTimeline').boundingBox();
  // Select track 1 by clicking its lane above the regions, inside the visible part of the timeline.
  await page.mouse.click(Math.min(lane.x + lane.width - 20, visible.x + visible.width - 30), lane.y + 3);
  const first = (await studioRegions(page)).find(r => r.trackId === track1 && r.atSeconds === 0);
  const ruler = await page.locator('#studioRuler').boundingBox();
  const pps = (await page.locator(`.studio-region[data-id="${first.id}"]`).boundingBox()).width / (first.outSeconds - first.inSeconds);
  await page.mouse.click(ruler.x + (first.outSeconds - first.inSeconds) * pps + 1, ruler.y + 10);
  assert.equal(await page.evaluate(() => window.__test.studio.playhead), 4.75);
  const nextBefore = (await studioRegions(page)).find(r => r.trackId === track1 && r.atSeconds === 4.75);
  await page.click('#ttsNav'); await page.click('#ttsInsert');
  await until(page, () => window.__test.studio.current.project.regions.some(r => r.label === 'Match start'));
  const inserted = (await studioRegions(page)).find(r => r.label === 'Match start');
  const nextAfter = (await studioRegions(page)).find(r => r.id === nextBefore.id);
  assert.equal(inserted.atSeconds, 4.75); assert.equal(inserted.trackId, track1);
  assert.ok(Math.abs(nextAfter.atSeconds - (4.75 + inserted.outSeconds - inserted.inSeconds)) < 1e-6, 'later audio moved right to make room');
  pass(`“${PHRASE}” saves as a TTS pad with voice provenance and inserts between two Studio regions; hostile text stays plain data and language limits are explained`);
}

/* ─── Milestone E: organization, retrigger modes, exclusive groups, queue, ducking ─── */
const clipId = async (page, name) => (await clipNamed(page, name)).id;
const counts = (page, name) => page.evaluate(async n => { const c = (await window.deck.getLibrary()).clips.find(x => x.name === n); return window.__test.engine.clipCount(c.id); }, name);
async function padClick(page, name) {
  const found = await page.evaluate(n => { const pad = [...document.querySelectorAll('.sound-pad')].find(p => p.querySelector('.pad-name').textContent === n); pad?.querySelector('.pad-main').click(); return Boolean(pad); }, name);
  assert.ok(found, `pad “${name}” is visible`);
}
async function editDialog(page, name, fill) {
  await openMenu(page, name, 'edit'); await page.waitForSelector('#editDialog[open]');
  await fill(); await page.click('#editForm button[type=submit]');
}

async function organizeFlow(ctx) {
  const { page } = ctx;
  await page.click('#boardNav');
  const keysBefore = (await library(page)).clips.map(c => `${c.id}=${c.hotkey}`);
  // Favorites and tags from the pad menu; search matches tags; combined filters and empty states.
  await openMenu(page, 'Take one', 'favorite');
  await until(page, async () => (await window.deck.getLibrary()).clips.find(c => c.name === 'Take one').favorite);
  await openMenu(page, 'Take one', 'tags'); await askText(page, 'hype, intro, HYPE');
  await until(page, async () => (await window.deck.getLibrary()).clips.find(c => c.name === 'Take one').tags.join() === 'hype,intro');
  await page.click('#favTab');
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.pad-name')].map(n => n.textContent)), ['Take one']);
  await page.click('#allTab');
  await page.fill('#search', 'hype');
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.pad-name')].map(n => n.textContent)), ['Take one'], 'search matches tags');
  await page.fill('#search', 'zzz-nothing');
  await page.waitForFunction(() => document.querySelector('.grid-note')?.textContent.includes('No sounds match'));
  await page.fill('#search', '');

  // Multi-select into a new collection; the collection view keeps real shortcut labels; local reorder only.
  await page.click('#selectModeBtn');
  await padClick(page, 'Take one'); await padClick(page, 'Match start'); await padClick(page, 'Hostile text');
  assert.equal(await page.locator('#selectionCount').textContent(), '3 selected');
  assert.equal(await counts(page, 'Take one'), 0, 'clicking in select mode does not play');
  await page.click('#selectionCollection');
  await page.waitForSelector('#pickDialog[open]'); await page.selectOption('#pickDialogSelect', '__new'); await page.fill('#pickDialogName', 'Stream set'); await page.click('#pickDialog button[type=submit]');
  await until(page, async () => (await window.deck.getLibrary()).collections.some(c => c.name === 'Stream set' && c.clipIds.length === 3));
  const collection = (await library(page)).collections.find(c => c.name === 'Stream set');
  await page.selectOption('#collectionFilter', collection.id);
  // Selected pads join the collection in board order.
  const boardOrder = (await library(page)).clips.map(c => c.name).filter(n => ['Take one', 'Match start', 'Hostile text'].includes(n));
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.pad-name')].map(n => n.textContent)), boardOrder);
  const shown = await page.evaluate(() => [...document.querySelectorAll('.sound-pad')].map(p => p.querySelector('.pad-key')?.textContent || ''));
  const expectedKeys = await page.evaluate(async ids => { const clips = (await window.deck.getLibrary()).clips; return ids.map(id => { const c = clips.find(x => x.id === id); return c.hotkey ? c.hotkey.replace('Control', window.deck.platform === 'darwin' ? 'Cmd' : 'Ctrl').replace('Alt', window.deck.platform === 'darwin' ? 'Option' : 'Alt') : ''; }); }, collection.clipIds);
  assert.deepEqual(shown, expectedKeys, 'collection pads show each clip’s actual shortcut');
  await page.locator('.sound-pad').nth(2).dragTo(page.locator('.sound-pad').nth(0), { targetPosition: { x: 12, y: 20 } });
  await until(page, async id => (await window.deck.getLibrary()).collections.find(c => c.id === id).clipIds[0] !== (await window.deck.getLibrary()).clips.find(c => c.name === 'Take one').id, collection.id);
  assert.deepEqual((await library(page)).clips.map(c => `${c.id}=${c.hotkey}`), keysBefore, 'global order and slot shortcuts are unchanged');
  await page.click('#favTab');
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.pad-name')].map(n => n.textContent)), ['Take one'], 'collection + favorites combine');
  await page.click('#allTab');
  await openMenu(page, 'Hostile text', 'uncollect');
  await until(page, async id => (await window.deck.getLibrary()).collections.find(c => c.id === id).clipIds.length === 2, collection.id);
  // The overlay mirrors favorites and real shortcuts.
  // The overlay window already exists from the region checks; reuse it instead of waiting for a new window.
  const overlayPromise = ctx.overlay ? null : ctx.app.waitForEvent('window');
  await page.click('#overlayBtn');
  const overlay = ctx.overlay || await overlayPromise;
  ctx.overlay = overlay;
  await overlay.waitForFunction(() => [...document.querySelectorAll('.pad .name')].some(n => n.textContent === '★ Take one'));
  await overlay.click('#hideBtn');
  await page.click('#collectionMenuBtn'); await page.click('#padMenu [data-action=delete-collection]'); await choose(page, 'delete');
  await until(page, async () => (await window.deck.getLibrary()).collections.length === 0);
  assert.ok((await library(page)).clips.some(c => c.name === 'Take one'), 'deleting a collection keeps its sounds');
  await page.click('#selectModeBtn'); await page.click('#selectModeBtn');
  pass('Favorites, tags (tag search), multi-select into a collection, collection-local reorder with unchanged slot shortcuts, combined filters, empty states, overlay favorites, and collection deletion work');
}

async function retriggerFlow(ctx) {
  const { page } = ctx;
  // Overlap: independent copies, a visible count, and the 8-per-sound cap.
  await editDialog(page, 'Take one', async () => { await page.selectOption('#editTrigger', 'overlap'); });
  await until(page, async () => (await window.deck.getLibrary()).clips.find(c => c.name === 'Take one').triggerMode === 'overlap');
  for (let i = 0; i < 3; i++) await padClick(page, 'Take one');
  await until(page, async () => { const c = (await window.deck.getLibrary()).clips.find(x => x.name === 'Take one'); return window.__test.engine.clipCount(c.id) === 3; });
  await page.waitForFunction(() => [...document.querySelectorAll('.pad-count')].some(b => !b.hidden && b.textContent === '×3'));
  for (let i = 0; i < 6; i++) await padClick(page, 'Take one');
  await toastSeen(page, 'already playing 8 times');
  assert.equal(await counts(page, 'Take one'), 8);
  await press(page, '#stopAll'); await until(page, () => window.__test.engine.instances.size === 0);
  // Restart: one instance, and a fresh one each trigger (old callbacks cannot remove the new one).
  await editDialog(page, 'Match start', async () => { await page.selectOption('#editTrigger', 'restart'); });
  await until(page, async () => (await window.deck.getLibrary()).clips.find(c => c.name === 'Match start').triggerMode === 'restart');
  await padClick(page, 'Match start'); await pause(page,200);
  const firstId = await page.evaluate(async id => window.__test.engine.clipInstances(id)[0]?.id, await clipId(page, 'Match start'));
  for (let i = 0; i < 5; i++) await padClick(page, 'Match start');
  await pause(page,300);
  const after = await page.evaluate(async id => window.__test.engine.clipInstances(id).map(i => i.id), await clipId(page, 'Match start'));
  assert.equal(after.length, 1); assert.ok(after[0] > firstId, 'restart replaced the instance');
  // Loop + overlap is refused in the editor.
  await openMenu(page, 'Take one', 'edit'); await page.check('#editLoop');
  assert.ok(await page.evaluate(() => document.querySelector('#editTrigger option[value=overlap]').disabled));
  await page.click('#closeEdit');
  await assert.rejects(page.evaluate(async id => window.deck.editSound(id, { loop: true, triggerMode: 'overlap' }), await clipId(page, 'Take one')), /Looping sounds/);
  // Exclusive group created in the editor: starting one stops the other; ungrouped sounds continue.
  await editDialog(page, 'Take one', async () => {
    await page.selectOption('#editGroup', '__new'); await askText(page, 'Beds');
    await page.waitForFunction(() => [...document.querySelector('#editGroup').options].some(o => o.textContent === 'Beds' && o.selected));
  });
  const group = (await library(page)).groups.find(g => g.name === 'Beds').id;
  await page.evaluate(async ({ id, group }) => window.deck.editSound(id, { exclusiveGroupId: group }), { id: await clipId(page, 'Match start'), group });
  await page.reload(); await page.waitForFunction(() => Boolean(window.__test)); await stubHardware(page); await connect(page);
  await padClick(page, 'Expandable line');
  await padClick(page, 'Take one'); await until(page, async () => (await window.deck.getLibrary()).clips.some(c => c.name === 'Take one' && window.__test.engine.clipCount(c.id) === 1));
  await padClick(page, 'Match start'); await pause(page,250);
  assert.equal(await counts(page, 'Take one'), 0, 'the other sound in the group stopped');
  assert.equal(await counts(page, 'Match start'), 1);
  assert.equal(await counts(page, 'Expandable line'), 1, 'ungrouped sounds keep playing');
  // Stop all with loops and overlaps mixed.
  await page.evaluate(async id => window.deck.editSound(id, { loop: true, triggerMode: 'restart' }), await clipId(page, 'Expandable line'));
  await page.reload(); await page.waitForFunction(() => Boolean(window.__test)); await stubHardware(page); await installTap(page, 'board'); await connect(page);
  await padClick(page, 'Expandable line'); await padClick(page, 'Take one'); await padClick(page, 'Take one');
  await pause(page,300); await press(page, '#stopAll');
  await pause(page,250); await tapStart(page, 'board'); await pause(page,500);
  assert.equal((await tapStop(page, 'board')).audible, 0); assert.equal(await page.evaluate(() => window.__test.engine.instances.size), 0);
  await page.evaluate(async id => window.deck.editSound(id, { loop: false }), await clipId(page, 'Expandable line'));
  pass('Overlap stacks independent copies (×N badge, 8-copy cap), Restart replaces the instance, loop+overlap is refused, exclusive groups stop each other but not ungrouped sounds, and Stop all clears mixed loops/overlaps');
}

async function queueFlow(ctx) {
  const { page } = ctx;
  await page.reload(); await page.waitForFunction(() => Boolean(window.__test)); await stubHardware(page); await installTap(page, 'board'); await connect(page);
  await page.evaluate(async id => window.deck.editSound(id, { loop: true, triggerMode: 'restart', exclusiveGroupId: '' }), await clipId(page, 'Match start'));
  await page.evaluate(async id => window.deck.editSound(id, { triggerMode: 'toggle', exclusiveGroupId: '' }), await clipId(page, 'Take one'));
  await page.reload(); await page.waitForFunction(() => Boolean(window.__test)); await stubHardware(page); await installTap(page, 'board'); await connect(page);
  const durations = await page.evaluate(async () => { const clips = (await window.deck.getLibrary()).clips; const d = n => clips.find(c => c.name === n).duration; return { take: d('Take one'), match: d('Match start') }; });
  for (const name of ['Take one', 'Match start', 'Take one']) await openMenu(page, name, 'queue');
  await page.waitForFunction(() => !document.querySelector('#queuePanel').hidden && document.querySelectorAll('.queue-item').length === 3);
  assert.match(await page.locator('#queuePanel').textContent(), /Queue plays each sound once/);
  await tapStart(page, 'board');
  await press(page, '#queuePlay');
  await page.waitForFunction(() => window.__test.queue.state === 'playing');
  await page.waitForFunction(() => window.__test.queue.state === 'stopped', undefined, { timeout: 60000 });
  await pause(page,200);
  const all = await tapStop(page, 'board');
  const expected = durations.take * 2 + durations.match;
  assert.ok(Math.abs(all.audible - expected) < 0.35, `three entries, each once (a looping pad included): ${all.audible} vs ${expected}`);
  assert.equal(await page.locator('.queue-item').count(), 0);
  pass('The queue plays three entries (duplicates allowed) exactly once each, including a looping pad, and advances on completion');

  // Pause resumes from the same position; Next moves on; an outside stop pauses; Stop all keeps entries.
  for (const name of ['Match start', 'Take one', 'Match start']) await openMenu(page, name, 'queue');
  await tapStart(page, 'board');
  await press(page, '#queuePlay'); await pause(page,700);
  await press(page, '#queuePlay');
  await page.waitForFunction(() => window.__test.queue.state === 'paused');
  const offset = await page.evaluate(() => window.__test.queue.offset);
  assert.ok(offset > 0.4 && offset < durations.match, `paused at ${offset}`);
  await pause(page,400);
  await press(page, '#queuePlay');
  await page.waitForFunction(() => window.__test.queue.entries.length === 2, undefined, { timeout: 30000 });
  const firstEntry = await tapStop(page, 'board');
  assert.ok(firstEntry.audible < durations.match + 0.8, 'resume continued instead of restarting the entry');
  await press(page, '#queueNext');
  await page.waitForFunction(() => window.__test.queue.entries.length === 1 && window.__test.queue.state === 'playing');
  await pause(page,200);
  await padClick(page, 'Match start');
  await page.waitForFunction(() => window.__test.queue.state === 'paused' && !document.querySelector('#queueMessage').hidden);
  assert.match(await page.locator('#queueMessage').textContent(), /stopped outside the queue/);
  await press(page, '#stopAll');
  await openMenu(page, 'Take one', 'queue');
  await press(page, '#queuePlay'); await page.waitForFunction(() => window.__test.queue.state === 'playing');
  await press(page, '#stopAll');
  await pause(page,250); await tapStart(page, 'board'); await pause(page,700);
  assert.equal((await tapStop(page, 'board')).audible, 0, 'no late queue dispatch after Stop all');
  assert.equal(await page.evaluate(() => window.__test.queue.state), 'stopped');
  assert.equal(await page.locator('.queue-item').count(), 2, 'Stop all keeps pending entries');
  pass('Queue pause resumes mid-sound, Next skips once, a manual pad stop pauses the queue with a message, and Stop all cancels dispatch while keeping entries');
  ctx.queuedAtRestart = 2;
}

async function duckingFlow(ctx) {
  const { page } = ctx;
  await page.click('#boardNav');
  await page.click('#connectBtn'); await page.waitForFunction(() => !document.querySelector('#statusPill').classList.contains('live'));
  await connect(page, 'test-mic');
  await installTap(page, 'boardOut');
  const boardVolume = (await library(page)).settings.boardVolume;
  await page.check('#duckEnabled');
  await until(page, async () => (await window.deck.getLibrary()).settings.ducking.enabled === true);
  await page.evaluate(async id => window.deck.editSound(id, { loop: true, triggerMode: 'restart' }), await clipId(page, 'Take one'));
  const measure = async () => {
    await tapStart(page, 'board'); await tapStart(page, 'boardOut'); await pause(page,500);
    const before = await tapStop(page, 'board'), after = await tapStop(page, 'boardOut');
    return 20 * Math.log10(Math.max(1e-6, after.peak) / Math.max(1e-6, before.peak));
  };
  await page.reload(); await page.waitForFunction(() => Boolean(window.__test)); await stubHardware(page); await installTap(page, 'board'); await installTap(page, 'boardOut'); await connect(page, 'test-mic');
  await padClick(page, 'Take one');
  await pause(page,600);
  const speaking = await measure();
  assert.ok(speaking < -10 && speaking > -14, `speech lowers the board about 12 dB (${speaking.toFixed(1)} dB)`);
  assert.match(await page.locator('#duckState').textContent(), /Lowering sounds/);
  await page.click('#muteBtn'); await pause(page,900);
  const muted = await measure();
  assert.ok(muted > -1, `a muted microphone does not duck (${muted.toFixed(1)} dB)`);
  await page.click('#muteBtn');
  await page.evaluate(() => { window.testMicGainNode.gain.value = 0.002; }); await pause(page,900);
  const quiet = await measure();
  assert.ok(quiet > -1, `a microphone below the threshold does not duck (${quiet.toFixed(1)} dB)`);
  await page.evaluate(() => { window.testMicGainNode.gain.value = 0.2; }); await pause(page,600);
  assert.ok((await measure()) < -10);
  await page.uncheck('#duckEnabled');
  // Turning ducking off releases to unity, then takes the ducker out of the board path entirely.
  await page.waitForFunction(() => window.__test.engine.boardOut === window.__test.engine.board && window.__test.engine.ducker === null && window.__test.engine.duckGain === 1);
  assert.equal((await library(page)).settings.boardVolume, boardVolume, 'the saved board volume is never changed');
  assert.ok(await ctx.app.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows().find(w => w.getTitle() === 'PulseDeck').isVisible()), 'measured with the window hidden');
  await press(page, '#stopAll');
  await page.evaluate(async id => window.deck.editSound(id, { loop: false }), await clipId(page, 'Take one'));
  await page.click('#connectBtn');
  pass('Ducking lowers the board about 12 dB while the (hidden-window) microphone is above the threshold, not when muted or quiet, returns to unity when turned off, and never changes the saved board volume');
}

/* ─── Milestone F: per-sound export and portable backup ─── */
function readWav(bytes) {
  const channels = bytes.readUInt16LE(22), rate = bytes.readUInt32LE(24), frames = bytes.readUInt32LE(40) / (2 * channels);
  const left = new Float32Array(frames);
  for (let i = 0; i < frames; i++) left[i] = bytes.readInt16LE(44 + i * 2 * channels) / 32768;
  const hz = (from, to) => { let c = 0; for (let i = Math.round(from * rate) + 1; i < Math.round(to * rate); i++) if ((left[i - 1] < 0) !== (left[i] < 0)) c++; return c / 2 / (to - from); };
  return { channels, rate, frames, seconds: frames / rate, hz };
}

async function exportFlow(ctx) {
  const { page, app, base, dataDir } = ctx;
  await page.click('#boardNav');
  const out = path.join(base, 'exports'); await fs.mkdir(out, { recursive: true });
  await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true }); });
  await openMenu(page, 'Timecode', 'export-region'); await pause(page,900);
  assert.deepEqual(await fs.readdir(out), [], 'Cancel writes no file');
  const regionFile = path.join(out, 'region.wav');
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, regionFile);
  await openMenu(page, 'Timecode', 'export-region');
  await toastSeen(page, 'the played region');
  const exported = readWav(await fs.readFile(regionFile));
  assert.ok(Math.abs(exported.seconds - 4.75) < 0.002, `region export length ${exported.seconds}`);
  assert.ok(Math.abs(exported.hz(0.05, 0.45) - 540) < 12 && Math.abs(exported.hz(4.3, 4.7) - 640) < 12, 'the export holds exactly 12.500–17.250 s');
  const originalFile = path.join(out, 'original.wav');
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, originalFile);
  await openMenu(page, 'Timecode', 'export-original');
  await toastSeen(page, 'untouched original');
  const clip = await clipNamed(page, 'Timecode');
  assert.equal(await sha(originalFile), await sha(path.join(dataDir, 'clips', clip.file)), 'Export original copies the source bytes');
  assert.deepEqual((await fs.readdir(out)).sort(), ['original.wav', 'region.wav'], 'no temporary files remain');
  pass('Pad exports: “played region” renders exactly 12.500–17.250 s with pad gain; “original” is byte-identical; Cancel writes nothing');
}

async function backupFlow(ctx) {
  const { page, app, base, dataDir } = ctx;
  const out = path.join(base, 'backups'); await fs.mkdir(out, { recursive: true });
  await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, out);
  await page.click('#backupBtn'); await choose(page, 'backup');
  await page.waitForFunction(() => document.querySelector('#choiceDialog[open]') || (window.__toasts || []).some(t => t.startsWith('Backed up')));
  if (await page.locator('#choiceDialog[open]').count()) await choose(page, 'save');
  await toastSeen(page, 'Backed up');
  const [folder] = await fs.readdir(out);
  assert.match(folder, /^PulseDeck Backup /);
  const backupFolder = path.join(out, folder);
  const live = await library(page);
  const second = await launch(path.join(base, 'restored-data'));
  try {
    const p2 = second.page;
    await second.app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, backupFolder);
    await p2.click('#backupBtn'); await choose(p2, 'restore');
    await toastSeen(p2, 'Restored');
    const restored = await library(p2);
    assert.deepEqual(restored.clips.map(c => c.name), live.clips.map(c => c.name), 'every sound restored in order');
    for (const clip of live.clips) {
      const twin = restored.clips.find(c => c.name === clip.name);
      assert.equal(await sha(path.join(base, 'restored-data', 'clips', twin.file)), await sha(path.join(dataDir, 'clips', clip.file)), `${clip.name} audio checksum`);
      assert.deepEqual(twin.playback, clip.playback); assert.deepEqual(twin.tags, clip.tags); assert.equal(twin.favorite, clip.favorite);
    }
    const combo = restored.clips.find(c => c.name === 'Studio combo');
    assert.ok(restored.projects.some(p => p.id === combo.source.projectId), 'the composed pad points at its restored project');
    assert.equal(restored.clips.find(c => c.name === 'Match start').source.text, PHRASE);
    assert.equal(restored.projects.length, live.projects.filter(p => p.saved).length);
    assert.equal(await p2.locator('#statusPill.live').count(), 0, 'restore never connects the broadcast');
    assert.equal(await p2.evaluate(() => Boolean(window.__test.engine.replay)), false, 'restore never starts capture');
    assert.equal(restored.settings.outputId, '');
    await p2.click('#studioNav'); await p2.selectOption('#studioProject', combo.source.projectId);
    await p2.waitForFunction(id => window.__test.studio.current?.id === id, combo.source.projectId);
    await p2.click('#studioRender'); await askText(p2, 'Rendered after restore');
    await until(p2, async () => (await window.deck.getLibrary()).clips.some(c => c.name === 'Rendered after restore'), undefined, 30000);
    pass('Backup writes a checksummed folder; restoring into a fresh data root keeps audio checksums, regions, tags, favorites, speech text, project provenance, and renderable projects, without connecting devices or capture');
  } finally { await second.app.close(); }
}

async function queueAfterRestart(ctx) {
  const { page } = ctx;
  await page.waitForFunction(n => window.__test.queue.entries.length === n, ctx.queuedAtRestart);
  assert.equal(await page.evaluate(() => window.__test.queue.state), 'stopped');
  await pause(page,500);
  assert.equal(await page.evaluate(() => window.__test.engine.instances.size), 0, 'a restored queue never plays by itself');
  pass('Pending queue entries are restored after restart, stopped, without playing');
}

async function ttsAfterRestart(ctx) {
  const { page, app } = ctx;
  // The queue checks left this pad looping. Edit it, then reload so the renderer reads the saved library.
  await page.evaluate(async id => window.deck.editSound(id, { loop: false }), ctx.ttsPad);
  await page.reload(); await page.waitForFunction(() => Boolean(window.__test)); await stubHardware(page);
  await page.click('#boardNav');
  await installTap(page, 'board');
  await connect(page);
  assert.equal(await page.evaluate(id => window.__test.state().clips.find(c => c.id === id).loop, ctx.ttsPad), false);
  await tapStart(page, 'board');
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows().find(w => w.getTitle() === 'PulseDeck').webContents.send('shortcut', { type: 'play', id }), ctx.ttsPad);
  await page.waitForFunction(() => document.querySelector('.sound-pad.playing'));
  await page.waitForFunction(() => !document.querySelector('.sound-pad.playing'), undefined, { timeout: 30000 });
  await pause(page,150);
  assert.ok((await tapStop(page, 'board')).audible > 1, 'the saved speech pad plays its stored audio after restart');
  pass('A saved speech pad plays its stored audio after restart through the board, without re-synthesizing');
}

async function main() {
  await fs.mkdir(results, { recursive: true });
  const base = await fs.mkdtemp(path.join(results, 'features-'));
  const dataDir = path.join(base, 'data');
  const timecode = path.join(base, 'Timecode.wav'); await fs.writeFile(timecode, timecodeWav());
  let { app, page, errors } = await launch(dataDir);
  const ctx = { app, page, dataDir, base };
  try {
    await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, [timecode]);
    await page.click('#importBtn'); await page.waitForFunction(() => document.querySelectorAll('.sound-pad').length === 1);
    await regions(ctx);
    await captureToPad(ctx);
    await studioDsp(ctx);
    await studioFlow(ctx);
    await recorderFlow(ctx);
    await ttsFlow(ctx);
    await organizeFlow(ctx);
    await retriggerFlow(ctx);
    await queueFlow(ctx);
    await duckingFlow(ctx);
    await exportFlow(ctx);
    await backupFlow(ctx);
    // Restart: the saved region still plays exactly after a full relaunch.
    await app.close();
    ({ app, page, errors } = await launch(dataDir)); Object.assign(ctx, { app, page });
    await queueAfterRestart(ctx);
    await installTap(page); await connect(page);
    await tapStart(page);
    await page.locator('.sound-pad').nth(await padIndex(page, 'Timecode')).locator('.pad-main').click();
    await page.waitForFunction(() => document.querySelector('.sound-pad.playing'));
    await page.waitForFunction(() => !document.querySelector('.sound-pad.playing'), undefined, { timeout: 30000 });
    await pause(page,150);
    const restarted = await tapStop(page);
    assert.ok(Math.abs(restarted.audible - 4.75) < 0.06 && Math.abs(restarted.startHz - 540) < 12 && Math.abs(restarted.endHz - 640) < 12, JSON.stringify(restarted));
    pass('The saved region plays exactly after restarting the app');
    await studioAfterRestart(ctx);
    await ttsAfterRestart(ctx);
    assert.deepEqual(errors, []);
    const report = { passed: checks.length, checks, note: 'Hardware endpoints were stubbed; decoding, mixing, worklets, persistence, IPC, and UI were real. Output was measured on the soundboard bus.' };
    await fs.writeFile(path.join(results, 'features-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await ctx.app.close(); }
}
main().catch(error => {
  console.error(error);
  // CI logs need a token to read; workflow annotations are public, so surface the failure there too.
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=features.cjs failed after: ${(checks.at(-1) || 'start').slice(0, 120).replace(/[:,]/g, ' ')}::${String(error.stack || error).slice(0, 3500).replace(/%/g, '%25').replace(/\r?\n/g, '%0A')}`);
  process.exitCode = 1;
});
