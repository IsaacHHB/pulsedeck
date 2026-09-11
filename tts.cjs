const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseWav } = require('./wav-header.cjs');

/**
 * Local text to speech through installed system voices. No network requests, keys, or downloads.
 * Providers return real WAV bytes so speech can be routed, saved, and composed like any other audio.
 * Text and voice names travel as data (base64 JSON on stdin or a plain stdin stream); they are never
 * interpolated into commands, scripts, paths, or SSML.
 */
const LIMITS = Object.freeze({ textChars: 2000, rawChars: 6000, wallMs: 60000, outputSeconds: 180, outputBytes: 30 * 1024 * 1024, cacheBytes: 64 * 1024 * 1024, cacheEntries: 8 });
const SPEED = Object.freeze({ min: -10, max: 10, default: 0, step: 1, presets: { slow: -4, normal: 0, fast: 4 } });
const b64 = text => Buffer.from(String(text), 'utf8').toString('base64');
const unb64 = text => Buffer.from(String(text || ''), 'base64').toString('utf8');

class TtsError extends Error { constructor(message, code) { super(message); this.code = code; } }

/* ─── Windows: System.Speech (SAPI) through Windows PowerShell with a fixed, bundled script ─── */
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$raw = [Console]::In.ReadToEnd()
$req = $raw | ConvertFrom-Json
function Dec([string]$b) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)) }
function Enc([string]$s) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)) }
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  if ($req.op -eq 'voices') {
    $list = @($synth.GetInstalledVoices() | ForEach-Object { @{ name = (Enc $_.VoiceInfo.Name); culture = $_.VoiceInfo.Culture.Name; enabled = [bool]$_.Enabled } })
    [Console]::Out.Write((@{ ok = $true; voices = $list } | ConvertTo-Json -Depth 4 -Compress))
  } else {
    $synth.SelectVoice((Dec $req.voice))
    $synth.Rate = [int]$req.rate
    $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo 48000, ([System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen), ([System.Speech.AudioFormat.AudioChannel]::Mono)
    $synth.SetOutputToWaveFile((Dec $req.out), $format)
    $synth.Speak((Dec $req.text))
    $synth.SetOutputToNull()
    [Console]::Out.Write((@{ ok = $true } | ConvertTo-Json -Compress))
  }
} catch {
  [Console]::Out.Write((@{ ok = $false; error = (Enc $_.Exception.Message) } | ConvertTo-Json -Compress))
} finally { $synth.Dispose() }
`;

function runHelper(file, args, input, { signal, wallMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value); };
    const kill = () => { try { child.kill(); } catch { /* already exited */ } };
    const abort = () => { kill(); finish(reject, new TtsError('Speech generation was cancelled.', 'CANCELLED')); };
    const timer = setTimeout(() => { kill(); finish(reject, new TtsError('Speech generation took longer than 60 seconds and was stopped. Try shorter text.', 'TIMEOUT')); }, wallMs);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort);
    child.stdout.on('data', data => { out += data; if (out.length > 1e6) kill(); });
    child.stderr.on('data', data => { err += data; if (err.length > 1e5) kill(); });
    child.on('error', error => finish(reject, new TtsError(`The speech helper could not start (${error.message}).`, 'HELPER')));
    child.on('close', code => finish(resolve, { code, out, err }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function windowsProvider({ wallMs }) {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64')];
  const call = async (request, signal) => {
    const result = await runHelper(exe, args, JSON.stringify(request), { signal, wallMs });
    let json;
    try { json = JSON.parse(result.out); } catch { throw new TtsError('The Windows speech helper returned an unreadable reply.', 'HELPER'); }
    if (!json.ok) throw new TtsError(unb64(json.error) || 'Windows speech failed.', 'HELPER');
    return json;
  };
  return {
    id: 'windows-sapi', version: 'windows-sapi-1', label: 'Windows installed voices (SAPI)', speed: SPEED,
    async listVoices() {
      const json = await call({ op: 'voices' });
      return (json.voices || []).map(v => { const name = unb64(v.name); return { id: name, name, language: String(v.culture || ''), provider: 'windows-sapi', available: Boolean(v.enabled) }; });
    },
    async synthesize({ text, voice, speed, out, signal }) {
      await call({ op: 'speak', voice: b64(voice.id), text: b64(text), rate: Math.round(speed), out: b64(out) }, signal);
    }
  };
}

/* ─── macOS: the system say command, rendering WAV to a file; text arrives on stdin ─── */
function macProvider({ wallMs }) {
  const exe = '/usr/bin/say';
  return {
    id: 'macos-say', version: 'macos-say-1', label: 'macOS installed voices', speed: SPEED,
    async listVoices() {
      const result = await runHelper(exe, ['-v', '?'], '', { wallMs: 15000 });
      if (result.code !== 0) throw new TtsError('macOS did not list its voices.', 'HELPER');
      return result.out.split('\n').map(line => /^(.+?)\s+([a-z]{2,3}[_-][A-Za-z0-9_-]+)\s+#/.exec(line)).filter(Boolean)
        .map(([, name, locale]) => ({ id: name.trim(), name: name.trim(), language: locale.replace('_', '-'), provider: 'macos-say', available: true }));
    },
    async synthesize({ text, voice, speed, out, signal }) {
      // Words per minute: 175 is macOS's normal pace; each step is about 7%.
      const rate = Math.round(Math.max(90, Math.min(400, 175 * 1.07 ** speed)));
      const result = await runHelper(exe, ['-v', voice.id, '-r', String(rate), '--file-format=WAVE', '--data-format=LEI16@48000', '-o', out], text, { signal, wallMs });
      if (result.code !== 0) throw new TtsError(`macOS speech failed${result.err ? ` (${result.err.trim().slice(0, 160)})` : ''}.`, 'HELPER');
    }
  };
}

/* ─── Deterministic provider for automated tests only (PULSEDECK_TEST). Not evidence for a real platform. ─── */
function fakeProvider({ wallMs }) {
  const voices = [
    { id: 'test-voice-en', name: 'Test Voice', language: 'en-US' },
    { id: 'test-voice-ja', name: 'Test Voice (Japanese)', language: 'ja-JP' },
    { id: 'test-voice-hang', name: 'Test Voice (never finishes)', language: 'en-US' },
    { id: 'test-voice-empty', name: 'Test Voice (no audio)', language: 'en-US' }
  ];
  return {
    id: 'test', version: 'test-1', label: 'Test voices (automated tests only)', speed: SPEED,
    async listVoices() { return voices.map(v => ({ ...v, provider: 'test', available: true })); },
    async synthesize({ text, voice, speed, out, signal }) {
      if (voice.id === 'test-voice-hang') {
        // A real child process that never exits, so timeouts and cancellation are exercised for real.
        await runHelper(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], '', { signal, wallMs });
        return;
      }
      const chars = text.replace(/\s/g, '').length;
      const seconds = voice.id === 'test-voice-empty' ? 0 : Math.min(20, (0.3 + chars * 0.045) / (1.07 ** speed));
      const frames = Math.round(seconds * 48000), data = Buffer.alloc(44 + frames * 2);
      data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
      data.writeUInt32LE(48000, 24); data.writeUInt32LE(96000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(frames * 2, 40);
      const hz = voice.id === 'test-voice-ja' ? 420 : 300;
      for (let i = 0; i < frames; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * i / 48000) * 0.3 * 32767 * Math.min(1, i / 480, (frames - i) / 480)), 44 + i * 2);
      await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 120); signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new TtsError('Speech generation was cancelled.', 'CANCELLED')); }); });
      await fs.writeFile(out, data);
    }
  };
}

function chooseProvider(options) {
  const forced = process.env.PULSEDECK_TTS;
  if (forced === 'fake' || (process.env.PULSEDECK_TEST === '1' && forced !== 'system')) return fakeProvider(options);
  if (process.platform === 'win32') return windowsProvider(options);
  if (process.platform === 'darwin') return macProvider(options);
  return null;
}

/** Counts characters that are not whitespace (the text limit ignores spacing and line breaks). */
const visibleLength = text => text.replace(/\s/g, '').length;

class TtsService {
  constructor({ tempRoot, provider, wallMs = LIMITS.wallMs } = {}) {
    this.tempRoot = tempRoot;
    this.wallMs = wallMs;
    this.provider = provider === undefined ? chooseProvider({ wallMs }) : provider;
    this.cache = new Map();          // key → { resultId, bytes, meta }
    this.results = new Map();        // resultId → key
    this.active = null;
    this.voiceList = null;
  }

  async init() {
    await fs.rm(this.tempRoot, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(this.tempRoot, { recursive: true });
  }

  info() {
    if (!this.provider) return { available: false, provider: null, label: 'Text to speech is not available on this system.', speed: SPEED };
    return { available: true, provider: this.provider.id, label: this.provider.label, speed: this.provider.speed };
  }

  async listVoices({ refresh = false } = {}) {
    if (!this.provider) return [];
    if (!refresh && this.voiceList && Date.now() - this.voiceList.at < 30000) return this.voiceList.voices;
    const voices = (await this.provider.listVoices()).slice(0, 200);
    this.voiceList = { at: Date.now(), voices };
    return voices;
  }

  validate({ text, voiceId, speed }) {
    if (typeof text !== 'string') throw new TtsError('Type something to speak.', 'INPUT');
    if (text.length > LIMITS.rawChars) throw new TtsError('The text is too long. Keep it under 2000 characters.', 'INPUT');
    const count = visibleLength(text);
    if (!count) throw new TtsError('Type something to speak.', 'INPUT');
    if (count > LIMITS.textChars) throw new TtsError(`The text has ${count} characters. The limit is 2000 (not counting spaces).`, 'INPUT');
    if (typeof voiceId !== 'string' || !voiceId) throw new TtsError('Choose a voice.', 'VOICE');
    const bounds = this.provider.speed;
    if (!Number.isInteger(speed) || speed < bounds.min || speed > bounds.max) throw new TtsError('Choose a speed between slow and fast.', 'INPUT');
  }

  /**
   * Generates speech. Only one job runs; a new request cancels the previous one. Results are cached by
   * provider version, voice, exact text, and speed, within a 64 MB budget.
   */
  async synthesize({ requestId, text, voiceId, speed = 0 }) {
    if (!this.provider) throw new TtsError('Text to speech is not available on this system.', 'UNAVAILABLE');
    this.validate({ text, voiceId, speed });
    const voices = await this.listVoices();
    const voice = voices.find(v => v.id === voiceId);
    if (!voice) throw new TtsError('That voice is no longer installed. Choose another voice; the text is kept.', 'VOICE');
    if (!voice.available) throw new TtsError(`“${voice.name}” is installed but turned off in system settings. Choose another voice.`, 'VOICE');
    const key = crypto.createHash('sha256').update([this.provider.version, voiceId, speed, text].join('\u0000')).digest('hex');
    const hit = this.cache.get(key);
    if (hit) { this.cache.delete(key); this.cache.set(key, hit); return { ...hit.meta, resultId: hit.resultId, bytes: hit.bytes, cached: true }; }
    if (this.active) this.cancel(this.active.requestId);
    const controller = new AbortController();
    const job = { requestId: String(requestId || crypto.randomUUID()), controller };
    this.active = job;
    const out = path.join(this.tempRoot, `${crypto.randomUUID()}.wav`);
    try {
      try { await this.provider.synthesize({ text, voice, speed, out, signal: controller.signal }); }
      catch (error) {
        // A voice removed after it was listed shows up as a helper failure; report it plainly.
        if (error.code === 'HELPER' && !controller.signal.aborted) {
          const fresh = await this.listVoices({ refresh: true }).catch(() => null);
          if (fresh && !fresh.some(v => v.id === voiceId && v.available)) throw new TtsError('That voice is no longer installed. Choose another voice; the text is kept.', 'VOICE');
        }
        throw error;
      }
      if (controller.signal.aborted) throw new TtsError('Speech generation was cancelled.', 'CANCELLED');
      let stat;
      try { stat = await fs.stat(out); } catch { throw new TtsError('The voice produced no audio. Try another voice or different text.', 'EMPTY'); }
      if (!stat.size) throw new TtsError('The voice produced no audio. Try another voice or different text.', 'EMPTY');
      if (stat.size > LIMITS.outputBytes) throw new TtsError('The speech is longer than 30 MB. Use shorter text.', 'TOO_LONG');
      const bytes = await fs.readFile(out);
      let info;
      try { info = parseWav(bytes); } catch { throw new TtsError('The voice produced unreadable audio.', 'EMPTY'); }
      if (info.frames < 1) throw new TtsError('The voice produced no audio. Try another voice or different text.', 'EMPTY');
      if (info.duration > LIMITS.outputSeconds) throw new TtsError('The speech is longer than 3 minutes. Use shorter text.', 'TOO_LONG');
      const meta = { provider: this.provider.id, providerLabel: this.provider.label, voice: { id: voice.id, name: voice.name, language: voice.language }, speed, duration: info.duration, textLength: text.length };
      const resultId = crypto.randomUUID();
      this.remember(key, { resultId, bytes, meta, text });
      return { ...meta, resultId, bytes, cached: false };
    } finally {
      if (this.active === job) this.active = null;
      await fs.rm(out, { force: true }).catch(() => {});
    }
  }

  remember(key, entry) {
    this.cache.set(key, entry); this.results.set(entry.resultId, key);
    let total = [...this.cache.values()].reduce((sum, e) => sum + e.bytes.length, 0);
    for (const [k, e] of this.cache) {
      if (total <= LIMITS.cacheBytes && this.cache.size <= LIMITS.cacheEntries) break;
      this.cache.delete(k); this.results.delete(e.resultId); total -= e.bytes.length;
    }
  }

  /** A generated result by id, for saving without sending the audio back across IPC. */
  result(resultId) {
    const key = this.results.get(resultId);
    const entry = key && this.cache.get(key);
    if (!entry) throw new TtsError('That speech is no longer ready. Generate it again.', 'EXPIRED');
    return entry;
  }

  cancel(requestId) {
    if (this.active && (!requestId || this.active.requestId === String(requestId))) { this.active.controller.abort(); this.active = null; return true; }
    return false;
  }
}

module.exports = { TtsService, TtsError, TTS_LIMITS: LIMITS, TTS_SPEED: SPEED, windowsProvider, macProvider, fakeProvider, visibleLength };
