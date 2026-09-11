/**
 * Real-machine speech check. Runs the system provider for this OS (Windows SAPI or macOS say),
 * records what happened in test-results/tts-real-report.json, and exits non-zero on a failure.
 * Platforms without a provider report "unavailable" and exit 0.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { TtsService, windowsProvider, macProvider } = require('../tts.cjs');
const { parseWav } = require('../wav-header.cjs');

async function main() {
  const results = path.join(__dirname, '..', 'test-results');
  await fs.mkdir(results, { recursive: true });
  const report = { platform: process.platform, release: os.release(), arch: process.arch, at: new Date().toISOString(), checks: [] };
  const make = process.platform === 'win32' ? windowsProvider : process.platform === 'darwin' ? macProvider : null;
  if (!make) { report.status = 'unavailable'; await fs.writeFile(path.join(results, 'tts-real-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); return; }
  const tts = new TtsService({ tempRoot: await fs.mkdtemp(path.join(results, 'tts-real-')), provider: make({ wallMs: 60000 }) });
  await tts.init();
  let started = Date.now();
  const voices = await tts.listVoices();
  report.voices = voices.map(v => `${v.name} (${v.language})${v.available ? '' : ' [disabled]'}`);
  report.checks.push({ step: 'list voices', ms: Date.now() - started, count: voices.length });
  const voice = voices.find(v => v.available && /^en/i.test(v.language)) || voices.find(v => v.available);
  if (!voice) throw new Error('No enabled system voices were found.');
  for (const [label, text, speed] of [['phrase', 'Hello team, the match starts now', 0], ['slow', 'Hello team, the match starts now', -4], ['fast', 'Hello team, the match starts now', 4], ['unicode', 'Quotes "yes", emoji 🎮, 日本語, and\nnew lines', 0], ['command-like', '$(calc) `whoami` <speak>tag</speak>', 0]]) {
    started = Date.now();
    const result = await tts.synthesize({ text, voiceId: voice.id, speed });
    const info = parseWav(result.bytes);
    report.checks.push({ step: label, voice: voice.name, speed, ms: Date.now() - started, seconds: Number(info.duration.toFixed(3)), sampleRate: info.sampleRate, channels: info.channels, bits: info.bitsPerSample, bytes: result.bytes.length });
    if (info.frames < 1) throw new Error(`${label}: no audio`);
  }
  const [slow, , fast] = report.checks.filter(c => ['slow', 'phrase', 'fast'].includes(c.step)).sort((a, b) => a.speed - b.speed);
  report.speedOrdering = slow.seconds > fast.seconds ? 'slow is longer than fast' : 'UNEXPECTED: speed did not change duration';
  if (slow.seconds <= fast.seconds) throw new Error(report.speedOrdering);
  const pending = tts.synthesize({ requestId: 'cancel-check', text: 'This sentence is long enough that it will still be generating when it is cancelled. '.repeat(20), voiceId: voice.id, speed: -8 });
  setTimeout(() => tts.cancel('cancel-check'), 150);
  try { await pending; report.checks.push({ step: 'cancel', result: 'finished before cancel arrived' }); }
  catch (error) { report.checks.push({ step: 'cancel', result: error.code }); if (error.code !== 'CANCELLED') throw error; }
  try { await tts.synthesize({ text: 'hi', voiceId: 'PulseDeck Missing Voice' }); throw new Error('missing voice was accepted'); }
  catch (error) { report.checks.push({ step: 'missing voice', result: error.message }); }
  report.status = 'passed';
  await fs.writeFile(path.join(results, 'tts-real-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch(async error => { console.error(error); process.exitCode = 1; });
