const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const EFFECT_IDS = new Set(require('./voice-presets.json').map(preset => preset.id));

const EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.webm']);
const COLORS = ['lime', 'purple', 'blue', 'orange', 'pink'];
const DEFAULTS = { micId: '', outputId: '', monitorId: '', micVolume: 100, boardVolume: 100, monitorVolume: 50, effect: 'clean', voicePitch: 0, effectMix: 100, monitorVoice: false, autoLevel: true, overlay: null, replaySeconds: 60, replayMic: false, replayAuto: false };
const MAX_CAPTURES = 40;
const clamp = (n, low, high, fallback) => Number.isFinite(Number(n)) ? Math.max(low, Math.min(high, Number(n))) : fallback;
// The first ten pads always own Ctrl+Alt+1 … Ctrl+Alt+9, Ctrl+Alt+0, in display order.
const SLOT_KEYS = Array.from({ length: 10 }, (_, i) => `Control+Alt+${(i + 1) % 10}`);
const isSlotKey = key => SLOT_KEYS.includes(key);
function shortcut(value) {
  if (!value) return '';
  return /^(Control\+Alt|Control\+Shift|Alt\+Shift)\+([A-Z0-9]|F([1-9]|1[0-9]|2[0-4]))$/.test(value) ? value : '';
}
class Library {
  constructor(root) { this.root = root; this.state = { clips: [], captures: [], settings: { ...DEFAULTS } }; this.queue = Promise.resolve(); }
  async init() {
    await fs.mkdir(path.join(this.root, 'clips'), { recursive: true });
    await fs.mkdir(path.join(this.root, 'captures'), { recursive: true });
    try {
      const saved = JSON.parse(await fs.readFile(path.join(this.root, 'library.json'), 'utf8'));
      if (!Array.isArray(saved.clips)) throw new Error('Invalid clip library');
      this.state.clips = saved.clips.filter(c => typeof c.id === 'string' && /^[a-f0-9-]{36}\.(mp3|wav|ogg|m4a|flac|webm)$/.test(c.file)).slice(0, 120).map(c => ({ ...c, name: String(c.name).slice(0, 80), volume: clamp(c.volume, 0, 150, 100), color: COLORS.includes(c.color) ? c.color : 'lime', loop: Boolean(c.loop), hotkey: shortcut(c.hotkey), duration: clamp(c.duration, 0, 86400, 0), loudness: Number.isFinite(Number(c.loudness)) ? clamp(c.loudness, -60, 0, null) : null }));
      this.state.captures = (Array.isArray(saved.captures) ? saved.captures : []).filter(c => typeof c.id === 'string' && /^[a-f0-9-]{36}\.wav$/.test(c.file)).slice(0, MAX_CAPTURES).map(c => ({ id: c.id, file: c.file, name: String(c.name || 'Capture').slice(0, 80), duration: clamp(c.duration, 0, 600, 0), createdAt: clamp(c.createdAt, 0, 1e13, 0) }));
      this.updateSettings(saved.settings || {});
      this.assignSlots();
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.warning = 'The saved library could not be read. Your audio files have been kept.';
        await fs.copyFile(path.join(this.root, 'library.json'), path.join(this.root, `library-recovery-${Date.now()}.json`)).catch(() => {});
      }
    }
    return this.snapshot();
  }
  /** Positional shortcuts: pads 1-10 get Ctrl+Alt+1…9,0; a digit key on any later pad is cleared. */
  assignSlots() {
    this.state.clips.forEach((clip, index) => {
      if (index < SLOT_KEYS.length) clip.hotkey = SLOT_KEYS[index];
      else if (isSlotKey(clip.hotkey)) clip.hotkey = '';
    });
  }
  async reorder(ids) {
    if (!Array.isArray(ids)) throw new Error('Invalid order.');
    const byId = new Map(this.state.clips.map(c => [c.id, c]));
    const ordered = ids.filter((id, i) => byId.has(id) && ids.indexOf(id) === i).map(id => byId.get(id));
    if (ordered.length !== this.state.clips.length) throw new Error('The sound list changed. Try again.');
    this.state.clips = ordered;
    this.assignSlots();
    await this.commit();
    return this.snapshot();
  }
  snapshot() { return structuredClone({ ...this.state, warning: this.warning || '' }); }
  updateSettings(patch) {
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
    if ('overlay' in patch) {
      const o = patch.overlay;
      this.state.settings.overlay = o && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(Number(o[k])))
        ? { x: Math.round(o.x), y: Math.round(o.y), width: Math.round(clamp(o.width, 200, 2000, 340)), height: Math.round(clamp(o.height, 120, 2000, 420)), opacity: clamp(o.opacity, 0.3, 1, 0.92) }
        : null;
    }
  }
  commit() {
    const data = JSON.stringify(this.state, null, 2);
    const write = this.queue.catch(() => {}).then(async () => {
      const temp = path.join(this.root, 'library.json.tmp');
      await fs.writeFile(temp, data, 'utf8');
      await fs.rename(temp, path.join(this.root, 'library.json'));
    });
    this.queue = write;
    return write;
  }
  async importFiles(paths) {
    if (!Array.isArray(paths)) throw new Error('Choose audio files to import.');
    const added = [], errors = [];
    for (const source of paths.slice(0, 120)) {
      try {
        if (this.state.clips.length >= 120) throw new Error('The library limit is 120 sounds.');
        if (typeof source !== 'string') throw new Error('Invalid file.');
        const ext = path.extname(source).toLowerCase();
        if (!EXTENSIONS.has(ext)) throw new Error('Use MP3, WAV, OGG, M4A, FLAC, or WebM.');
        const stat = await fs.stat(source);
        if (!stat.isFile() || stat.size === 0 || stat.size > 30 * 1024 * 1024) throw new Error('Each file must be between 1 byte and 30 MB.');
        const id = randomUUID();
        const clip = { id, file: id + ext, name: path.basename(source, ext).slice(0, 80), color: COLORS[this.state.clips.length % COLORS.length], volume: 100, loop: false, hotkey: '', duration: 0, loudness: null };
        await fs.copyFile(source, path.join(this.root, 'clips', clip.file));
        this.state.clips.push(clip); added.push(clip.id);
        this.assignSlots();
      } catch (e) { errors.push(`${typeof source === 'string' ? path.basename(source) : 'File'}: ${e.message}`); }
    }
    await this.commit();
    return { ...this.snapshot(), added, errors };
  }
  /** Adds a clip from in-memory audio bytes (used for trimmed replay captures). */
  async importBuffer(name, bytes, ext = '.wav') {
    if (this.state.clips.length >= 120) throw new Error('The library limit is 120 sounds.');
    if (!EXTENSIONS.has(ext)) throw new Error('Unsupported audio format.');
    const data = Buffer.from(bytes);
    if (!data.length || data.length > 30 * 1024 * 1024) throw new Error('The sound must be between 1 byte and 30 MB.');
    const id = randomUUID();
    const clip = { id, file: id + ext, name: String(name || 'Capture').trim().slice(0, 80) || 'Capture', color: COLORS[this.state.clips.length % COLORS.length], volume: 100, loop: false, hotkey: '', duration: 0, loudness: null };
    await fs.writeFile(path.join(this.root, 'clips', clip.file), data);
    this.state.clips.push(clip);
    this.assignSlots();
    await this.commit();
    return { ...this.snapshot(), added: [id], errors: [] };
  }
  async addCapture(bytes, duration, name) {
    const data = Buffer.from(bytes);
    if (!data.length || data.length > 64 * 1024 * 1024) throw new Error('The capture is empty or too large.');
    const id = randomUUID();
    const capture = { id, file: id + '.wav', name: String(name || '').trim().slice(0, 80) || `Capture ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, duration: clamp(duration, 0, 600, 0), createdAt: Date.now() };
    await fs.writeFile(path.join(this.root, 'captures', capture.file), data);
    this.state.captures.unshift(capture);
    const dropped = this.state.captures.splice(MAX_CAPTURES);
    await this.commit();
    for (const old of dropped) await fs.unlink(path.join(this.root, 'captures', old.file)).catch(() => {});
    return { ...this.snapshot(), added: id };
  }
  async readCapture(id) {
    const capture = this.state.captures.find(c => c.id === id);
    if (!capture) throw new Error('This capture is no longer available.');
    return fs.readFile(path.join(this.root, 'captures', capture.file));
  }
  async renameCapture(id, name) {
    const capture = this.state.captures.find(c => c.id === id);
    if (!capture) throw new Error('This capture is no longer available.');
    capture.name = String(name || '').trim().slice(0, 80) || capture.name;
    await this.commit(); return this.snapshot();
  }
  async removeCapture(id) {
    const capture = this.state.captures.find(c => c.id === id);
    if (!capture) return this.snapshot();
    this.state.captures = this.state.captures.filter(c => c.id !== id);
    await this.commit();
    await fs.unlink(path.join(this.root, 'captures', capture.file)).catch(() => {});
    return this.snapshot();
  }
  async read(id) {
    const clip = this.state.clips.find(c => c.id === id);
    if (!clip) throw new Error('This sound is no longer in the library.');
    return fs.readFile(path.join(this.root, 'clips', clip.file));
  }
  async edit(id, patch) {
    const clip = this.state.clips.find(c => c.id === id);
    if (!clip) throw new Error('Sound not found.');
    if ('hotkey' in patch) {
      const hotkey = shortcut(patch.hotkey);
      if (patch.hotkey && !hotkey) throw new Error('Use Ctrl+Alt, Ctrl+Shift, or Alt+Shift with a letter, number, or function key.');
      if (hotkey === 'Control+Alt+M') throw new Error('Ctrl+Alt+M is reserved for microphone mute.');
      if (hotkey === 'Control+Alt+O') throw new Error('Ctrl+Alt+O is reserved for the game overlay.');
      const index = this.state.clips.indexOf(clip);
      if (isSlotKey(hotkey) && hotkey !== SLOT_KEYS[index]) throw new Error('Ctrl+Alt+0–9 follow pad order. Drag the pad into that position instead.');
      if (index < SLOT_KEYS.length && hotkey !== SLOT_KEYS[index]) throw new Error(`This pad is one of the first ten, so it keeps ${SLOT_KEYS[index].replace('Control', 'Ctrl')}. Drag it further down to give it a custom shortcut.`);
      if (hotkey && this.state.clips.some(c => c.id !== id && c.hotkey === hotkey)) throw new Error('That shortcut belongs to another sound.');
      clip.hotkey = hotkey;
    }
    if (typeof patch.name === 'string') clip.name = patch.name.trim().slice(0, 80) || clip.name;
    if (COLORS.includes(patch.color)) clip.color = patch.color;
    if ('volume' in patch) clip.volume = clamp(patch.volume, 0, 150, 100);
    if ('loop' in patch) clip.loop = Boolean(patch.loop);
    if ('duration' in patch) clip.duration = clamp(patch.duration, 0, 86400, 0);
    if ('loudness' in patch) clip.loudness = Number.isFinite(Number(patch.loudness)) ? clamp(patch.loudness, -60, 0, null) : null;
    await this.commit(); return this.snapshot();
  }
  async remove(id) {
    const clip = this.state.clips.find(c => c.id === id);
    if (!clip) return this.snapshot();
    this.state.clips = this.state.clips.filter(c => c.id !== id);
    this.assignSlots();
    await this.commit();
    await fs.unlink(path.join(this.root, 'clips', clip.file)).catch(() => {});
    return this.snapshot();
  }
}
module.exports = { Library, DEFAULTS, shortcut, SLOT_KEYS };
