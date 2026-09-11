const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseWav } = require('./wav-header.cjs');
const EFFECT_IDS = new Set(require('./voice-presets.json').map(preset => preset.id));

/** Version 1 was the unversioned library. Version 2 adds regions, organization, playback modes, queue, and projects. */
const LIBRARY_SCHEMA = 2;
const LIMITS = Object.freeze({
  clips: 120, captures: 40, clipBytes: 30 * 1024 * 1024, captureBytes: 64 * 1024 * 1024,
  tags: 20, tagLength: 32, collections: 50, collectionName: 60, groups: 32, groupName: 40, queue: 100, projects: 100, maxFadeMs: 5000
});
const EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.webm']);
const COLORS = ['lime', 'purple', 'blue', 'orange', 'pink'];
const TRIGGER_MODES = ['toggle', 'restart', 'overlap'];
const SOURCE_KINDS = ['import', 'capture', 'recording', 'studio', 'tts'];
const DUCKING_DEFAULTS = Object.freeze({ enabled: false, threshold: -35, reduction: 12, attack: 20, hold: 150, release: 300 });
const DEFAULTS = {
  micId: '', outputId: '', monitorId: '', micVolume: 100, boardVolume: 100, monitorVolume: 50, effect: 'clean', voicePitch: 0, effectMix: 100,
  monitorVoice: false, autoLevel: true, overlay: null, replaySeconds: 60, replayMic: false, replayAuto: false,
  ducking: { ...DUCKING_DEFAULTS }, ttsVoice: '', ttsSpeed: 0, ttsVolume: 100
};
const MAX_CAPTURES = LIMITS.captures;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const isId = value => typeof value === 'string' && UUID.test(value);
const clamp = (n, low, high, fallback) => Number.isFinite(Number(n)) ? Math.max(low, Math.min(high, Number(n))) : fallback;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const round6 = value => Math.round(value * 1e6) / 1e6;
const text = (value, max, fallback = '') => typeof value === 'string' ? value.trim().slice(0, max) : fallback;
// The first ten pads always own Ctrl+Alt+1 … Ctrl+Alt+9, Ctrl+Alt+0, in display order.
const SLOT_KEYS = Array.from({ length: 10 }, (_, i) => `Control+Alt+${(i + 1) % 10}`);
const isSlotKey = key => SLOT_KEYS.includes(key);
function shortcut(value) {
  if (!value) return '';
  return /^(Control\+Alt|Control\+Shift|Alt\+Shift)\+([A-Z0-9]|F([1-9]|1[0-9]|2[0-4]))$/.test(value) ? value : '';
}

class SchemaError extends Error {}

/** Strict validation for a new playback region. `null` means the whole source. */
function validatePlayback(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('The playback region is invalid.');
  const start = value.startSeconds, end = value.endSeconds ?? null, fadeIn = value.fadeInMs ?? 0, fadeOut = value.fadeOutMs ?? 0;
  if (!finite(start) || start < 0 || start > 86400) throw new Error('The start time must be zero or later.');
  if (end !== null && (!finite(end) || end <= start || end > 86400)) throw new Error('The end time must be after the start time.');
  if (![fadeIn, fadeOut].every(n => finite(n) && n >= 0 && n <= LIMITS.maxFadeMs)) throw new Error('Fades must be between 0 and 5000 ms.');
  if (end !== null && (fadeIn + fadeOut) / 1000 > end - start + 1e-9) throw new Error('The fades are longer than the selected region.');
  if (start === 0 && end === null && fadeIn === 0 && fadeOut === 0) return null;
  return { startSeconds: round6(start), endSeconds: end === null ? null : round6(end), fadeInMs: round6(fadeIn), fadeOutMs: round6(fadeOut) };
}

function normalizeTags(value, strict) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) { if (strict) throw new Error('Tags must be a list.'); return []; }
  const seen = new Set(), tags = [];
  for (const raw of value.slice(0, strict ? 1000 : LIMITS.tags * 2)) {
    if (typeof raw !== 'string') { if (strict) throw new Error('Each tag must be text.'); continue; }
    const tag = raw.trim().replace(/\s+/g, ' ');
    if (!tag) continue;
    if (tag.length > LIMITS.tagLength) { if (strict) throw new Error('Tags can be at most 32 characters.'); continue; }
    if (seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase()); tags.push(tag);
  }
  if (tags.length > LIMITS.tags) { if (strict) throw new Error('A sound can have at most 20 tags.'); return tags.slice(0, LIMITS.tags); }
  return tags;
}

function normalizeSource(value) {
  const source = value && typeof value === 'object' ? value : {};
  const kind = SOURCE_KINDS.includes(source.kind) ? source.kind : 'import';
  const out = { kind, createdAt: clamp(source.createdAt, 0, 1e13, 0) };
  if (isId(source.projectId)) out.projectId = source.projectId;
  if (Number.isInteger(source.revision) && source.revision > 0) out.revision = source.revision;
  if (isId(source.captureId)) out.captureId = source.captureId;
  if (kind === 'tts') {
    out.voice = text(source.voice, 128); out.provider = text(source.provider, 32); out.text = text(source.text, 2000);
    out.language = text(source.language, 32);
  }
  return out;
}

/** Explicit clip record. Never spread renderer or file data into persisted clips. */
function normalizeClip(c, groups, warnings) {
  const clip = {
    id: c.id, file: c.file, name: text(String(c.name ?? ''), 80) || 'Sound',
    color: COLORS.includes(c.color) ? c.color : 'lime', volume: clamp(c.volume, 0, 150, 100), loop: Boolean(c.loop), hotkey: shortcut(c.hotkey),
    duration: clamp(c.duration, 0, 86400, 0),
    loudness: Number.isFinite(Number(c.loudness)) && c.loudness !== null ? clamp(c.loudness, -60, 0, null) : null,
    peak: Number.isFinite(c.peak) ? clamp(c.peak, 0, 1000, null) : null,
    analysisKey: text(c.analysisKey, 64),
    playback: null, favorite: Boolean(c.favorite), tags: normalizeTags(c.tags, false),
    triggerMode: TRIGGER_MODES.includes(c.triggerMode) ? c.triggerMode : 'toggle',
    exclusiveGroupId: groups.has(c.exclusiveGroupId) ? c.exclusiveGroupId : '',
    source: normalizeSource(c.source)
  };
  if (c.playback !== undefined && c.playback !== null) {
    try { clip.playback = validatePlayback(c.playback); }
    catch { warnings.push(`“${clip.name}” had an invalid playback region, so it now plays the whole sound.`); }
  }
  if (clip.loop && clip.triggerMode === 'overlap') clip.triggerMode = 'restart';
  return clip;
}

function normalizeDucking(value, base = DUCKING_DEFAULTS) {
  const d = value && typeof value === 'object' ? value : {};
  return {
    enabled: 'enabled' in d ? Boolean(d.enabled) : base.enabled,
    threshold: Math.round(clamp(d.threshold, -60, -10, base.threshold)),
    reduction: Math.round(clamp(d.reduction, 0, 24, base.reduction)),
    attack: Math.round(clamp(d.attack, 5, 200, base.attack)),
    hold: Math.round(clamp(d.hold, 0, 1000, base.hold)),
    release: Math.round(clamp(d.release, 50, 2000, base.release))
  };
}

class Library {
  constructor(root) {
    this.root = root;
    this.state = { schemaVersion: LIBRARY_SCHEMA, clips: [], captures: [], settings: structuredClone(DEFAULTS), collections: [], groups: [], queue: [], projects: [] };
    this.queue = Promise.resolve();
    this.lock = Promise.resolve();
    this.warnings = [];
  }
  get warning() { return this.warnings.join(' '); }
  set warning(value) { this.warnings = value ? [value] : []; }

  async init() {
    await fs.mkdir(path.join(this.root, 'clips'), { recursive: true });
    await fs.mkdir(path.join(this.root, 'captures'), { recursive: true });
    const file = path.join(this.root, 'library.json');
    let raw;
    try { raw = await fs.readFile(file, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') this.warning = 'The saved library could not be read. Your audio files have been kept.'; return this.snapshot(); }
    let saved;
    try {
      saved = JSON.parse(raw);
      if (!saved || typeof saved !== 'object' || !Array.isArray(saved.clips)) throw new Error('Invalid clip library');
    } catch {
      this.warning = 'The saved library could not be read. Your audio files have been kept.';
      await fs.copyFile(file, path.join(this.root, `library-recovery-${Date.now()}.json`)).catch(() => {});
      return this.snapshot();
    }
    const version = saved.schemaVersion === undefined ? 1 : saved.schemaVersion;
    if (!Number.isInteger(version) || version < 1) throw new SchemaError('The saved library has an unknown format. It was left unchanged.');
    if (version > LIBRARY_SCHEMA) throw new SchemaError(`This library was saved by a newer version of PulseDeck (format ${version}). Update PulseDeck to open it. The library was left unchanged.`);
    this.load(saved);
    if (version < LIBRARY_SCHEMA) {
      // Keep the exact pre-migration file before the first write in the new format.
      await fs.writeFile(path.join(this.root, `library-pre-migration-v${version}-${Date.now()}.json`), raw, { flag: 'wx' }).catch(() => {});
      await this.commit();
    }
    return this.snapshot();
  }

  load(saved) {
    const warnings = [];
    const groups = (Array.isArray(saved.groups) ? saved.groups : []).filter(g => isId(g?.id)).slice(0, LIMITS.groups)
      .map(g => ({ id: g.id, name: text(g.name, LIMITS.groupName) || 'Group' }));
    const groupIds = new Set(groups.map(g => g.id));
    const clips = [], clipIds = new Set();
    for (const c of saved.clips) {
      if (clips.length >= LIMITS.clips) break;
      if (!isId(c?.id) || clipIds.has(c.id) || typeof c.file !== 'string' || !new RegExp(`^${c.id}\\.(mp3|wav|ogg|m4a|flac|webm)$`).test(c.file) && !/^[a-f0-9-]{36}\.(mp3|wav|ogg|m4a|flac|webm)$/.test(c.file)) continue;
      clipIds.add(c.id); clips.push(normalizeClip(c, groupIds, warnings));
    }
    this.state.groups = groups;
    this.state.clips = clips;
    this.state.captures = (Array.isArray(saved.captures) ? saved.captures : []).filter(c => isId(c?.id) && /^[a-f0-9-]{36}\.wav$/.test(c.file)).slice(0, MAX_CAPTURES)
      .map(c => ({ id: c.id, file: c.file, name: String(c.name || 'Capture').slice(0, 80), duration: clamp(c.duration, 0, 600, 0), createdAt: clamp(c.createdAt, 0, 1e13, 0) }));
    this.state.collections = (Array.isArray(saved.collections) ? saved.collections : []).filter(c => isId(c?.id)).slice(0, LIMITS.collections)
      .map(c => ({ id: c.id, name: text(c.name, LIMITS.collectionName) || 'Collection', clipIds: [...new Set((Array.isArray(c.clipIds) ? c.clipIds : []).filter(id => clipIds.has(id)))] }));
    this.state.queue = (Array.isArray(saved.queue) ? saved.queue : []).filter(q => isId(q?.id) && isId(q.clipId)).slice(0, LIMITS.queue).map(q => ({ id: q.id, clipId: q.clipId }));
    this.state.projects = (Array.isArray(saved.projects) ? saved.projects : []).filter(p => isId(p?.id)).slice(0, LIMITS.projects)
      .map(p => ({ id: p.id, name: text(p.name, 80) || 'Untitled project', createdAt: clamp(p.createdAt, 0, 1e13, 0), updatedAt: clamp(p.updatedAt, 0, 1e13, 0), revision: Math.round(clamp(p.revision, 0, 1e9, 0)), saved: Boolean(p.saved) }));
    this.state.settings = structuredClone(DEFAULTS);
    this.updateSettings(saved.settings || {});
    if ('overlay' in (saved.settings || {})) this.updateSettings({ overlay: saved.settings.overlay });
    this.assignSlots();
    this.warnings.push(...warnings);
  }

  /** Positional shortcuts: pads 1-10 get Ctrl+Alt+1…9,0; a digit key on any later pad is cleared. */
  assignSlots() {
    this.state.clips.forEach((clip, index) => {
      if (index < SLOT_KEYS.length) clip.hotkey = SLOT_KEYS[index];
      else if (isSlotKey(clip.hotkey)) clip.hotkey = '';
    });
  }

  snapshot() { return structuredClone({ ...this.state, warning: this.warning || '', limits: LIMITS }); }

  /** Runs storage operations one at a time, so read-modify-write sequences never interleave. */
  exclusive(fn) {
    const run = this.lock.then(() => fn());
    this.lock = run.catch(() => {});
    return run;
  }

  /**
   * Applies a mutation and commits it. On failure the in-memory state returns to the last valid
   * version and only files created by this operation are removed.
   */
  mutate(fn) {
    return this.exclusive(async () => {
      const before = JSON.stringify(this.state);
      const created = [];
      try {
        const result = await fn(created);
        await this.commit();
        return result;
      } catch (error) {
        // Validation failures change nothing; keep object identity. Otherwise return to the last valid state.
        if (JSON.stringify(this.state) !== before) this.state = JSON.parse(before);
        for (const file of created) await fs.rm(file, { force: true, recursive: true }).catch(() => {});
        throw error;
      }
    });
  }

  updateSettings(patch) {
    if (!patch || typeof patch !== 'object') return;
    for (const key of ['micId', 'outputId', 'monitorId']) if (typeof patch[key] === 'string') this.state.settings[key] = patch[key].slice(0, 256);
    for (const key of ['micVolume', 'boardVolume', 'monitorVolume']) if (key in patch) this.state.settings[key] = clamp(patch[key], 0, key === 'monitorVolume' ? 100 : key === 'micVolume' ? 150 : 200, DEFAULTS[key]);
    if (EFFECT_IDS.has(patch.effect)) this.state.settings.effect = patch.effect;
    if ('voicePitch' in patch) this.state.settings.voicePitch = Math.round(clamp(patch.voicePitch, -12, 12, 0));
    if ('effectMix' in patch) this.state.settings.effectMix = clamp(patch.effectMix, 0, 100, 100);
    if ('monitorVoice' in patch) this.state.settings.monitorVoice = Boolean(patch.monitorVoice);
    if ('autoLevel' in patch) this.state.settings.autoLevel = Boolean(patch.autoLevel);
    if ('replaySeconds' in patch) this.state.settings.replaySeconds = Math.round(clamp(patch.replaySeconds, 15, 180, 60));
    if ('replayMic' in patch) this.state.settings.replayMic = Boolean(patch.replayMic);
    if ('replayAuto' in patch) this.state.settings.replayAuto = Boolean(patch.replayAuto);
    if ('ducking' in patch) this.state.settings.ducking = normalizeDucking(patch.ducking, this.state.settings.ducking || DUCKING_DEFAULTS);
    if (typeof patch.ttsVoice === 'string') this.state.settings.ttsVoice = patch.ttsVoice.slice(0, 256);
    if ('ttsSpeed' in patch) this.state.settings.ttsSpeed = Math.round(clamp(patch.ttsSpeed, -10, 10, 0));
    if ('ttsVolume' in patch) this.state.settings.ttsVolume = Math.round(clamp(patch.ttsVolume, 0, 150, 100));
    if ('overlay' in patch) {
      const o = patch.overlay;
      this.state.settings.overlay = o && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(Number(o[k])))
        ? { x: Math.round(o.x), y: Math.round(o.y), width: Math.round(clamp(o.width, 200, 2000, 340)), height: Math.round(clamp(o.height, 120, 2000, 420)), opacity: clamp(o.opacity, 0.3, 1, 0.92) }
        : null;
    }
  }

  commit() {
    const data = JSON.stringify({ ...this.state, schemaVersion: LIBRARY_SCHEMA }, null, 2);
    const write = this.queue.catch(() => {}).then(async () => {
      const temp = path.join(this.root, 'library.json.tmp');
      await fs.writeFile(temp, data, 'utf8');
      await fs.rename(temp, path.join(this.root, 'library.json'));
    });
    this.queue = write;
    return write;
  }

  clipPath(clip) { return path.join(this.root, 'clips', clip.file); }
  newClip(fields) {
    const id = fields.id || randomUUID();
    return {
      id, file: id + fields.ext, name: text(fields.name, 80) || 'Sound', color: COLORS.includes(fields.color) ? fields.color : COLORS[this.state.clips.length % COLORS.length],
      volume: clamp(fields.volume, 0, 150, 100), loop: false, hotkey: '', duration: clamp(fields.duration, 0, 86400, 0), loudness: null, peak: null, analysisKey: '',
      playback: fields.playback ?? null, favorite: false, tags: [], triggerMode: 'toggle', exclusiveGroupId: '', source: normalizeSource({ ...fields.source, createdAt: Date.now() })
    };
  }

  importFiles(paths) {
    if (!Array.isArray(paths)) return Promise.reject(new Error('Choose audio files to import.'));
    return this.mutate(async created => {
      const added = [], errors = [];
      for (const source of paths.slice(0, LIMITS.clips)) {
        try {
          if (this.state.clips.length >= LIMITS.clips) throw new Error('The library limit is 120 sounds.');
          if (typeof source !== 'string') throw new Error('Invalid file.');
          const ext = path.extname(source).toLowerCase();
          if (!EXTENSIONS.has(ext)) throw new Error('Use MP3, WAV, OGG, M4A, FLAC, or WebM.');
          const stat = await fs.stat(source);
          if (!stat.isFile() || stat.size === 0 || stat.size > LIMITS.clipBytes) throw new Error('Each file must be between 1 byte and 30 MB.');
          const clip = this.newClip({ ext, name: path.basename(source, ext), source: { kind: 'import' } });
          const target = this.clipPath(clip);
          await fs.copyFile(source, target); created.push(target);
          this.state.clips.push(clip); added.push(clip.id);
          this.assignSlots();
        } catch (e) { errors.push(`${typeof source === 'string' ? path.basename(source) : 'File'}: ${e.message}`); }
      }
      return { ...this.snapshot(), added, errors };
    });
  }

  /** Adds a pad from in-memory audio bytes (trimmed captures, recordings, Studio renders, speech). */
  importBuffer(name, bytes, ext = '.wav', options = {}) {
    return this.mutate(async created => {
      if (this.state.clips.length >= LIMITS.clips) throw new Error('The library limit is 120 sounds. Remove a sound first.');
      if (!EXTENSIONS.has(ext)) throw new Error('Unsupported audio format.');
      const data = Buffer.from(bytes);
      if (!data.length || data.length > LIMITS.clipBytes) throw new Error(`The sound must be between 1 byte and 30 MB. This one is ${(data.length / 1048576).toFixed(1)} MB; shorten the selection and try again.`);
      let duration = 0;
      if (ext === '.wav') { const info = parseWav(data); if (info.frames < 1) throw new Error('The recording contains no audio.'); duration = info.duration; }
      const clip = this.newClip({ ext, name: String(name || 'Capture'), color: options.color, volume: options.volume, duration, playback: validatePlayback(options.playback), source: options.source || { kind: 'capture' } });
      const target = this.clipPath(clip);
      await fs.writeFile(target, data, { flag: 'wx' }); created.push(target);
      this.state.clips.push(clip);
      this.assignSlots();
      return { ...this.snapshot(), added: [clip.id], errors: [] };
    });
  }

  /** Copies a whole replay capture onto the board with playback bounds, so the pad can be expanded later. */
  captureToPad(captureId, name, playback) {
    return this.mutate(async created => {
      const capture = this.state.captures.find(c => c.id === captureId);
      if (!capture) throw new Error('This capture is no longer available.');
      if (this.state.clips.length >= LIMITS.clips) throw new Error('The library limit is 120 sounds. Remove a sound first.');
      const region = validatePlayback(playback);
      const from = path.join(this.root, 'captures', capture.file);
      const stat = await fs.stat(from);
      if (stat.size > LIMITS.clipBytes) {
        const error = new Error(`The full capture is ${(stat.size / 1048576).toFixed(1)} MB, over the 30 MB pad limit. Use “Add trimmed copy” instead; a trimmed copy cannot be expanded later.`);
        error.code = 'TOO_LARGE'; throw error;
      }
      const clip = this.newClip({ ext: '.wav', name: text(name, 80) || capture.name, duration: capture.duration, playback: region, source: { kind: 'capture', captureId: capture.id } });
      const target = this.clipPath(clip);
      await fs.copyFile(from, target); created.push(target);
      this.state.clips.push(clip);
      this.assignSlots();
      return { ...this.snapshot(), added: [clip.id], errors: [] };
    });
  }

  addCapture(bytes, duration, name) {
    return this.mutate(async created => {
      const data = Buffer.from(bytes);
      if (!data.length || data.length > LIMITS.captureBytes) throw new Error('The capture is empty or too large.');
      parseWav(data);
      const id = randomUUID();
      const capture = { id, file: id + '.wav', name: String(name || '').trim().slice(0, 80) || `Capture ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, duration: clamp(duration, 0, 600, 0), createdAt: Date.now() };
      const target = path.join(this.root, 'captures', capture.file);
      await fs.writeFile(target, data); created.push(target);
      this.state.captures.unshift(capture);
      const dropped = this.state.captures.splice(MAX_CAPTURES);
      this.afterCommit = async () => { for (const old of dropped) await fs.unlink(path.join(this.root, 'captures', old.file)).catch(() => {}); };
      return { ...this.snapshot(), added: id };
    }).finally(() => this.runAfterCommit());
  }
  async runAfterCommit() { const task = this.afterCommit; this.afterCommit = null; if (task) await task(); }
  async readCapture(id) {
    const capture = this.state.captures.find(c => c.id === id);
    if (!capture) throw new Error('This capture is no longer available.');
    return fs.readFile(path.join(this.root, 'captures', capture.file));
  }
  renameCapture(id, name) {
    return this.mutate(async () => {
      const capture = this.state.captures.find(c => c.id === id);
      if (!capture) throw new Error('This capture is no longer available.');
      capture.name = String(name || '').trim().slice(0, 80) || capture.name;
      return this.snapshot();
    });
  }
  async removeCapture(id) {
    const capture = this.state.captures.find(c => c.id === id);
    if (!capture) return this.snapshot();
    const result = await this.mutate(async () => { this.state.captures = this.state.captures.filter(c => c.id !== id); return this.snapshot(); });
    await fs.unlink(path.join(this.root, 'captures', capture.file)).catch(() => {});
    return result;
  }

  async read(id) {
    const clip = this.state.clips.find(c => c.id === id);
    if (!clip) throw new Error('This sound is no longer in the library.');
    return fs.readFile(this.clipPath(clip));
  }

  reorder(ids) {
    return this.mutate(async () => {
      if (!Array.isArray(ids)) throw new Error('Invalid order.');
      const byId = new Map(this.state.clips.map(c => [c.id, c]));
      const ordered = ids.filter((id, i) => byId.has(id) && ids.indexOf(id) === i).map(id => byId.get(id));
      if (ordered.length !== this.state.clips.length) throw new Error('The sound list changed. Try again.');
      this.state.clips = ordered;
      this.assignSlots();
      return this.snapshot();
    });
  }

  edit(id, patch) {
    return this.mutate(async () => {
      const clip = this.state.clips.find(c => c.id === id);
      if (!clip) throw new Error('Sound not found.');
      if (!patch || typeof patch !== 'object') throw new Error('Invalid change.');
      if ('hotkey' in patch) {
        const hotkey = shortcut(patch.hotkey);
        if (patch.hotkey && !hotkey) throw new Error('Use Ctrl+Alt, Ctrl+Shift, or Alt+Shift with a letter, number, or function key.');
        if (hotkey === 'Control+Alt+M') throw new Error('Ctrl+Alt+M is reserved for microphone mute.');
        if (hotkey === 'Control+Alt+O') throw new Error('Ctrl+Alt+O is reserved for the game overlay.');
        if (hotkey === 'Control+Alt+R') throw new Error('Ctrl+Alt+R is reserved for saving replay clips.');
        if (hotkey === 'Control+Alt+Space') throw new Error('Ctrl+Alt+Space is reserved for stopping sounds.');
        const index = this.state.clips.indexOf(clip);
        if (isSlotKey(hotkey) && hotkey !== SLOT_KEYS[index]) throw new Error('Ctrl+Alt+0–9 follow pad order. Drag the pad into that position instead.');
        if (index < SLOT_KEYS.length && hotkey !== SLOT_KEYS[index]) throw new Error(`This pad is one of the first ten, so it keeps ${SLOT_KEYS[index].replace('Control', 'Ctrl')}. Drag it further down to give it a custom shortcut.`);
        if (hotkey && this.state.clips.some(c => c.id !== id && c.hotkey === hotkey)) throw new Error('That shortcut belongs to another sound.');
        clip.hotkey = hotkey;
      }
      const loop = 'loop' in patch ? Boolean(patch.loop) : clip.loop;
      const mode = 'triggerMode' in patch ? patch.triggerMode : clip.triggerMode;
      if (!TRIGGER_MODES.includes(mode)) throw new Error('Choose Toggle, Restart, or Overlap.');
      if (loop && mode === 'overlap') throw new Error('Looping sounds can use Toggle or Restart. Overlap would stack endless copies.');
      if ('exclusiveGroupId' in patch && patch.exclusiveGroupId !== '' && !this.state.groups.some(g => g.id === patch.exclusiveGroupId)) throw new Error('That exclusive group no longer exists.');
      const playback = 'playback' in patch ? validatePlayback(patch.playback) : clip.playback;
      const tags = 'tags' in patch ? normalizeTags(patch.tags, true) : clip.tags;
      if (typeof patch.name === 'string') clip.name = patch.name.trim().slice(0, 80) || clip.name;
      if (COLORS.includes(patch.color)) clip.color = patch.color;
      if ('volume' in patch) clip.volume = clamp(patch.volume, 0, 150, 100);
      clip.loop = loop; clip.triggerMode = mode; clip.tags = tags;
      if ('favorite' in patch) clip.favorite = Boolean(patch.favorite);
      if ('exclusiveGroupId' in patch) clip.exclusiveGroupId = patch.exclusiveGroupId;
      if ('playback' in patch && JSON.stringify(playback) !== JSON.stringify(clip.playback)) {
        clip.playback = playback;
        // Auto-level measures the played region; a new region needs a new measurement.
        clip.loudness = null; clip.peak = null; clip.analysisKey = '';
      }
      if ('duration' in patch) clip.duration = clamp(patch.duration, 0, 86400, 0);
      if ('analysisKey' in patch && typeof patch.analysisKey === 'string') clip.analysisKey = patch.analysisKey.slice(0, 64);
      if ('peak' in patch) clip.peak = Number.isFinite(patch.peak) ? clamp(patch.peak, 0, 1000, null) : null;
      if ('loudness' in patch) clip.loudness = Number.isFinite(Number(patch.loudness)) && patch.loudness !== null ? clamp(patch.loudness, -60, 0, null) : null;
      return this.snapshot();
    });
  }

  async remove(id) {
    const clip = this.state.clips.find(c => c.id === id);
    if (!clip) return this.snapshot();
    const result = await this.mutate(async () => {
      this.state.clips = this.state.clips.filter(c => c.id !== id);
      for (const collection of this.state.collections) collection.clipIds = collection.clipIds.filter(x => x !== id);
      this.assignSlots();
      return this.snapshot();
    });
    await fs.unlink(this.clipPath(clip)).catch(() => {});
    return result;
  }

  /* ─── Collections: ordered references to clips; audio is never duplicated. ─── */
  createCollection(name, clipIds = []) {
    return this.mutate(async () => {
      if (this.state.collections.length >= LIMITS.collections) throw new Error('You can have at most 50 collections.');
      const clean = text(name, 1000);
      if (!clean) throw new Error('Name the collection.');
      if (clean.length > LIMITS.collectionName) throw new Error('Collection names can be at most 60 characters.');
      const known = new Set(this.state.clips.map(c => c.id));
      const collection = { id: randomUUID(), name: clean, clipIds: [...new Set((Array.isArray(clipIds) ? clipIds : []).filter(id => known.has(id)))] };
      this.state.collections.push(collection);
      return { ...this.snapshot(), created: collection.id };
    });
  }
  renameCollection(id, name) {
    return this.mutate(async () => {
      const collection = this.state.collections.find(c => c.id === id);
      if (!collection) throw new Error('That collection no longer exists.');
      const clean = text(name, 1000);
      if (!clean) throw new Error('Name the collection.');
      if (clean.length > LIMITS.collectionName) throw new Error('Collection names can be at most 60 characters.');
      collection.name = clean;
      return this.snapshot();
    });
  }
  deleteCollection(id) {
    return this.mutate(async () => { this.state.collections = this.state.collections.filter(c => c.id !== id); return this.snapshot(); });
  }
  /** Adds (or with `remove`, removes) clips; reordering replaces the whole list and must match its members. */
  addToCollection(id, clipIds) {
    return this.mutate(async () => {
      const collection = this.state.collections.find(c => c.id === id);
      if (!collection) throw new Error('That collection no longer exists.');
      if (!Array.isArray(clipIds)) throw new Error('Choose sounds to add.');
      const known = new Set(this.state.clips.map(c => c.id));
      for (const clipId of clipIds) if (known.has(clipId) && !collection.clipIds.includes(clipId)) collection.clipIds.push(clipId);
      return this.snapshot();
    });
  }
  removeFromCollection(id, clipIds) {
    return this.mutate(async () => {
      const collection = this.state.collections.find(c => c.id === id);
      if (!collection) throw new Error('That collection no longer exists.');
      const drop = new Set(Array.isArray(clipIds) ? clipIds : []);
      collection.clipIds = collection.clipIds.filter(x => !drop.has(x));
      return this.snapshot();
    });
  }
  reorderCollection(id, clipIds) {
    return this.mutate(async () => {
      const collection = this.state.collections.find(c => c.id === id);
      if (!collection) throw new Error('That collection no longer exists.');
      if (!Array.isArray(clipIds) || clipIds.length !== collection.clipIds.length || new Set(clipIds).size !== clipIds.length || !clipIds.every(x => collection.clipIds.includes(x))) throw new Error('The collection changed. Try again.');
      collection.clipIds = [...clipIds];
      return this.snapshot();
    });
  }

  /* ─── Exclusive groups ─── */
  createGroup(name) {
    return this.mutate(async () => {
      if (this.state.groups.length >= LIMITS.groups) throw new Error('You can have at most 32 exclusive groups.');
      const clean = text(name, 1000);
      if (!clean) throw new Error('Name the group.');
      if (clean.length > LIMITS.groupName) throw new Error('Group names can be at most 40 characters.');
      const group = { id: randomUUID(), name: clean };
      this.state.groups.push(group);
      return { ...this.snapshot(), created: group.id };
    });
  }
  renameGroup(id, name) {
    return this.mutate(async () => {
      const group = this.state.groups.find(g => g.id === id);
      if (!group) throw new Error('That group no longer exists.');
      const clean = text(name, 1000);
      if (!clean || clean.length > LIMITS.groupName) throw new Error('Group names must be 1–40 characters.');
      group.name = clean;
      return this.snapshot();
    });
  }
  deleteGroup(id) {
    return this.mutate(async () => {
      this.state.groups = this.state.groups.filter(g => g.id !== id);
      for (const clip of this.state.clips) if (clip.exclusiveGroupId === id) clip.exclusiveGroupId = '';
      return this.snapshot();
    });
  }

  /* ─── Queue: pending clip references only. Playback state is never restored. ─── */
  setQueue(entries) {
    return this.mutate(async () => {
      if (!Array.isArray(entries)) throw new Error('Invalid queue.');
      if (entries.length > LIMITS.queue) throw new Error('The queue holds at most 100 sounds.');
      const seen = new Set();
      this.state.queue = entries.map(entry => {
        if (!isId(entry?.id) || !isId(entry.clipId) || seen.has(entry.id)) throw new Error('Invalid queue entry.');
        seen.add(entry.id);
        return { id: entry.id, clipId: entry.clipId };
      });
      return this.snapshot();
    });
  }
}
module.exports = { Library, DEFAULTS, DUCKING_DEFAULTS, LIMITS, LIBRARY_SCHEMA, SchemaError, shortcut, SLOT_KEYS, validatePlayback, normalizeTags, isId, COLORS };
