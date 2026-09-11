const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { assertCanonicalWav } = require('./wav-header.cjs');
const { isId } = require('./library.cjs');

/**
 * Sound Studio project storage: projects/<uuid>/project.json, projects/<uuid>/draft.json (recovery),
 * projects/<uuid>/assets/<uuid>.wav. Every project owns copies of its audio, so deleting pads or evicted
 * captures never breaks it. The library index lists names and timestamps only.
 */
const PROJECT_SCHEMA = 1;
const LIMITS = Object.freeze({ projects: 100, tracks: 8, regions: 64, timelineSeconds: 180, assetSeconds: 180, assetBytes: 64 * 1024 * 1024, projectBytes: 256 * 1024 * 1024, maxFadeMs: 5000, draftBytes: 2 * 1024 * 1024 });
const finite = value => typeof value === 'number' && Number.isFinite(value);
const text = (value, max) => (typeof value === 'string' ? value : '').trim().slice(0, max);
const fail = message => { throw new Error(message); };

async function writeAtomic(file, data) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, data); await fs.rename(temp, file); }
  catch (error) { await fs.rm(temp, { force: true }).catch(() => {}); throw error; }
}

/** Reads a WAV header from disk without loading all audio. */
async function wavInfo(file) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const head = Buffer.alloc(Math.min(size, 65536));
    await handle.read(head, 0, head.length, 0);
    if (head.length < 44 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') fail('An audio file in this project is damaged.');
    let offset = 12, fmt = null;
    while (offset + 8 <= head.length) {
      const id = head.toString('ascii', offset, offset + 4), chunk = head.readUInt32LE(offset + 4), body = offset + 8;
      if (id === 'fmt ') fmt = { channels: head.readUInt16LE(body + 2), sampleRate: head.readUInt32LE(body + 4), blockAlign: head.readUInt16LE(body + 12) };
      else if (id === 'data' && fmt) { const frames = Math.floor(Math.min(chunk, size - body) / fmt.blockAlign); return { ...fmt, frames, duration: frames / fmt.sampleRate, bytes: size }; }
      offset = body + chunk + (chunk % 2);
    }
    fail('An audio file in this project is damaged.');
  } finally { await handle.close(); }
}

/** Strict, normalized project record. Only known fields, in a fixed order, are ever written. */
function normalizeProject(input, assetInfo) {
  if (!input || typeof input !== 'object') fail('The project is invalid.');
  if (input.schemaVersion !== PROJECT_SCHEMA) fail('This project uses an unsupported format.');
  const name = text(input.name, 1000);
  if (!name) fail('Name the project.');
  if (name.length > 80) fail('Project names can be at most 80 characters.');
  if (!Array.isArray(input.assets) || input.assets.length > 256) fail('The project audio list is invalid.');
  const assets = [];
  for (const a of input.assets) {
    if (!isId(a?.id) || a.file !== `${a.id}.wav` || assets.some(x => x.id === a.id)) fail('The project audio list is invalid.');
    const info = assetInfo.get(a.id);
    if (!info) fail(`Audio for “${text(a.name, 80) || 'a region'}” is missing from this project.`);
    const origin = a.origin && typeof a.origin === 'object' ? { kind: text(a.origin.kind, 16), id: isId(a.origin.id) ? a.origin.id : undefined, label: text(a.origin.label, 120) || undefined } : null;
    assets.push({ id: a.id, file: a.file, name: text(a.name, 80) || 'Audio', duration: info.duration, channels: info.channels, origin });
  }
  if (!Array.isArray(input.tracks) || input.tracks.length < 1 || input.tracks.length > LIMITS.tracks) fail('A project has 1 to 8 tracks.');
  const tracks = input.tracks.map(t => {
    if (!isId(t?.id) || !finite(t.gainDb) || t.gainDb < -60 || t.gainDb > 12) fail('A track is invalid.');
    return { id: t.id, name: text(t.name, 40) || 'Layer', gainDb: t.gainDb, mute: Boolean(t.mute), solo: Boolean(t.solo) };
  });
  if (new Set(tracks.map(t => t.id)).size !== tracks.length) fail('A track is invalid.');
  if (!Array.isArray(input.regions) || input.regions.length > LIMITS.regions) fail('A project has at most 64 regions.');
  const regions = input.regions.map(r => {
    if (!isId(r?.id) || !tracks.some(t => t.id === r.trackId) || !assets.some(a => a.id === r.assetId)) fail('A region refers to missing audio or a missing track.');
    for (const key of ['atSeconds', 'inSeconds', 'outSeconds', 'gainDb', 'pan', 'fadeInMs', 'fadeOutMs']) if (!finite(r[key])) fail('Region values must be numbers.');
    const asset = assets.find(a => a.id === r.assetId);
    if (r.atSeconds < 0 || r.inSeconds < 0 || r.outSeconds <= r.inSeconds || r.outSeconds > asset.duration + 1e-6) fail('A region is outside its audio.');
    if (r.atSeconds + r.outSeconds - r.inSeconds > LIMITS.timelineSeconds + 1e-6) fail('The timeline is limited to 3 minutes.');
    if (r.gainDb < -60 || r.gainDb > 12 || r.pan < -1 || r.pan > 1) fail('Region gain or pan is out of range.');
    if (r.fadeInMs < 0 || r.fadeOutMs < 0 || r.fadeInMs > LIMITS.maxFadeMs || r.fadeOutMs > LIMITS.maxFadeMs || (r.fadeInMs + r.fadeOutMs) / 1000 > r.outSeconds - r.inSeconds + 1e-9) fail('Region fades are out of range.');
    return { id: r.id, trackId: r.trackId, assetId: r.assetId, atSeconds: r.atSeconds, inSeconds: r.inSeconds, outSeconds: r.outSeconds, gainDb: r.gainDb, pan: r.pan, fadeInMs: r.fadeInMs, fadeOutMs: r.fadeOutMs, label: text(r.label, 80) };
  });
  if (new Set(regions.map(r => r.id)).size !== regions.length) fail('A region is duplicated.');
  let exportRange = null;
  if (input.exportRange) {
    const { startSeconds, endSeconds } = input.exportRange;
    if (!finite(startSeconds) || !finite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds || endSeconds > LIMITS.timelineSeconds) fail('The export range is invalid.');
    exportRange = { startSeconds, endSeconds };
  }
  return { schemaVersion: PROJECT_SCHEMA, id: input.id, revision: 0, name, sampleRate: 48000, channels: 2, createdAt: finite(input.createdAt) ? input.createdAt : Date.now(), updatedAt: Date.now(), assets, tracks, regions, exportRange };
}

class ProjectStore {
  constructor(library) { this.library = library; this.root = path.join(library.root, 'projects'); }

  dir(id) { if (!isId(id)) fail('That project no longer exists.'); return path.join(this.root, id); }
  entry(id) { return this.library.state.projects.find(p => p.id === id) || fail('That project no longer exists.'); }

  /** Reconciles the index with folders on disk and removes abandoned drafts or orphaned audio. */
  async init() {
    await fs.mkdir(this.root, { recursive: true });
    const folders = (await fs.readdir(this.root, { withFileTypes: true })).filter(d => d.isDirectory() && isId(d.name)).map(d => d.name);
    const known = new Set(this.library.state.projects.map(p => p.id));
    const changes = { dropped: [], cleaned: [] };
    await this.library.mutate(async () => {
      for (const entry of [...this.library.state.projects]) {
        const hasSaved = await exists(path.join(this.dir(entry.id), 'project.json')), hasDraft = await exists(path.join(this.dir(entry.id), 'draft.json'));
        if (!hasSaved && !hasDraft) { this.library.state.projects = this.library.state.projects.filter(p => p.id !== entry.id); changes.dropped.push(entry.id); }
        else if (entry.saved !== hasSaved) entry.saved = hasSaved;
      }
    });
    for (const id of folders) if (!known.has(id) && !this.library.state.projects.some(p => p.id === id)) {
      // A folder without an index entry comes from an interrupted create; remove only if it has no saved work.
      if (!await exists(path.join(this.dir(id), 'project.json'))) { await fs.rm(this.dir(id), { recursive: true, force: true }); changes.cleaned.push(id); }
    }
    for (const entry of this.library.state.projects) if (!await exists(path.join(this.dir(entry.id), 'draft.json'))) await this.collect(entry.id).catch(() => {});
    return changes;
  }

  list() { return structuredClone(this.library.state.projects); }

  async assetInfo(id) {
    const folder = path.join(this.dir(id), 'assets'), info = new Map();
    let names = [];
    try { names = await fs.readdir(folder); } catch { return info; }
    for (const name of names) {
      const match = /^([a-f0-9-]{36})\.wav$/.exec(name);
      if (!match || !isId(match[1])) continue;
      try { info.set(match[1], await wavInfo(path.join(folder, name))); } catch { /* reported when a region needs it */ }
    }
    return info;
  }

  create(name) {
    return this.library.mutate(async created => {
      if (this.library.state.projects.length >= LIMITS.projects) fail('You can keep at most 100 projects. Delete one first.');
      const id = randomUUID(), now = Date.now();
      const clean = text(name, 80) || 'Untitled project';
      await fs.mkdir(path.join(this.dir(id), 'assets'), { recursive: true }); created.push(this.dir(id));
      const project = { schemaVersion: PROJECT_SCHEMA, id, revision: 0, name: clean, sampleRate: 48000, channels: 2, createdAt: now, updatedAt: now, assets: [], tracks: [{ id: randomUUID(), name: 'Layer 1', gainDb: 0, mute: false, solo: false }], regions: [], exportRange: null };
      await writeAtomic(path.join(this.dir(id), 'draft.json'), JSON.stringify({ baseRevision: 0, savedAt: now, project }));
      this.library.state.projects.unshift({ id, name: clean, createdAt: now, updatedAt: now, revision: 0, saved: false });
      return project;
    });
  }

  /** Returns the last explicit save plus a newer recovery draft when one exists. */
  async open(id) {
    const entry = this.entry(id), folder = this.dir(id);
    let project = null, draft = null, draftError = '';
    if (await exists(path.join(folder, 'project.json'))) project = JSON.parse(await fs.readFile(path.join(folder, 'project.json'), 'utf8'));
    if (await exists(path.join(folder, 'draft.json'))) {
      try {
        const saved = JSON.parse(await fs.readFile(path.join(folder, 'draft.json'), 'utf8'));
        const info = await this.assetInfo(id);
        draft = { baseRevision: saved.baseRevision, savedAt: saved.savedAt, project: { ...normalizeProject(saved.project, info), id, revision: saved.baseRevision, updatedAt: saved.savedAt } };
      } catch (error) { draftError = `The recovery draft could not be used (${error.message}).`; }
    }
    if (!project && !draft) fail(draftError || 'This project could not be opened.');
    // Report audio files that disappeared, so the user can remove those regions or restore the files.
    const info = await this.assetInfo(id), shown = project || draft.project;
    const missing = [...new Set(shown.regions.map(r => r.assetId).filter(assetId => !info.has(assetId)))];
    if (!project) return { project: draft.project, draft: null, unsaved: true, entry, missing };
    return { project, draft, draftError, unsaved: false, entry, missing };
  }

  /** Validates canonical 48 kHz PCM16 audio and stores it as a project-owned asset. */
  addAsset(id, bytes, meta = {}) {
    return this.library.exclusive(async () => {
      this.entry(id);
      const data = Buffer.from(bytes || []);
      if (data.length > LIMITS.assetBytes) fail(`This audio is ${(data.length / 1048576).toFixed(1)} MB; project audio is limited to 64 MB per file. Choose a shorter selection.`);
      const info = assertCanonicalWav(data, { sampleRate: 48000, maxSeconds: LIMITS.assetSeconds, maxBytes: LIMITS.assetBytes });
      const folder = path.join(this.dir(id), 'assets');
      await fs.mkdir(folder, { recursive: true });
      let total = 0;
      for (const name of await fs.readdir(folder)) total += (await fs.stat(path.join(folder, name))).size;
      if (total + data.length > LIMITS.projectBytes) fail('This project already holds 256 MB of audio. Remove unused audio or start a new project.');
      const assetId = randomUUID();
      await writeAtomic(path.join(folder, `${assetId}.wav`), data);
      const origin = meta.origin && typeof meta.origin === 'object' ? { kind: text(meta.origin.kind, 16), id: isId(meta.origin.id) ? meta.origin.id : undefined, label: text(meta.origin.label, 120) || undefined } : null;
      return { id: assetId, file: `${assetId}.wav`, name: text(meta.name, 80) || 'Audio', duration: info.duration, channels: info.channels, origin };
    });
  }

  async readAsset(id, assetId) {
    if (!isId(assetId)) fail('That audio is not part of this project.');
    try { return await fs.readFile(path.join(this.dir(id), 'assets', `${assetId}.wav`)); }
    catch { fail('Audio for a region is missing from this project. Undo the change or remove the region.'); }
  }

  /** Explicit save: validates, increments the revision, writes atomically, and clears the recovery draft. */
  save(id, input) {
    return this.library.mutate(async () => {
      const entry = this.entry(id);
      const project = normalizeProject({ ...input, id }, await this.assetInfo(id));
      project.revision = (entry.revision || 0) + 1;
      await writeAtomic(path.join(this.dir(id), 'project.json'), JSON.stringify(project, null, 2));
      Object.assign(entry, { name: project.name, updatedAt: project.updatedAt, revision: project.revision, saved: true });
      await fs.rm(path.join(this.dir(id), 'draft.json'), { force: true });
      return project;
    });
  }

  /** Debounced recovery draft. Never replaces project.json; an invalid draft is rejected instead of written. */
  saveDraft(id, input) {
    return this.library.exclusive(async () => {
      const entry = this.entry(id);
      const project = normalizeProject({ ...input, id }, await this.assetInfo(id));
      const data = JSON.stringify({ baseRevision: entry.revision || 0, savedAt: Date.now(), project });
      if (data.length > LIMITS.draftBytes) fail('The project is too large to recover.');
      await writeAtomic(path.join(this.dir(id), 'draft.json'), data);
      return { savedAt: Date.now() };
    });
  }

  /** Drops the recovery draft (Discard). A project that was never saved is removed entirely. */
  discard(id) {
    return this.library.mutate(async () => {
      const entry = this.entry(id);
      if (!entry.saved) { await fs.rm(this.dir(id), { recursive: true, force: true }); this.library.state.projects = this.library.state.projects.filter(p => p.id !== id); return { removed: true }; }
      await fs.rm(path.join(this.dir(id), 'draft.json'), { force: true });
      await this.collect(id);
      return { removed: false };
    });
  }

  saveCopy(id, input, name) {
    return this.library.mutate(async created => {
      if (this.library.state.projects.length >= LIMITS.projects) fail('You can keep at most 100 projects. Delete one first.');
      const source = normalizeProject({ ...input, id, name: text(name, 80) || `${text(input?.name, 70)} copy` }, await this.assetInfo(id));
      const copyId = randomUUID(), folder = this.dir(copyId);
      await fs.mkdir(path.join(folder, 'assets'), { recursive: true }); created.push(folder);
      const used = new Set(source.regions.map(r => r.assetId));
      source.assets = source.assets.filter(a => used.has(a.id));
      for (const asset of source.assets) await fs.copyFile(path.join(this.dir(id), 'assets', asset.file), path.join(folder, 'assets', asset.file));
      const project = { ...source, id: copyId, revision: 1, createdAt: Date.now(), updatedAt: Date.now() };
      await writeAtomic(path.join(folder, 'project.json'), JSON.stringify(project, null, 2));
      this.library.state.projects.unshift({ id: copyId, name: project.name, createdAt: project.createdAt, updatedAt: project.updatedAt, revision: 1, saved: true });
      return project;
    });
  }

  rename(id, name) {
    return this.library.mutate(async () => {
      const entry = this.entry(id);
      const clean = text(name, 1000);
      if (!clean) fail('Name the project.');
      if (clean.length > 80) fail('Project names can be at most 80 characters.');
      const file = path.join(this.dir(id), 'project.json');
      if (await exists(file)) {
        const project = JSON.parse(await fs.readFile(file, 'utf8'));
        project.name = clean;
        await writeAtomic(file, JSON.stringify(project, null, 2));
      }
      entry.name = clean;
      return this.list();
    });
  }

  remove(id) {
    return this.library.mutate(async () => {
      this.entry(id);
      this.library.state.projects = this.library.state.projects.filter(p => p.id !== id);
      await fs.rm(this.dir(id), { recursive: true, force: true });
      return this.list();
    });
  }

  /**
   * Garbage-collects audio that neither the saved project nor the recovery draft references.
   * Called when a project closes (its undo history is gone) and at startup, never while it is open.
   */
  async collect(id, keep = []) {
    const folder = this.dir(id), needed = new Set(keep);
    for (const name of ['project.json', 'draft.json']) {
      try {
        const data = JSON.parse(await fs.readFile(path.join(folder, name), 'utf8'));
        for (const region of (data.project || data).regions || []) needed.add(region.assetId);
      } catch { /* missing */ }
    }
    let names = [];
    try { names = await fs.readdir(path.join(folder, 'assets')); } catch { return 0; }
    let removed = 0;
    for (const name of names) {
      const assetId = name.replace(/\.wav$/, '');
      if (name.endsWith('.tmp') || (isId(assetId) && !needed.has(assetId))) { await fs.rm(path.join(folder, 'assets', name), { force: true }); removed++; }
    }
    return removed;
  }

  close(id) { return this.library.exclusive(async () => { if (this.library.state.projects.some(p => p.id === id)) return this.collect(id); return 0; }); }

  /** Projects whose recovery draft is newer than their last explicit save. */
  async recoverable() {
    const list = [];
    for (const entry of this.library.state.projects) {
      const file = path.join(this.dir(entry.id), 'draft.json');
      if (!await exists(file)) continue;
      try { const draft = JSON.parse(await fs.readFile(file, 'utf8')); if (draft.project?.regions?.length || entry.saved) list.push({ id: entry.id, name: entry.name, savedAt: draft.savedAt, saved: entry.saved }); }
      catch { /* unreadable draft is ignored */ }
    }
    return list;
  }
}

async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }

module.exports = { ProjectStore, normalizeProject, wavInfo, PROJECT_LIMITS: LIMITS, writeAtomic };
