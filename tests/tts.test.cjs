const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { TtsService, fakeProvider, windowsProvider, macProvider, visibleLength } = require('../tts.cjs');
const { parseWav } = require('../wav-header.cjs');

const base = path.join(__dirname, '..', 'test-results');
async function service(provider, options = {}) {
  await fs.mkdir(base, { recursive: true });
  const tempRoot = await fs.mkdtemp(path.join(base, 'tts-'));
  const tts = new TtsService({ tempRoot, provider, ...options }); await tts.init();
  return { tts, tempRoot };
}
const hostile = ['Say "quotes" and \'single\' ones', 'Emoji 🎮🔥 and 日本語 と Ελληνικά', 'Line one\nLine two\r\nLine three', '$(New-Item -ItemType File CANARY)', '`whoami` ; rm -rf / && echo pwned | calc', '<speak><audio src="x"/>xml</speak> &amp; <!-- -->', "'); Remove-Item -Recurse C:\\ #"];

test('input limits count non-whitespace characters; unknown voices and bad speeds are rejected', async () => {
  const { tts } = await service(fakeProvider({ wallMs: 5000 }));
  assert.equal(visibleLength(' a \n b '), 2);
  await assert.rejects(tts.synthesize({ text: '   \n ', voiceId: 'test-voice-en' }), /Type something/);
  await assert.rejects(tts.synthesize({ text: 'x'.repeat(2001), voiceId: 'test-voice-en' }), /2001 characters/);
  await assert.rejects(tts.synthesize({ text: 'hi', voiceId: 'No such voice' }), /no longer installed/);
  await assert.rejects(tts.synthesize({ text: 'hi', voiceId: 'test-voice-en', speed: 11 }), /speed/);
  await assert.rejects(tts.synthesize({ text: 'hi', voiceId: 'test-voice-en', speed: 1.5 }), /speed/);
  const ok = await tts.synthesize({ text: `${'word '.repeat(400)}`.trim(), voiceId: 'test-voice-en' });
  assert.ok(ok.duration > 1);
});

test('results are real WAV bytes, cached by voice, text, and speed, and invalidated by any change', async () => {
  const { tts, tempRoot } = await service(fakeProvider({ wallMs: 5000 }));
  const first = await tts.synthesize({ text: 'Hello team, the match starts now', voiceId: 'test-voice-en', speed: 0 });
  assert.equal(parseWav(first.bytes).sampleRate, 48000); assert.equal(first.cached, false);
  const again = await tts.synthesize({ text: 'Hello team, the match starts now', voiceId: 'test-voice-en', speed: 0 });
  assert.equal(again.cached, true); assert.equal(again.resultId, first.resultId);
  for (const change of [{ text: 'Hello team, the match starts now!' }, { speed: 4 }, { voiceId: 'test-voice-ja' }]) {
    const other = await tts.synthesize({ text: 'Hello team, the match starts now', voiceId: 'test-voice-en', speed: 0, ...change });
    assert.equal(other.cached, false); assert.notEqual(other.resultId, first.resultId);
  }
  assert.ok(tts.result(first.resultId).bytes.equals(first.bytes));
  assert.deepEqual(await fs.readdir(tempRoot), [], 'temporary files are removed');
  assert.throws(() => tts.result('00000000-0000-4000-8000-000000000000'), /no longer ready/);
});

test('zero-length output, hung helpers, and cancellation fail cleanly without leaking files or processes', async () => {
  const { tts, tempRoot } = await service(fakeProvider({ wallMs: 800 }), { wallMs: 800 });
  await assert.rejects(tts.synthesize({ text: 'nothing', voiceId: 'test-voice-empty' }), error => error.code === 'EMPTY');
  const started = Date.now();
  await assert.rejects(tts.synthesize({ text: 'forever', voiceId: 'test-voice-hang' }), error => error.code === 'TIMEOUT');
  assert.ok(Date.now() - started < 5000, 'the wall-time limit stops a hung helper');
  const pending = tts.synthesize({ requestId: 'r1', text: 'cancel me', voiceId: 'test-voice-hang' });
  setTimeout(() => tts.cancel('r1'), 100);
  await assert.rejects(pending, error => error.code === 'CANCELLED');
  const replaced = assert.rejects(tts.synthesize({ requestId: 'r2', text: 'old request', voiceId: 'test-voice-hang' }), error => error.code === 'CANCELLED', 'a replacement request cancels the old one');
  await new Promise(r => setTimeout(r, 50));
  const replacement = await tts.synthesize({ requestId: 'r3', text: 'new request', voiceId: 'test-voice-en' });
  await replaced;
  assert.ok(replacement.bytes.length > 44);
  assert.deepEqual(await fs.readdir(tempRoot), []);
});

test('a voice removed after it was listed is reported as no longer installed, not as a helper crash', async () => {
  const { TtsError } = require('../tts.cjs');
  let installed = true;
  const provider = { id: 'x', version: 'x-1', label: 'x', speed: { min: -10, max: 10, default: 0, step: 1 },
    async listVoices() { return installed ? [{ id: 'Gone', name: 'Gone', language: 'en-US', provider: 'x', available: true }] : []; },
    async synthesize() { installed = false; throw new TtsError('Exception calling "SelectVoice": Cannot set voice.', 'HELPER'); } };
  const { tts, tempRoot } = await service(provider);
  await assert.rejects(tts.synthesize({ text: 'hi', voiceId: 'Gone' }), error => error.code === 'VOICE' && /no longer installed/.test(error.message));
  assert.deepEqual(await fs.readdir(tempRoot), []);
});

test('an unavailable platform reports a clear unavailable state', async () => {
  const { tts } = await service(null);
  assert.equal(tts.info().available, false);
  assert.deepEqual(await tts.listVoices(), []);
  await assert.rejects(tts.synthesize({ text: 'hi', voiceId: 'x' }), /not available/);
});

// The real system provider for this OS. Skips only when the OS has no voices installed.
// Runs locally; CI runs tests/tts-real.cjs as a separate, non-blocking evidence step instead.
const real = process.platform === 'win32' ? windowsProvider : process.platform === 'darwin' ? macProvider : null;
const skipReal = !real ? 'no system speech provider on this platform' : process.env.CI && process.env.PULSEDECK_REAL_TTS !== '1' ? 'CI runners check real voices with tests/tts-real.cjs' : false;
test(`real ${process.platform} voices enumerate and synthesize hostile text as plain data`, { skip: skipReal }, async t => {
  const { tts, tempRoot } = await service(real({ wallMs: 60000 }));
  const voices = await tts.listVoices();
  if (!voices.some(v => v.available)) { t.skip('no installed voices'); return; }
  const voice = voices.find(v => v.available && /^en/i.test(v.language)) || voices.find(v => v.available);
  const hello = await tts.synthesize({ text: 'Hello team, the match starts now', voiceId: voice.id, speed: 0 });
  const info = parseWav(hello.bytes);
  assert.equal(info.bitsPerSample, 16); assert.ok(info.duration > 0.8 && info.duration < 8, `duration ${info.duration}`);
  const canary = path.join(tempRoot, '..', 'CANARY');
  await fs.rm(canary, { force: true });
  for (const text of hostile) {
    const result = await tts.synthesize({ text, voiceId: voice.id, speed: 2 });
    assert.ok(parseWav(result.bytes).frames > 0, text);
  }
  await assert.rejects(fs.access(canary), 'command-like text is never executed');
  await assert.rejects(fs.access(path.join(process.cwd(), 'CANARY')));
  await assert.rejects(tts.synthesize({ text: 'hi', voiceId: 'PulseDeck Missing Voice' }), /no longer installed/);
  assert.deepEqual(await fs.readdir(tempRoot), []);
});
