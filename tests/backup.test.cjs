const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Library } = require('../library.cjs');
const { ProjectStore } = require('../projects.cjs');
const { createBackup, restoreBackup, inspectBackup } = require('../backup.cjs');

function wav(seconds, hz = 440) {
  const frames = Math.round(seconds * 48000), data = Buffer.alloc(44 + frames * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(48000, 24); data.writeUInt32LE(96000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * i / 48000) * 9000), 44 + i * 2);
  return data;
}
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
async function dirs() {
  const base = path.join(__dirname, '..', 'test-results'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'backup-'));
  const out = path.join(root, 'backups'); await fs.mkdir(out);
  return { root, out };
}
/** A library with a composed pad, a saved project, a TTS pad, a collection, a region, a group, and captures. */
async function richLibrary(root) {
  const lib = new Library(path.join(root, 'live')); await lib.init();
  const store = new ProjectStore(lib); await store.init();
  const capture = await lib.addCapture(wav(1, 300), 1, 'Friend');
  const created = await store.create('Victory combo');
  const asset = await store.addAsset(created.id, wav(0.5, 500), { name: 'Cheer', origin: { kind: 'capture', id: capture.added } });
  const project = await store.save(created.id, { ...created, assets: [asset], regions: [{ id: crypto.randomUUID(), trackId: created.tracks[0].id, assetId: asset.id, atSeconds: 0, inSeconds: 0, outSeconds: 0.5, gainDb: -3, pan: 0, fadeInMs: 0, fadeOutMs: 10, label: 'Cheer' }] });
  const composed = await lib.importBuffer('Studio combo', wav(0.5, 600), '.wav', { source: { kind: 'studio', projectId: project.id, revision: project.revision } });
  const speech = await lib.importBuffer('Match start', wav(0.7, 700), '.wav', { source: { kind: 'tts', voice: 'Test Voice', provider: 'test', text: 'Hello team' } });
  const regionPad = await lib.captureToPad(capture.added, 'Friend line', { startSeconds: 0.25, endSeconds: 0.75, fadeInMs: 5, fadeOutMs: 5 });
  const { created: group } = await lib.createGroup('Beds');
  await lib.edit(speech.added[0], { favorite: true, tags: ['hype'], exclusiveGroupId: group, triggerMode: 'restart' });
  await lib.createCollection('Stream', [regionPad.added[0], composed.added[0]]);
  lib.updateSettings({ boardVolume: 150, effect: 'robot', outputId: 'secret-device', monitorId: 'phones', replayAuto: true }); await lib.commit();
  return { lib, store, project };
}

test('a backup round-trips into a fresh data root with audio, projects, provenance, regions, and collections intact', async () => {
  const { root, out } = await dirs();
  const { lib } = await richLibrary(root);
  const summary = await createBackup({ library: lib, destination: out, appVersion: '9.9.9' });
  assert.match(summary.name, /^PulseDeck Backup \d{8}-\d{6}-[a-f0-9]{6}$/);
  const manifest = JSON.parse(await fs.readFile(path.join(summary.folder, 'manifest.json'), 'utf8'));
  assert.equal(manifest.library.settings.outputId, undefined, 'device ids are not backed up');
  assert.equal(manifest.library.settings.replayAuto, undefined, 'automatic replay is not restored');
  assert.equal(manifest.library.settings.boardVolume, 150);
  assert.ok(!(await fs.readdir(summary.folder, { recursive: true })).some(n => n.includes('draft')), 'drafts are excluded');

  const fresh = new Library(path.join(root, 'fresh')); await fresh.init();
  const store = new ProjectStore(fresh); await store.init();
  const result = await restoreBackup({ library: fresh, source: summary.folder });
  assert.deepEqual([result.restored.clips, result.restored.captures, result.restored.projects, result.restored.collections], [3, 1, 1, 1]);
  const byName = name => fresh.state.clips.find(c => c.name === name);
  for (const clip of lib.state.clips) {
    const restored = byName(clip.name);
    assert.notEqual(restored.id, clip.id, 'ids are remapped');
    assert.equal(sha(await fresh.read(restored.id)), sha(await lib.read(clip.id)), `${clip.name} audio checksum`);
  }
  assert.deepEqual(byName('Friend line').playback, { startSeconds: 0.25, endSeconds: 0.75, fadeInMs: 5, fadeOutMs: 5 });
  assert.equal(byName('Match start').source.text, 'Hello team'); assert.equal(byName('Match start').favorite, true); assert.deepEqual(byName('Match start').tags, ['hype']);
  assert.equal(byName('Match start').exclusiveGroupId, fresh.state.groups[0].id);
  const newProject = fresh.state.projects[0];
  assert.equal(byName('Studio combo').source.projectId, newProject.id, 'provenance points at the restored project');
  assert.equal(byName('Friend line').source.captureId, fresh.state.captures[0].id);
  assert.deepEqual(fresh.state.collections[0].clipIds, [byName('Friend line').id, byName('Studio combo').id]);
  const opened = await store.open(newProject.id);
  assert.equal(opened.project.regions[0].gainDb, -3);
  assert.equal((await store.readAsset(newProject.id, opened.project.assets[0].id)).length, wav(0.5).length);
  assert.equal(fresh.state.settings.outputId, '', 'restore never selects devices');
  assert.equal(fresh.state.settings.replayAuto, false);
  assert.deepEqual(fresh.state.clips.slice(0, 3).map(c => c.hotkey), ['Control+Alt+1', 'Control+Alt+2', 'Control+Alt+3']);
  assert.deepEqual(await fs.readdir(fresh.root).then(n => n.filter(x => x.startsWith('.restore-'))), [], 'staging is cleaned up');
});

test('merging keeps existing data, renames conflicting names, and clears conflicting custom shortcuts', async () => {
  const { root, out } = await dirs();
  const { lib } = await richLibrary(root);
  for (let i = 0; i < 9; i++) await lib.importBuffer(`Filler ${i}`, wav(0.05));
  await lib.edit(lib.state.clips[10].id, { hotkey: 'Control+Shift+Q' });
  const summary = await createBackup({ library: lib, destination: out });
  const before = lib.state.clips.map(c => c.id);
  const result = await restoreBackup({ library: lib, source: summary.folder });
  assert.deepEqual(lib.state.clips.slice(0, before.length).map(c => c.id), before, 'existing sounds and order are untouched');
  assert.equal(lib.state.clips.length, before.length * 2);
  assert.ok(result.restored.warnings.some(w => w.includes('Ctrl+Shift+Q')));
  assert.equal(lib.state.clips.filter(c => c.hotkey === 'Control+Shift+Q').length, 1);
  assert.ok(lib.state.collections.some(c => c.name === 'Stream (restored)'));
  assert.ok(lib.state.projects.some(p => p.name === 'Victory combo (restored)'));
});

test('a restore that would exceed a limit fails before changing anything', async () => {
  const { root, out } = await dirs();
  const { lib } = await richLibrary(root);
  const summary = await createBackup({ library: lib, destination: out });
  const full = new Library(path.join(root, 'full')); await full.init();
  for (let i = 0; i < 119; i++) await full.importBuffer(`Sound ${i}`, wav(0.01));
  const snapshot = JSON.stringify(full.state), files = (await fs.readdir(path.join(full.root, 'clips'))).length;
  await assert.rejects(restoreBackup({ library: full, source: summary.folder }), /Nothing was restored.*122 sounds \(limit 120\)/);
  assert.equal(JSON.stringify(full.state), snapshot);
  assert.equal((await fs.readdir(path.join(full.root, 'clips'))).length, files);
});

test('damaged, hostile, or incomplete backups are rejected without touching the live library', async () => {
  const { root, out } = await dirs();
  const { lib } = await richLibrary(root);
  const summary = await createBackup({ library: lib, destination: out });
  const target = new Library(path.join(root, 'target')); await target.init();
  const clone = async (mutate) => {
    const folder = path.join(root, `hostile-${crypto.randomUUID()}`);
    await fs.cp(summary.folder, folder, { recursive: true });
    const manifestFile = path.join(folder, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    await mutate(manifest, folder);
    await fs.writeFile(manifestFile, JSON.stringify(manifest));
    return folder;
  };
  const cases = [
    [async (m, f) => { const file = path.join(f, ...m.files[0].path.split('/')); const data = await fs.readFile(file); data[data.length - 1] ^= 0xff; await fs.writeFile(file, data); }, /checksum/],
    [async (m, f) => { await fs.rm(path.join(f, ...m.files[0].path.split('/'))); }, /missing/],
    [async m => { m.files[0].path = '../../library.json'; }, /outside/],
    [async m => { m.files[0].path = 'C:/Windows/win.ini'; }, /outside/],
    [async m => { m.files[0].path = '/etc/passwd'; }, /outside/],
    [async m => { m.files[0].path = 'clips/evil.exe'; }, /unexpected/],
    [async m => { m.version = 99; }, /newer version/],
    [async m => { m.format = 'zip'; }, /not a PulseDeck backup/],
    [async m => { m.files = m.files.filter(f => !f.path.startsWith('clips/')); }, /missing audio/],
    [async m => { m.files[0].size = 999999999; }, /invalid size/],
    [async m => { m.files.push({ ...m.files[0] }); }, /twice/]
  ];
  for (const [mutate, expected] of cases) await assert.rejects(restoreBackup({ library: target, source: await clone(mutate) }), expected);
  await fs.writeFile(path.join(root, 'empty-manifest'), '');
  await assert.rejects(inspectBackup(root), /manifest.json is missing/);
  assert.equal(target.state.clips.length, 0);
  assert.deepEqual((await fs.readdir(target.root)).filter(n => n.startsWith('.restore-')), []);
  assert.equal((await fs.readdir(path.join(target.root, 'clips'))).length, 0);
});

test('backups cannot be written inside the live library, and a failed backup leaves no partial folder', async () => {
  const { root } = await dirs();
  const { lib } = await richLibrary(root);
  await assert.rejects(createBackup({ library: lib, destination: path.join(lib.root, 'clips') }), /outside the PulseDeck library/);
  await assert.rejects(createBackup({ library: lib, destination: lib.root }), /outside the PulseDeck library/);
  await assert.rejects(createBackup({ library: lib, destination: path.join(root, 'nope') }), /does not exist/);
  const out = path.join(root, 'partial'); await fs.mkdir(out);
  await fs.rm(path.join(lib.root, 'clips', lib.state.clips[0].file));
  await assert.rejects(createBackup({ library: lib, destination: out }));
  assert.deepEqual(await fs.readdir(out), [], 'the incomplete backup folder was removed');
});

test('restore rejects excess records, newer library schemas, bad references, and duplicate IDs instead of silently dropping them', async () => {
  const { root, out } = await dirs();
  const { lib } = await richLibrary(root);
  const { folder } = await createBackup({ library: lib, destination: out });
  const file = path.join(folder, 'manifest.json'), original = JSON.parse(await fs.readFile(file, 'utf8'));
  const target = new Library(path.join(root, 'target')); await target.init();
  for (const mutate of [
    m => { m.library.clips = Array.from({ length: 121 }, (_, i) => ({ ...m.library.clips[0], id: crypto.randomUUID(), name: String(i) })); },
    m => { m.library.schemaVersion = 999; },
    m => { m.library.clips.push({ ...m.library.clips[0] }); },
    m => { m.library.collections[0].clipIds.push(crypto.randomUUID()); },
    m => { m.library.clips[0].exclusiveGroupId = crypto.randomUUID(); },
    m => { m.version = 0; }
  ]) {
    const manifest = structuredClone(original); mutate(manifest);
    await fs.writeFile(file, JSON.stringify(manifest));
    await assert.rejects(restoreBackup({ library: target, source: folder }));
    assert.equal(target.state.clips.length, 0);
  }
});

test('backups include only referenced project assets and fail visibly if a saved project is unreadable', async () => {
  const { root, out } = await dirs();
  const { lib, store, project } = await richLibrary(root);
  const unused = await store.addAsset(project.id, wav(0.1));
  const projectFile = path.join(lib.root, 'projects', project.id, 'project.json');
  // An older save may still list an asset removed from the timeline.
  const old = JSON.parse(await fs.readFile(projectFile, 'utf8')); old.assets.push(unused);
  await fs.writeFile(projectFile, JSON.stringify(old));
  const summary = await createBackup({ library: lib, destination: out });
  const backup = await inspectBackup(summary.folder);
  assert.equal(backup.projects[0].project.assets.length, 1);
  await fs.writeFile(projectFile, '{broken');
  await assert.rejects(createBackup({ library: lib, destination: out }), /saved project.*could not be read/);
  assert.equal((await fs.readdir(out)).length, 1, 'no incomplete backup is left');
});
