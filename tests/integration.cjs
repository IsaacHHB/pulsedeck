const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const results = path.join(root, 'test-results');
function wav(hz = 440, amplitude = 6000) {
  const rate = 48000, samples = rate * 2, data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * i / rate) * amplitude), 44 + i * 2);
  return data;
}
async function until(page, fn, timeout = 12000) {
  const started = Date.now();
  while (true) {
    if (await page.evaluate(fn)) return;
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for: ' + fn.toString().slice(0, 120));
    await page.waitForTimeout(100);
  }
}
async function main() {
  await fs.mkdir(results, { recursive: true });
  const dataRoot = await fs.mkdtemp(path.join(results, 'integration-'));
  const files = [];
  const lameScope = {}; vm.runInNewContext(await fs.readFile(require.resolve('lamejs/lame.all.js'), 'utf8'), lameScope);
  for (const [i, name] of ['Air horn', 'Good game', 'Plot twist', 'Drum roll', 'Victory lap', 'Mic drop'].entries()) {
    const file = path.join(dataRoot, name + (i === 0 ? '.mp3' : '.wav')); let bytes = wav(220 + i * 110, i === 5 ? 400 : 6000);
    if (i === 0) { const encoder = new lameScope.lamejs.Mp3Encoder(1, 48000, 128); const samples = new Int16Array(bytes.buffer.slice(bytes.byteOffset + 44, bytes.byteOffset + bytes.length)); bytes = Buffer.concat([Buffer.from(encoder.encodeBuffer(samples)), Buffer.from(encoder.flush())]); }
    await fs.writeFile(file, bytes); files.push(file);
  }
  const badFile = path.join(dataRoot, 'broken.mp3'); await fs.writeFile(badFile, 'not valid audio');
  const env = { ...process.env, PULSEDECK_TEST: '1', PULSEDECK_DATA: path.join(dataRoot, 'data') }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['--no-sandbox', root], env, timeout: 30000 });
  const checks = [], errors = [];
  checks.push = function(...items) { items.forEach(item => console.log('PASS:', item)); return Array.prototype.push.apply(this, items); };
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') console.log('renderer:', message.text()); });
    await page.waitForFunction(() => Boolean(window.deck) && document.querySelector('#micVolume').value === '100');
    await page.screenshot({ path: path.join(results, 'empty.png') });
    checks.push('Desktop starts with an isolated renderer, no automatic microphone capture, and an empty library');
    await page.waitForFunction(() => document.querySelector('#versionBtn').textContent.includes('PulseDeck · v'));
    assert.equal(await page.locator('#updateBtn').isVisible(), false, 'No restart button before an update is downloaded');
    const unavailableUpdate = await page.evaluate(() => window.deck.installUpdate());
    assert.equal(unavailableUpdate.ok, false);
    assert.match(unavailableUpdate.message, /No downloaded update/);
    for (const status of ['manual', 'checking', 'downloading', 'latest', 'error', 'ready', 'installing']) {
      await app.evaluate(({ BrowserWindow }, status) => {
        BrowserWindow.getAllWindows()[0].webContents.send('update', { status, version: '99.0.0' });
      }, status);
      await page.waitForFunction(status => {
        const button = document.querySelector('#updateBtn');
        return button.hidden === !['ready', 'installing'].includes(status) && button.disabled === (status === 'installing');
      }, status);
      assert.equal(await page.locator('#updateBtn').isVisible(), ['ready', 'installing'].includes(status), status);
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('update', { status: 'ready', version: '99.0.0' }));
    await page.locator('#updateBtn').click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('No downloaded update'));
    assert.equal(await page.locator('#updateBtn').isVisible(), false, 'Stale ready state is corrected after clicking');
    checks.push('Restart button appears only for a downloaded update, disables during installation, and explains unavailable updates');
    if (process.platform === 'darwin') {
      const macUI = await page.evaluate(() => ({ platform: window.deck.platform, guide: document.querySelector('#guideDialog').textContent, driver: document.querySelector('#driverLink').textContent }));
      assert.equal(macUI.platform, 'darwin');
      assert.ok(macUI.guide.includes('Cmd+Option+R') && !macUI.guide.includes('Ctrl'));
      assert.ok(macUI.guide.includes('Original sound for musicians') && macUI.driver.includes('BlackHole'));
      assert.ok(!macUI.guide.includes('Windows') && !macUI.guide.includes('VB-CABLE'));
      const capture = await page.evaluate(async () => {
        const { AudioEngine } = await import('./audio.js');
        const engine = new AudioEngine(), original = navigator.mediaDevices.getDisplayMedia;
        let legacyCalled = false, stopped = 0;
        const legacy = navigator.mediaDevices.getUserMedia;
        navigator.mediaDevices.getUserMedia = async () => { legacyCalled = true; throw new Error('Legacy path called'); };
        const video = { stop() { stopped++; } }, audio = { readyState: 'live', stop() { stopped++; } };
        const stream = { getVideoTracks: () => [video], removeTrack() {}, getAudioTracks: () => [audio], getTracks: () => [audio] };
        navigator.mediaDevices.getDisplayMedia = async () => stream;
        try {
          const result = await engine.captureSystemAudio();
          const good = result === stream && stopped === 1 && !legacyCalled;
          navigator.mediaDevices.getDisplayMedia = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
          let denied = '';
          try { await engine.captureSystemAudio(); } catch (e) { denied = e.message; }
          navigator.mediaDevices.getDisplayMedia = async () => ({ ...stream, getAudioTracks: () => [], getTracks: () => [audio] });
          let missing = '';
          try { await engine.captureSystemAudio(); } catch (e) { missing = e.message; }
          return { good, denied, missing, stopped, legacyCalled };
        } finally {
          navigator.mediaDevices.getDisplayMedia = original;
          navigator.mediaDevices.getUserMedia = legacy;
        }
      });
      assert.ok(capture.good && !capture.legacyCalled);
      assert.ok(capture.denied.includes('Privacy & Security') && capture.missing.includes('No system audio track'));
      assert.equal(capture.stopped, 3);
      checks.push('Mac guide, system-capture path, permission denial, and missing-track cleanup work');
    }

    const security = await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process }));
    assert.deepEqual(security, { require: 'undefined', process: 'undefined' });
    await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, files);
    await page.click('#importBtn'); await page.waitForFunction(() => document.querySelectorAll('.sound-pad').length === 6);
    await page.fill('#search', 'victory'); assert.equal(await page.locator('.sound-pad').count(), 1); await page.fill('#search', '');
    checks.push('Native file import copies MP3 and WAV clips and search filters them');
    await page.locator('.pad-main').first().click(); await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Connect the broadcast'));
    checks.push('Playback is blocked until a deliberate output or headphone monitor is connected');
    await page.locator('.pad-edit').first().click(); await page.click('#padMenu [data-action=edit]'); await page.fill('#editName', 'Air horn · test'); await page.check('#editLoop'); await page.check('#editColor input[value=purple]'); await page.click('#editForm button[type=submit]');
    await page.waitForFunction(() => document.querySelector('.pad-name').textContent === 'Air horn · test');
    await page.click('#loopTab'); assert.equal(await page.locator('.sound-pad').count(), 1); await page.click('#allTab');
    checks.push('Name, color, looping, and loop filtering update and persist');
    // Exercise the real Web Audio graph while replacing only the external hardware boundary.
    // Test audio stays on a silent AudioContext sink; no real microphone or speakers are used.
    await page.evaluate(() => {
      window.testSinks = []; window.testSinkFailure = false;
      AudioContext.prototype.setSinkId = async function(id) { window.testSinks.push(id); if (window.testSinkFailure) throw new DOMException('Output device is unavailable', 'NotFoundError'); };
      window.testTracks = []; window.testCaptureContexts = [];
      navigator.mediaDevices.getUserMedia = async () => {
        const ctx = new AudioContext({ sampleRate: 48000, sinkId: { type: 'none' } });
        const oscillator = ctx.createOscillator(), gain = ctx.createGain(), destination = ctx.createMediaStreamDestination();
        oscillator.frequency.value = 880; gain.gain.value = 0.2; oscillator.connect(gain); gain.connect(destination); oscillator.start(); await ctx.resume();
        window.testCaptureContexts.push(ctx); window.testTracks.push(...destination.stream.getTracks()); return destination.stream;
      };
      navigator.mediaDevices.getDisplayMedia = async () => navigator.mediaDevices.getUserMedia();
      window.testDevices = [
        { kind: 'audioinput', deviceId: 'test-mic', label: 'Test physical microphone' },
        { kind: 'audioinput', deviceId: 'test-return', label: window.deck.platform === 'darwin' ? 'BlackHole 2ch' : 'CABLE Output (test)' },
        { kind: 'audiooutput', deviceId: 'test-cable', label: window.deck.platform === 'darwin' ? 'BlackHole 2ch' : 'CABLE Input (test)' },
        { kind: 'audiooutput', deviceId: 'test-phones', label: 'Test headphones' }
      ];
      navigator.mediaDevices.enumerateDevices = async () => window.testDevices;
      HTMLMediaElement.prototype.setSinkId = async function(id) { window.testMonitorSink = id; };
      HTMLMediaElement.prototype.play = async function() {};
    });
    await page.click('#refreshDevices'); await page.waitForFunction(() => document.querySelector('#outputDevice').value === 'test-cable');
    await page.selectOption('#micDevice', 'none'); await page.click('#connectBtn'); await page.waitForFunction(() => document.querySelector('#statusPill').classList.contains('live'));
    await page.locator('.pad-main').first().click(); await page.waitForFunction(() => document.querySelector('.sound-pad').classList.contains('playing'));
    await page.waitForFunction(() => document.querySelector('#levelLabel').textContent === 'ACTIVE');
    await page.waitForFunction(() => document.querySelector('.pad-meta').textContent.includes('0:02'));
    checks.push('Real MP3 decoding and the soundboard/limiter graph produce nonzero PCM with a selected broadcast sink');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('shortcut', { type: 'stop' }));
    await page.waitForFunction(() => document.querySelectorAll('.sound-pad.playing').length === 0);
    const registered = await app.evaluate(({ globalShortcut }) => ({ stop: globalShortcut.isRegistered((process.platform === 'darwin' ? 'Command' : 'Control') + '+Alt+Space'), mute: globalShortcut.isRegistered((process.platform === 'darwin' ? 'Command' : 'Control') + '+Alt+M'), pad: globalShortcut.isRegistered((process.platform === 'darwin' ? 'Command' : 'Control') + '+Alt+1') }));
    console.log('Shortcut registration:', registered);
    if (registered.stop && registered.mute && registered.pad) checks.push('Global shortcuts register, and the stop shortcut event stops all clips');
    else { const warning = await page.evaluate(() => window.deck.getLibrary()); assert.ok(warning.failedHotkeys.length); checks.push('Unavailable shortcut registrations are reported; injected stop events stop all clips'); }
    // Overlay: an always-on-top mini deck driven through the main window's engine.
    const overlayPromise = app.waitForEvent('window');
    await page.click('#overlayBtn'); await page.waitForFunction(() => document.querySelector('#overlayBtn').getAttribute('aria-pressed') === 'true');
    const overlayPage = await overlayPromise; overlayPage.setDefaultTimeout(12000); overlayPage.on('pageerror', error => errors.push('overlay: ' + error.message));
    await overlayPage.waitForFunction(() => document.querySelectorAll('.pad').length === 6);
    await overlayPage.locator('.pad').nth(1).click();
    await page.waitForFunction(() => document.querySelectorAll('.sound-pad')[1].classList.contains('playing'));
    await overlayPage.waitForFunction(() => document.querySelectorAll('.pad')[1].classList.contains('playing') && document.querySelector('#status').textContent.includes('1 playing'));
    await overlayPage.click('#stopBtn'); await page.waitForFunction(() => document.querySelectorAll('.sound-pad.playing').length === 0);
    await overlayPage.click('#muteBtn'); await page.waitForFunction(() => document.querySelector('#muteBtn').getAttribute('aria-pressed') === 'true');
    await overlayPage.waitForFunction(() => document.querySelector('#muteBtn').classList.contains('muted')); await overlayPage.click('#muteBtn');
    await page.waitForFunction(() => document.querySelector('#muteBtn').getAttribute('aria-pressed') === 'false');
    await overlayPage.screenshot({ path: path.join(results, 'overlay.png') });
    await overlayPage.click('#hideBtn'); await page.waitForFunction(() => document.querySelector('#overlayBtn').getAttribute('aria-pressed') === 'false');
    await until(page, async () => Boolean((await window.deck.getLibrary()).settings.overlay));
    const overlayBounds = await page.evaluate(async () => (await window.deck.getLibrary()).settings.overlay); assert.ok(overlayBounds && overlayBounds.width >= 200, JSON.stringify(overlayBounds));
    if (process.platform === 'darwin') {
      assert.ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle() === 'PulseDeck overlay').isVisibleOnAllWorkspaces()));
    }
    checks.push('Game overlay plays, stops, and mutes through the main audio engine, mirrors playing state, and remembers its position');
    // Auto-level: the deliberately quiet clip is measured and boosted toward the shared target.
    await page.locator('.pad-main').nth(5).click(); await page.waitForFunction(() => document.querySelectorAll('.sound-pad')[5].classList.contains('playing'));
    await until(page, async () => { const lib = await window.deck.getLibrary(); return Number.isFinite(lib.clips[5].loudness) && lib.clips[5].loudness < -30 && Number.isFinite(lib.clips[1].loudness); });
    const levels = await page.evaluate(async () => (await window.deck.getLibrary()).clips.map(c => c.loudness));
    assert.ok(levels[1] - levels[5] > 15, JSON.stringify(levels));
    await page.locator('.pad-main').nth(5).click(); await page.waitForFunction(() => document.querySelectorAll('.sound-pad.playing').length === 0);
    await page.locator('.pad-edit').nth(5).click({ force: true }); await page.click('#padMenu [data-action=edit]'); await page.waitForFunction(() => document.querySelector('#editLevelInfo').textContent.includes('Auto-level adds +'));
    const info = await page.locator('#editLevelInfo').textContent(); await page.click('#closeEdit');
    await page.uncheck('#autoLevel'); await until(page, async () => (await window.deck.getLibrary()).settings.autoLevel === false); await page.check('#autoLevel');
    await page.fill('#boardVolume', '160'); await until(page, async () => (await window.deck.getLibrary()).settings.boardVolume === 160); await page.fill('#boardVolume', '100');
    checks.push(`Quiet clips are measured and auto-leveled (${info.trim()}); soundboard boost persists up to 200%`);
    await page.click('#connectBtn'); await page.selectOption('#micDevice', 'test-mic'); await page.click('#connectBtn');
    await page.waitForFunction(() => document.querySelector('#statusPill').classList.contains('live'));
    const presets = require('../voice-presets.json'); assert.equal(await page.locator('[data-effect]').count(), presets.length);
    await page.click('#voiceNav'); await page.waitForFunction(() => !document.querySelector('#voiceView').hidden);
    for (const { id: effect } of presets) { console.log('Checking effect:', effect); await page.click(`[data-effect=${effect}]`); await page.waitForFunction(id => document.querySelector(`[data-effect=${id}]`).classList.contains('active') && document.querySelector('#heroName').textContent.length > 0, effect); await page.waitForFunction(() => document.querySelector('#levelLabel').textContent === 'ACTIVE'); }
    await page.waitForFunction(() => document.querySelector('#micLevelLabel').textContent !== 'Mic off');
    await page.fill('#voicePitch', '5'); await page.waitForFunction(() => document.querySelector('#voicePitchValue').textContent === '+5');
    await page.fill('#effectMix', '40'); await page.waitForFunction(() => document.querySelector('#effectMixValue').textContent === '40%');
    await page.waitForTimeout(400); await page.waitForFunction(() => document.querySelector('#levelLabel').textContent === 'ACTIVE');
    await page.click('#resetPitch'); await page.waitForFunction(() => document.querySelector('#voicePitchValue').textContent === '0');
    await page.fill('#effectMix', '100');
    await page.click('[data-effect=clean]'); await until(page, async () => (await window.deck.getLibrary()).settings.effect === 'clean');
    await page.screenshot({ path: path.join(results, 'voice.png') });
    await page.click('#muteBtn'); await page.waitForFunction(() => document.querySelector('#levelLabel').textContent === 'SILENT'); await page.click('#muteBtn');
    await page.click('#boardNav'); await page.waitForFunction(() => !document.querySelector('#boardView').hidden);
    checks.push(`Synthetic microphone passes through all ${presets.length} voice presets plus custom pitch and effect strength, and microphone mute silences the mix`);
    await page.click('#connectBtn'); assert.ok(await page.evaluate(() => window.testTracks.every(t => t.readyState === 'ended')));
    await page.selectOption('#micDevice', 'test-return'); await page.click('#connectBtn');
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('feed the mix back')); assert.equal(await page.locator('#statusPill.live').count(), 0);
    checks.push('Disconnect releases capture tracks; selecting the cable return as microphone is blocked');
    await page.selectOption('#micDevice', 'none'); await page.evaluate(() => { window.testSinkFailure = true; }); await page.click('#connectBtn');
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Output device is unavailable')); assert.equal(await page.locator('#statusPill.live').count(), 0);
    checks.push('An unavailable output fails closed without starting a broadcast');
    await page.selectOption('#monitorDevice', 'test-cable'); await page.click('#monitorToggle'); await page.waitForFunction(() => !document.querySelector('#monitorToggle').checked && document.querySelector('#toast').textContent.includes('physical headphones'));
    await page.selectOption('#monitorDevice', 'test-phones'); await page.check('#monitorToggle'); await page.waitForFunction(() => window.testMonitorSink === 'test-phones'); await page.check('#monitorVoice'); await page.uncheck('#monitorToggle');
    checks.push('Headphone monitoring chooses a separate output and rejects virtual-cable feedback routes');
    // "Hear myself" captures the microphone for headphone preview while the broadcast stays offline.
    await page.selectOption('#micDevice', 'test-mic'); await page.click('#voiceNav');
    await page.click('#hearBtn'); await page.waitForFunction(() => document.querySelector('#hearBtn').getAttribute('aria-pressed') === 'true' && document.querySelector('#sidebarStatusText').textContent === 'Previewing voice');
    assert.equal(await page.locator('#statusPill.live').count(), 0);
    await page.waitForFunction(() => document.querySelector('#micLevelLabel').textContent !== 'Mic off');
    await page.click('#hearBtn'); await page.waitForFunction(() => document.querySelector('#hearBtn').getAttribute('aria-pressed') === 'false' && !document.querySelector('#monitorToggle').checked);
    assert.ok(await page.evaluate(() => window.testTracks.every(t => t.readyState === 'ended')));
    await page.click('#boardNav'); await page.selectOption('#micDevice', 'none');
    checks.push('Voice preview captures the microphone for headphones only, never starts a broadcast, and releases the microphone when stopped');
    await page.evaluate(() => { window.testSinkFailure = false; }); await page.click('#connectBtn'); await page.waitForFunction(() => document.querySelector('#statusPill').classList.contains('live'));
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, badFile);
    await page.click('#importBtn'); await page.waitForFunction(() => document.querySelectorAll('.sound-pad').length === 7);
    await page.locator('.pad-main').last().click(); await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('could not be decoded'));
    await page.waitForFunction(() => document.querySelectorAll('.sound-pad.playing').length === 0);
    checks.push('Corrupt MP3 playback reports an actionable error and clears its playing state');
    await page.locator('.pad-edit').last().click(); await page.click('#padMenu [data-action=edit]'); await page.click('#deleteSound'); await page.click('#deleteSound'); await page.waitForFunction(() => document.querySelectorAll('.sound-pad').length === 6);
    // Replay buffer: rolling capture of system audio, saved on demand, trimmed, and added as a pad.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle() === 'PulseDeck').setSize(1024, 768));
    await page.click('#replayNav'); await page.check('#replayToggle');
    await page.waitForFunction(() => document.querySelector('#replayArm').classList.contains('armed') && !document.querySelector('#captureBtn').disabled);
    await page.waitForFunction(() => document.querySelector('#replayLevelLabel').textContent === 'Sound');
    // Wait on the audio clock: on a busy CI machine it can run slower than the wall clock.
    await page.evaluate(async () => { const ctx = window.__test.engine.context, start = ctx.currentTime; while (ctx.currentTime - start < 1.5) await new Promise(r => setTimeout(r, 50)); });
    await page.click('#captureBtn');
    await page.waitForFunction(() => document.querySelectorAll('.capture').length === 1 && !document.querySelector('#editor').hidden);
    const captureMeta = await page.locator('#captureMeta').textContent(); assert.match(captureMeta, /0:0[1-9]/, captureMeta);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle() === 'PulseDeck').webContents.send('shortcut', { type: 'capture' }));
    await page.waitForFunction(() => document.querySelectorAll('.capture').length === 2);
    await page.click('#overlayBtn'); await overlayPage.waitForFunction(() => !document.querySelector('#clipBtn').hidden && document.querySelector('#clipBtn').textContent.includes('60s'));
    await overlayPage.click('#clipBtn'); await page.waitForFunction(() => document.querySelectorAll('.capture').length === 3); await overlayPage.click('#hideBtn');
    await page.fill('#trimStart', '0.2'); await page.fill('#trimEnd', '0.9'); await page.waitForFunction(() => document.querySelector('#selectionMeta').textContent.includes('0:00.7'));
    await page.click('#previewBtn'); await page.waitForFunction(() => document.querySelector('#previewBtn').textContent.includes('Stop')); await page.click('#previewBtn');
    await page.fill('#captureName', 'Friend said wow'); await page.locator('#captureName').press('Tab');
    await until(page, async () => (await window.deck.getLibrary()).captures.some(c => c.name === 'Friend said wow'));
    await page.click('#addCaptureBtn'); await page.waitForFunction(() => document.querySelectorAll('.sound-pad').length === 7);
    const captured = await page.evaluate(async () => (await window.deck.getLibrary()).clips.at(-1));
    assert.equal(captured.name, 'Friend said wow'); assert.equal(captured.hotkey, 'Control+Alt+7');
    await page.click('#boardNav'); await page.locator('.pad-main').last().click(); await page.waitForFunction(() => document.querySelectorAll('.sound-pad')[6].classList.contains('playing'));
    await page.waitForFunction(() => document.querySelectorAll('.pad-meta')[6].textContent.includes('0:00'));
    await page.locator('.pad-main').last().click(); await page.waitForFunction(() => document.querySelectorAll('.sound-pad.playing').length === 0);
    await page.click('#replayNav'); await page.click('#deleteCapture'); await page.click('#deleteCapture'); await page.waitForFunction(() => document.querySelectorAll('.capture').length === 2 && document.querySelector('#editor').hidden);
    await page.uncheck('#replayToggle'); await page.waitForFunction(() => !document.querySelector('#replayArm').classList.contains('armed'));
    await page.screenshot({ path: path.join(results, 'replay.png') }); await page.click('#boardNav');
    checks.push('Replay buffer captures system audio into a rolling buffer, saves from the button, the Ctrl+Alt+R shortcut and the overlay, trims, previews, and adds the selection to the soundboard');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle() === 'PulseDeck').setSize(1280, 860));
    await page.evaluate(() => { window.testDevices = window.testDevices.filter(d => d.deviceId !== 'test-cable'); navigator.mediaDevices.dispatchEvent(new Event('devicechange')); });
    await page.waitForFunction(() => !document.querySelector('#statusPill').classList.contains('live'));
    checks.push('Removing the selected broadcast endpoint disconnects the mix instead of falling back');
    // Drag to reorder: positional shortcuts (Ctrl+Alt+1…9, 0) follow the pads.
    const keysBefore = await page.evaluate(() => [...document.querySelectorAll('.sound-pad')].map(p => p.querySelector('.pad-name').textContent + '=' + p.querySelector('.pad-key')?.textContent));
    await page.locator('.sound-pad').nth(3).dragTo(page.locator('.sound-pad').nth(0), { targetPosition: { x: 12, y: 20 } });
    await until(page, async () => (await window.deck.getLibrary()).clips[0].name === 'Drum roll');
    const order = await page.evaluate(async () => (await window.deck.getLibrary()).clips.map(c => c.name + '=' + c.hotkey));
    assert.deepEqual(order.slice(0, 4), ['Drum roll=Control+Alt+1', 'Air horn · test=Control+Alt+2', 'Good game=Control+Alt+3', 'Plot twist=Control+Alt+4'], JSON.stringify({ keysBefore, order }));
    assert.equal(await page.locator('.sound-pad').first().locator('.pad-key').textContent(), process.platform === 'darwin' ? 'Cmd+Option+1' : 'Ctrl+Alt+1');
    assert.ok(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered((process.platform === 'darwin' ? 'Command' : 'Control') + '+Alt+1')));
    await page.locator('.pad-edit').first().click({ force: true }); await page.click('#padMenu [data-action=edit]'); assert.ok(await page.locator('#editHotkey').isDisabled()); await page.click('#closeEdit');
    checks.push('Dragging a pad reorders the board and the Ctrl+Alt digit shortcuts follow the new positions');
    await page.evaluate(() => { document.querySelector('#toast').hidden = true; });
    await page.screenshot({ path: path.join(results, 'soundboard.png') });
    await page.click('#setupBtn'); await page.screenshot({ path: path.join(results, 'guide.png') }); await page.click('#closeGuide');
    await page.reload(); await page.waitForFunction(() => document.querySelectorAll('.sound-pad').length === 7);
    assert.equal(await page.locator('.pad-name').first().textContent(), 'Drum roll'); assert.equal(await page.locator('.pad-name').nth(1).textContent(), 'Air horn · test'); assert.equal(await page.locator('.capture').count(), 2);
    assert.equal(await page.locator('#statusPill.live').count(), 0);
    checks.push('Reload preserves sounds and edits, and does not automatically start broadcasting');
    if (process.platform === 'darwin') {
      const lifecycle = await app.evaluate(({ app, BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'PulseDeck');
        win.close();
        const kept = !win.isDestroyed() && !win.isVisible();
        app.emit('activate');
        const reopened = win.isVisible();
        win.hide();
        return { kept, reopened };
      });
      assert.deepEqual(lifecycle, { kept: true, reopened: true });
      checks.push('Mac close hides the window without destroying the audio engine, and Dock activation reopens it');
    }
    assert.deepEqual(errors, []);
    const report = { passed: checks.length, checks, rendererErrors: errors, hardware: 'External device selection and microphone PCM were simulated; actual MP3 decoding, mixing, DSP, capture lifecycle, persistence and UI ran in Electron. Automated launch used --no-sandbox because this execution environment prevents sandboxed Chromium subprocess startup; the shipping app keeps its sandbox enabled. Discord/OBS/game end-to-end audio requires the installed cable and live setup.' };
    await fs.writeFile(path.join(results, 'integration-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  } finally { await app.close(); }
}
main().catch(error => {
  console.error(error);
  // CI logs need a token to read; workflow annotations are public, so surface the failure there too.
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=integration.cjs failed::${String(error.stack || error).slice(0, 3500).replace(/%/g, '%25').replace(/\r?\n/g, '%0A')}`);
  process.exitCode = 1;
});
