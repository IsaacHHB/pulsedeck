const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Library } = require('../library.cjs');
const { ProjectStore } = require('../projects.cjs');

function wav(seconds, { rate = 48000, channels = 1, bits = 16 } = {}) {
  const frames = Math.round(seconds * rate), block = channels * bits / 8, data = Buffer.alloc(44 + frames * block);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(channels, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * block, 28); data.writeUInt16LE(block, 32); data.writeUInt16LE(bits, 34); data.write('data', 36); data.writeUInt32LE(frames * block, 40);
  for (let i = 0; i < frames * channels && bits === 16; i++) data.writeInt16LE(Math.round(Math.sin(i / 7) * 9000), 44 + i * 2);
  return data;
}
async function setup() {
  const base = path.join(__dirname, '..', 'test-results'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'projects-'));
  const lib = new Library(root); await lib.init();
  const store = new ProjectStore(lib); await store.init();
  return { root, lib, store };
}
function withRegion(project, asset, extra = {}) {
  return { ...project, assets: [...project.assets, asset], regions: [...project.regions, { id: crypto.randomUUID(), trackId: project.tracks[0].id, assetId: asset.id, atSeconds: 0, inSeconds: 0, outSeconds: asset.duration, gainDb: 0, pan: 0, fadeInMs: 0, fadeOutMs: 0, label: asset.name, ...extra }] };
}

test('a new project saves atomically, increments its revision, and reopens identically', async () => {
  const { store, lib } = await setup();
  const created = await store.create('Victory combo');
  assert.equal(lib.state.projects[0].saved, false);
  const asset = await store.addAsset(created.id, wav(1), { name: 'Cheer', origin: { kind: 'clip', id: crypto.randomUUID() } });
  assert.equal(asset.duration, 1); assert.equal(asset.channels, 1);
  const saved = await store.save(created.id, withRegion(created, asset));
  assert.equal(saved.revision, 1);
  const again = await store.save(created.id, { ...saved, name: 'Victory combo 2' });
  assert.equal(again.revision, 2); assert.equal(lib.state.projects[0].name, 'Victory combo 2');
  const opened = await store.open(created.id);
  assert.deepEqual(opened.project.regions, again.regions); assert.equal(opened.draft, null);
  const reloaded = new Library(lib.root); await reloaded.init();
  assert.equal(reloaded.state.projects[0].revision, 2);
});

test('project audio must be canonical 48 kHz PCM16 mono/stereo within 3 minutes and the byte limits', async () => {
  const { store } = await setup();
  const { id } = await store.create('Limits');
  await assert.rejects(store.addAsset(id, wav(1, { rate: 44100 })), /48000/);
  await assert.rejects(store.addAsset(id, wav(0.1, { channels: 3 })), /mono and stereo/);
  await assert.rejects(store.addAsset(id, Buffer.from('nope, not a wav file, padding padding padding padding')), /not a WAV/);
  await assert.rejects(store.addAsset(id, wav(181)), /180 seconds/);
  await assert.rejects(store.addAsset(id, Buffer.alloc(65 * 1024 * 1024)), /64 MB/);
  const stereo = await store.addAsset(id, wav(0.5, { channels: 2 }));
  assert.equal(stereo.channels, 2);
});

test('invalid projects, missing audio, and out-of-range values are rejected without touching the last save', async () => {
  const { store, root } = await setup();
  const created = await store.create('Guarded');
  const asset = await store.addAsset(created.id, wav(1));
  const good = await store.save(created.id, withRegion(created, asset));
  const file = path.join(root, 'projects', created.id, 'project.json'), before = await fs.readFile(file, 'utf8');
  const bad = [
    { ...good, schemaVersion: 7 },
    withRegion(good, { ...asset, id: crypto.randomUUID(), file: 'x.wav' }),
    { ...good, regions: [{ ...good.regions[0], outSeconds: 4 }] },
    { ...good, regions: [{ ...good.regions[0], atSeconds: 179.5 }] },
    { ...good, regions: [{ ...good.regions[0], gainDb: 40 }] },
    { ...good, regions: [{ ...good.regions[0], pan: NaN }] },
    { ...good, tracks: [] },
    { ...good, exportRange: { startSeconds: 3, endSeconds: 2 } },
    { ...good, assets: [{ ...asset, file: '../../library.json' }] }
  ];
  for (const project of bad) await assert.rejects(store.save(created.id, project));
  await assert.rejects(store.saveDraft(created.id, bad[2]));
  assert.equal(await fs.readFile(file, 'utf8'), before);
  await assert.rejects(store.readAsset(created.id, '../library'), /not part/);
  await assert.rejects(store.open('../../etc'), /no longer exists/);
});

test('recovery drafts survive a restart, never replace the explicit save, and can be discarded', async () => {
  const { store, lib } = await setup();
  const created = await store.create('Draft');
  const a = await store.addAsset(created.id, wav(1)), b = await store.addAsset(created.id, wav(2));
  const saved = await store.save(created.id, withRegion(created, a));
  await store.saveDraft(created.id, withRegion(saved, b, { atSeconds: 1 }));
  const restarted = new ProjectStore(await (async () => { const l = new Library(lib.root); await l.init(); return l; })());
  await restarted.init();
  assert.deepEqual((await restarted.recoverable()).map(r => r.id), [created.id]);
  const opened = await restarted.open(created.id);
  assert.equal(opened.project.regions.length, 1, 'the explicit save is unchanged');
  assert.equal(opened.draft.project.regions.length, 2, 'the draft has the newer edit');
  assert.equal(opened.draft.baseRevision, 1);
  await restarted.discard(created.id);
  assert.equal((await restarted.open(created.id)).draft, null);
  const assets = await fs.readdir(path.join(lib.root, 'projects', created.id, 'assets'));
  assert.deepEqual(assets, [a.file], 'discarding the draft collects audio only it referenced');
});

test('a never-saved project is removed entirely by Discard; Save as copy duplicates only referenced audio', async () => {
  const { store, lib } = await setup();
  const scratch = await store.create('Scratch');
  await store.addAsset(scratch.id, wav(0.2));
  await store.discard(scratch.id);
  assert.equal(lib.state.projects.length, 0);
  await assert.rejects(fs.access(path.join(lib.root, 'projects', scratch.id)));
  const original = await store.create('Original');
  const used = await store.addAsset(original.id, wav(0.3)); await store.addAsset(original.id, wav(0.4));
  const saved = await store.save(original.id, withRegion(original, used));
  const copy = await store.saveCopy(original.id, saved, 'Original copy');
  assert.notEqual(copy.id, original.id);
  assert.deepEqual(await fs.readdir(path.join(lib.root, 'projects', copy.id, 'assets')), [used.file]);
  await store.remove(original.id);
  assert.deepEqual((await store.open(copy.id)).project.regions.length, 1, 'the copy owns its audio after the original is deleted');
});

test('project audio stays valid after the pad and capture it came from are deleted', async () => {
  const { store, lib } = await setup();
  const capture = await lib.addCapture(wav(1), 1, 'Cap');
  const pad = await lib.importBuffer('Pad', wav(1));
  const project = await store.create('Owned');
  const bytes = await lib.readCapture(capture.added);
  const asset = await store.addAsset(project.id, bytes, { origin: { kind: 'capture', id: capture.added } });
  await store.save(project.id, withRegion(project, asset));
  await lib.removeCapture(capture.added); await lib.remove(pad.added[0]);
  assert.deepEqual(await store.readAsset(project.id, asset.id), bytes);
});

test('startup garbage-collects unreferenced audio and interrupted creations, and the 100-project limit holds', async () => {
  const { store, lib, root } = await setup();
  const project = await store.create('GC');
  const keep = await store.addAsset(project.id, wav(0.1)), orphan = await store.addAsset(project.id, wav(0.1));
  await store.save(project.id, withRegion(project, keep));
  const stray = path.join(root, 'projects', crypto.randomUUID()); await fs.mkdir(stray);
  const again = new ProjectStore(lib); await again.init();
  assert.deepEqual(await fs.readdir(path.join(root, 'projects', project.id, 'assets')), [keep.file]);
  await assert.rejects(fs.access(stray));
  assert.ok(!(await fs.readdir(path.join(root, 'projects', project.id, 'assets'))).includes(orphan.file));
  lib.state.projects.push(...Array.from({ length: 99 }, () => ({ id: crypto.randomUUID(), name: 'x', createdAt: 0, updatedAt: 0, revision: 1, saved: true })));
  await assert.rejects(store.create('One too many'), /100 projects/);
});
