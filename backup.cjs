const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Library, LIMITS, isId, SLOT_KEYS } = require('./library.cjs');
const { normalizeProject, wavInfo, writeAtomic } = require('./projects.cjs');

/**
 * Portable backup folders. A backup is a new child folder with manifest.json (versioned, with SHA-256
 * checksums), the library metadata, clips, captures, and saved Studio projects with the audio they use.
 * Restore validates everything first and merges into the current library with new ids; nothing in the
 * live library changes until the whole backup has been checked and staged.
 */
const FORMAT = 'pulsedeck-backup';
const VERSION = 1;
const MANIFEST_BYTES = 16 * 1024 * 1024;
const FILE_BYTES = 64 * 1024 * 1024;
const CREATIVE_SETTINGS = ['boardVolume', 'micVolume', 'effect', 'voicePitch', 'effectMix', 'autoLevel', 'replaySeconds', 'replayMic', 'ducking', 'ttsSpeed', 'ttsVolume'];
const FILE_PATTERNS = [/^clips\/[a-f0-9-]{36}\.(mp3|wav|ogg|m4a|flac|webm)$/, /^captures\/[a-f0-9-]{36}\.wav$/, /^projects\/[a-f0-9-]{36}\/project\.json$/, /^projects\/[a-f0-9-]{36}\/assets\/[a-f0-9-]{36}\.wav$/];
const fail = message => { throw new Error(message); };

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); size += chunk.length; }
  return { sha256: hash.digest('hex'), size };
}
async function copyWithHash(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
  return hashFile(to);
}
const isInside = (parent, child) => { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
const stamp = date => date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/** Creates `PulseDeck Backup <timestamp>-<unique>` inside `destination`. */
async function createBackup({ library, destination, appVersion = '' }) {
  if (typeof destination !== 'string' || !path.isAbsolute(destination)) fail('Choose a folder for the backup.');
  const stat = await fs.stat(destination).catch(() => null);
  if (!stat?.isDirectory()) fail('The backup folder does not exist.');
  const liveRoot = await fs.realpath(library.root), target = await fs.realpath(destination);
  if (isInside(liveRoot, target)) fail('Choose a folder outside the PulseDeck library folder, so the backup cannot include itself.');
  const folder = path.join(target, `PulseDeck Backup ${stamp(new Date())}-${crypto.randomBytes(3).toString('hex')}`);
  // The storage lock keeps metadata and files from different revisions from mixing.
  return library.exclusive(async () => {
    await fs.mkdir(folder);
    try {
      const state = structuredClone(library.state);
      const files = [];
      const add = async relative => {
        const info = await copyWithHash(path.join(library.root, ...relative.split('/')), path.join(folder, ...relative.split('/')));
        files.push({ path: relative, ...info });
      };
      for (const clip of state.clips) await add(`clips/${clip.file}`);
      for (const capture of state.captures) await add(`captures/${capture.file}`);
      const projects = [];
      for (const entry of state.projects.filter(p => p.saved)) {
        const file = path.join(library.root, 'projects', entry.id, 'project.json');
        let project;
        try { project = JSON.parse(await fs.readFile(file, 'utf8')); } catch { continue; }
        const used = new Set(project.regions.map(r => r.assetId));
        await add(`projects/${entry.id}/project.json`);
        for (const asset of project.assets) if (used.has(asset.id)) await add(`projects/${entry.id}/assets/${asset.file}`);
        projects.push({ id: entry.id, name: entry.name, createdAt: entry.createdAt, updatedAt: entry.updatedAt, revision: entry.revision });
      }
      const settings = {};
      for (const key of CREATIVE_SETTINGS) if (key in state.settings) settings[key] = state.settings[key];
      const manifest = {
        format: FORMAT, version: VERSION, createdAt: Date.now(), appVersion,
        library: { schemaVersion: state.schemaVersion, clips: state.clips, captures: state.captures, collections: state.collections, groups: state.groups, settings, projects },
        files
      };
      await writeAtomic(path.join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2));
      const bytes = files.reduce((sum, f) => sum + f.size, 0);
      return { folder, name: path.basename(folder), clips: state.clips.length, captures: state.captures.length, projects: projects.length, files: files.length, bytes };
    } catch (error) {
      await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  });
}

/** Reads and fully validates a backup folder without touching the live library. */
async function inspectBackup(source) {
  if (typeof source !== 'string' || !path.isAbsolute(source)) fail('Choose a PulseDeck Backup folder.');
  const root = await fs.realpath(source).catch(() => fail('That backup folder does not exist.'));
  const manifestFile = path.join(root, 'manifest.json');
  const manifestStat = await fs.lstat(manifestFile).catch(() => fail('This folder is not a PulseDeck backup (manifest.json is missing).'));
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) fail('The backup manifest is not a regular file.');
  if (manifestStat.size > MANIFEST_BYTES) fail('The backup manifest is too large.');
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')); } catch { fail('The backup manifest is damaged.'); }
  if (manifest?.format !== FORMAT) fail('This folder is not a PulseDeck backup.');
  if (!Number.isInteger(manifest.version) || manifest.version > VERSION) fail('This backup was made by a newer version of PulseDeck. Update PulseDeck to restore it.');
  if (!Array.isArray(manifest.files) || manifest.files.length > 20000 || !manifest.library || typeof manifest.library !== 'object') fail('The backup manifest is incomplete.');
  const files = new Map();
  for (const entry of manifest.files) {
    const relative = entry?.path;
    if (typeof relative !== 'string' || relative.includes('\\') || relative.includes('\0') || path.isAbsolute(relative) || /^[a-z]:/i.test(relative) || relative.split('/').some(part => part === '..' || part === '.' || !part)) fail('The backup lists a file outside the backup folder.');
    if (!FILE_PATTERNS.some(pattern => pattern.test(relative))) fail(`The backup lists an unexpected file (${relative.slice(0, 80)}).`);
    if (files.has(relative)) fail('The backup lists a file twice.');
    if (!Number.isInteger(entry.size) || entry.size < 1 || entry.size > FILE_BYTES || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) fail('The backup lists a file with an invalid size or checksum.');
    const full = path.join(root, ...relative.split('/'));
    const stat = await fs.lstat(full).catch(() => fail(`A file is missing from the backup (${relative}).`));
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`A backup file is not a regular file (${relative}).`);
    const real = await fs.realpath(full);
    if (!isInside(root, real)) fail('The backup contains a link that points outside the backup folder.');
    if (stat.size !== entry.size) fail(`A backup file has the wrong size (${relative}).`);
    const { sha256 } = await hashFile(full);
    if (sha256 !== entry.sha256) fail(`A backup file is damaged: its checksum does not match (${relative}).`);
    files.set(relative, full);
  }
  // Normalize the metadata with the same rules as a normal library load.
  const scratch = new Library(root);
  scratch.load({ ...manifest.library, clips: Array.isArray(manifest.library.clips) ? manifest.library.clips : [] });
  const library = scratch.state;
  for (const clip of library.clips) if (!files.has(`clips/${clip.file}`)) fail(`The backup is missing audio for “${clip.name}”.`);
  for (const capture of library.captures) if (!files.has(`captures/${capture.file}`)) fail(`The backup is missing the capture “${capture.name}”.`);
  const projects = [];
  for (const entry of Array.isArray(manifest.library.projects) ? manifest.library.projects : []) {
    if (!isId(entry?.id) || !files.has(`projects/${entry.id}/project.json`)) fail('The backup lists a project that is missing.');
    const raw = JSON.parse(await fs.readFile(files.get(`projects/${entry.id}/project.json`), 'utf8'));
    const info = new Map();
    for (const asset of Array.isArray(raw.assets) ? raw.assets : []) {
      const key = `projects/${entry.id}/assets/${asset?.file}`;
      if (files.has(key)) info.set(asset.id, await wavInfo(files.get(key)));
    }
    let project;
    try { project = normalizeProject(raw, info); } catch (error) { fail(`The backup project “${String(entry.name || '').slice(0, 60)}” is invalid: ${error.message}`); }
    projects.push({ entry, project: { ...project, revision: Number.isInteger(raw.revision) ? raw.revision : 1, createdAt: raw.createdAt, updatedAt: raw.updatedAt } });
  }
  return { root, manifest, files, library, projects };
}

/** Merges a validated backup into the live library. Fails before any change if the result would not fit. */
async function restoreBackup({ library, source }) {
  const backup = await inspectBackup(source);
  return library.mutate(async created => {
    const live = library.state, incoming = backup.library;
    const totals = { clips: live.clips.length + incoming.clips.length, captures: live.captures.length + incoming.captures.length, projects: live.projects.length + backup.projects.length, collections: live.collections.length + incoming.collections.length, groups: live.groups.length + incoming.groups.length };
    const over = [['clips', 'sounds'], ['captures', 'replay captures'], ['projects', 'projects'], ['collections', 'collections'], ['groups', 'exclusive groups']].filter(([key]) => totals[key] > LIMITS[key]);
    if (over.length) fail(`Nothing was restored. The merged library would have ${over.map(([key, label]) => `${totals[key]} ${label} (limit ${LIMITS[key]})`).join(', ')}. Remove some first, then try again.`);
    const warnings = [];
    const ids = { clips: new Map(), captures: new Map(), projects: new Map(), collections: new Map(), groups: new Map() };
    const staging = path.join(library.root, `.restore-${crypto.randomUUID()}`);
    await fs.mkdir(staging); created.push(staging);
    try {
      // 1. Stage every file under a new name inside the library folder (same volume, so moving is atomic).
      const staged = [];
      const stage = async (relative, finalRelative) => {
        const temp = path.join(staging, crypto.randomUUID());
        await fs.copyFile(backup.files.get(relative), temp, fs.constants.COPYFILE_EXCL);
        staged.push({ temp, final: path.join(library.root, ...finalRelative.split('/')) });
      };
      for (const group of incoming.groups) ids.groups.set(group.id, crypto.randomUUID());
      for (const capture of incoming.captures) { const id = crypto.randomUUID(); ids.captures.set(capture.id, id); await stage(`captures/${capture.file}`, `captures/${id}.wav`); }
      for (const { entry, project } of backup.projects) {
        const id = crypto.randomUUID(); ids.projects.set(entry.id, id);
        for (const asset of project.assets) if (project.regions.some(r => r.assetId === asset.id)) await stage(`projects/${entry.id}/assets/${asset.file}`, `projects/${id}/assets/${asset.file}`);
      }
      for (const clip of incoming.clips) { const id = crypto.randomUUID(); ids.clips.set(clip.id, id); await stage(`clips/${clip.file}`, `clips/${id}${path.extname(clip.file)}`); }
      // 2. Move staged files into place; each one is recorded so a failure removes only what this restore added.
      for (const { temp, final } of staged) {
        await fs.mkdir(path.dirname(final), { recursive: true });
        await fs.rename(temp, final); created.push(final);
      }
      for (const { entry, project } of backup.projects) {
        const id = ids.projects.get(entry.id), folder = path.join(library.root, 'projects', id);
        const used = new Set(project.regions.map(r => r.assetId));
        const restored = { ...project, id, assets: project.assets.filter(a => used.has(a.id)) };
        await fs.mkdir(path.join(folder, 'assets'), { recursive: true });
        await writeAtomic(path.join(folder, 'project.json'), JSON.stringify(restored, null, 2));
        created.push(folder);
      }
      // 3. Merge metadata with remapped ids. Existing data is never changed.
      const usedKeys = new Set(live.clips.map(c => c.hotkey).filter(Boolean));
      for (const group of incoming.groups) live.groups.push({ id: ids.groups.get(group.id), name: group.name });
      for (const capture of incoming.captures) live.captures.push({ ...capture, id: ids.captures.get(capture.id), file: `${ids.captures.get(capture.id)}.wav` });
      live.captures.sort((a, b) => b.createdAt - a.createdAt);
      for (const { entry, project } of backup.projects) {
        const names = new Set(live.projects.map(p => p.name));
        const name = names.has(project.name) ? `${project.name} (restored)`.slice(0, 80) : project.name;
        live.projects.push({ id: ids.projects.get(entry.id), name, createdAt: project.createdAt || Date.now(), updatedAt: project.updatedAt || Date.now(), revision: project.revision || 1, saved: true });
        if (name !== project.name) await fs.writeFile(path.join(library.root, 'projects', ids.projects.get(entry.id), 'project.json'), JSON.stringify({ ...JSON.parse(await fs.readFile(path.join(library.root, 'projects', ids.projects.get(entry.id), 'project.json'), 'utf8')), name }, null, 2));
      }
      for (const clip of incoming.clips) {
        const id = ids.clips.get(clip.id);
        const source = { ...clip.source };
        if (source.projectId) { if (ids.projects.has(source.projectId)) source.projectId = ids.projects.get(source.projectId); else delete source.projectId; }
        if (source.captureId) { if (ids.captures.has(source.captureId)) source.captureId = ids.captures.get(source.captureId); else delete source.captureId; }
        let hotkey = SLOT_KEYS.includes(clip.hotkey) ? '' : clip.hotkey;
        if (hotkey && usedKeys.has(hotkey)) { warnings.push(`“${clip.name}” lost its shortcut ${hotkey.replace('Control', 'Ctrl')} because another sound already uses it.`); hotkey = ''; }
        if (hotkey) usedKeys.add(hotkey);
        live.clips.push({ ...clip, id, file: `${id}${path.extname(clip.file)}`, hotkey, source, exclusiveGroupId: clip.exclusiveGroupId ? ids.groups.get(clip.exclusiveGroupId) || '' : '' });
      }
      library.assignSlots();
      const liveNames = new Set(live.collections.map(c => c.name));
      for (const collection of incoming.collections) {
        const name = liveNames.has(collection.name) ? `${collection.name} (restored)`.slice(0, 60) : collection.name;
        live.collections.push({ id: crypto.randomUUID(), name, clipIds: collection.clipIds.map(id => ids.clips.get(id)).filter(Boolean) });
      }
      await fs.rm(staging, { recursive: true, force: true });
      return { ...library.snapshot(), restored: { clips: incoming.clips.length, captures: incoming.captures.length, projects: backup.projects.length, collections: incoming.collections.length, groups: incoming.groups.length, warnings, from: path.basename(backup.root), createdAt: backup.manifest.createdAt } };
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  });
}

module.exports = { createBackup, inspectBackup, restoreBackup, BACKUP_FORMAT: FORMAT, BACKUP_VERSION: VERSION };
