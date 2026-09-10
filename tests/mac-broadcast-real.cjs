// Opt-in hardware test. BlackHole 2ch must be installed. Sends generated test tones to it.
const { _electron } = require('playwright');
const fs = require('node:fs/promises'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict');
(async () => {
  const root = path.resolve(__dirname, '..'), results = path.join(root, 'test-results');
  await fs.mkdir(results, { recursive: true });
  const data = await fs.mkdtemp(path.join(results, 'broadcast-real-'));
  const scope = {}; vm.runInNewContext(await fs.readFile(require.resolve('lamejs/lame.all.js'), 'utf8'), scope);
  const files = [];
  for (const rate of [44100, 48000]) {
    const pcm = Int16Array.from({ length: rate * 2 }, (_, i) => Math.round(Math.sin(2 * Math.PI * 997 * i / rate) * 6000));
    const encoder = new scope.lamejs.Mp3Encoder(1, rate, 128);
    const file = path.join(data, `tone-${rate}.mp3`);
    await fs.writeFile(file, Buffer.concat([Buffer.from(encoder.encodeBuffer(pcm)), Buffer.from(encoder.flush())])); files.push(file);
  }
  const env = { ...process.env, PULSEDECK_HEADLESS: '1', PULSEDECK_NO_UPDATES: '1', PULSEDECK_DATA: path.join(data, 'library') };
  delete env.PULSEDECK_TEST; delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.PULSEDECK_EXE || path.join(root, 'dist/mac-arm64/PulseDeck.app/Contents/MacOS/PulseDeck');
  const app = await _electron.launch({ executablePath, env });
  try {
    const page = await app.firstWindow(); await page.waitForFunction(() => Boolean(window.deck));
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, files);
    await page.click('#importBtn'); await page.waitForFunction(() => document.querySelectorAll('.sound-pad').length === 2);
    const report = await page.evaluate(async () => {
      const { AudioEngine } = await import('./audio.js');
      const devices = await navigator.mediaDevices.enumerateDevices();
      const output = devices.find(d => d.kind === 'audiooutput' && /BlackHole 2ch/.test(d.label));
      const input = devices.find(d => d.kind === 'audioinput' && /BlackHole 2ch/.test(d.label));
      if (!input || !output) throw new Error('Install BlackHole 2ch before this test.');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: input.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
      const capture = new AudioContext({ sampleRate: 48000, sinkId: { type: 'none' } });
      await capture.audioWorklet.addModule('./replay-worklet.js');
      const node = new AudioWorkletNode(capture, 'ring-recorder', { processorOptions: { capacity: 48000 * 4 } });
      const source = capture.createMediaStreamSource(stream), silent = capture.createGain(); silent.gain.value = 0;
      source.connect(node); node.connect(silent); silent.connect(capture.destination); await capture.resume();
      const engine = new AudioEngine(), results = [];
      try {
        await engine.connect({ outputId: output.deviceId, micId: 'none', boardVolume: 100, autoLevel: true });
        for (const clip of (await window.deck.getLibrary()).clips) {
          node.port.postMessage({ type: 'clear' });
          await new Promise(r => setTimeout(r,400));
          await engine.play(clip); await new Promise(r => setTimeout(r,2600));
          const { samples, sampleRate } = await new Promise(resolve => { node.port.onmessage = e => resolve(e.data); node.port.postMessage({ type: 'dump', seconds: 4, token: 1 }); });
          let peak = 0; for (const n of samples) peak = Math.max(peak, Math.abs(n));
          let first = 0, last = samples.length - 1;
          while (first < last && Math.abs(samples[first]) < peak * 0.05) first++;
          while (last > first && Math.abs(samples[last]) < peak * 0.05) last--;
          const a = first + Math.round(sampleRate * 0.2), b = last - Math.round(sampleRate * 0.2);
          let crosses = 0; for (let i = a + 1; i < b; i++) if (samples[i - 1] < 0 && samples[i] >= 0) crosses++;
          results.push({ clip: clip.name, receivedFrequency: crosses / ((b - a) / sampleRate), receivedDuration: (last - first + 1) / sampleRate, peak, sampleRate, decodedSampleRate: engine.buffers.get(clip.id).sampleRate });
        }
      } finally { engine.disconnect(); await engine.context?.close(); stream.getTracks().forEach(t => t.stop()); await capture.close(); }
      return results;
    });
    console.log(JSON.stringify(report, null, 2));
    for (const r of report) {
      assert.ok(Math.abs(r.receivedFrequency - 997) < 2, JSON.stringify(r));
      assert.ok(Math.abs(r.receivedDuration - 2) < 0.04, JSON.stringify(r));
      assert.ok(r.peak > 0.01 && r.peak <= 0.9, JSON.stringify(r));
    }
    await fs.writeFile(path.join(results, 'mac-broadcast-report.json'), JSON.stringify(report, null, 2));
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
