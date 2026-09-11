const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Library } = require('../library.cjs');

async function fixture(count = 12) {
  const base = path.join(__dirname, '..', 'test-results'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'organize-'));
  const source = path.join(root, 'a.mp3'); await fs.writeFile(source, Buffer.from([73, 68, 51, 4]));
  const lib = new Library(path.join(root, 'data')); await lib.init();
  await lib.importFiles(Array(count).fill(source));
  return { lib, ids: lib.state.clips.map(c => c.id) };
}
const reload = async lib => { const again = new Library(lib.root); await again.init(); return again; };

test('favorites and tags persist; tags are unique case-insensitively, trimmed, and limited', async () => {
  const { lib, ids } = await fixture();
  await lib.edit(ids[0], { favorite: true, tags: [' Hype ', 'hype', 'Intro', 'HYPE', ''] });
  assert.deepEqual(lib.state.clips[0].tags, ['Hype', 'Intro']);
  await assert.rejects(lib.edit(ids[0], { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }), /20 tags/);
  await assert.rejects(lib.edit(ids[0], { tags: ['x'.repeat(33)] }), /32 characters/);
  await assert.rejects(lib.edit(ids[0], { tags: 'not a list' }), /list/);
  const again = await reload(lib);
  assert.equal(again.state.clips[0].favorite, true); assert.deepEqual(again.state.clips[0].tags, ['Hype', 'Intro']);
});

test('collections hold ordered clip references without duplicating audio; reorder and removal stay local', async () => {
  const { lib, ids } = await fixture();
  const { created } = await lib.createCollection('Stream intro', [ids[3], ids[1], ids[3], 'missing']);
  let collection = lib.state.collections[0];
  assert.deepEqual(collection.clipIds, [ids[3], ids[1]], 'duplicates and missing references are dropped');
  await lib.addToCollection(created, [ids[5], ids[1]]);
  assert.deepEqual(lib.state.collections[0].clipIds, [ids[3], ids[1], ids[5]]);
  await lib.reorderCollection(created, [ids[5], ids[3], ids[1]]);
  assert.deepEqual(lib.state.collections[0].clipIds, [ids[5], ids[3], ids[1]]);
  await assert.rejects(lib.reorderCollection(created, [ids[5], ids[3]]), /changed/);
  assert.deepEqual(lib.state.clips.map(c => c.id), ids, 'collection order never changes global order');
  assert.deepEqual(lib.state.clips.slice(0, 10).map(c => c.hotkey), ['Control+Alt+1', 'Control+Alt+2', 'Control+Alt+3', 'Control+Alt+4', 'Control+Alt+5', 'Control+Alt+6', 'Control+Alt+7', 'Control+Alt+8', 'Control+Alt+9', 'Control+Alt+0'], 'slot shortcuts follow All sounds order');
  await lib.createCollection('Second', [ids[3]]);
  assert.equal((await fs.readdir(path.join(lib.root, 'clips'))).length, 12, 'a clip in two collections has one audio file');
  await lib.removeFromCollection(created, [ids[3]]);
  assert.deepEqual(lib.state.collections[0].clipIds, [ids[5], ids[1]]);
  await lib.remove(ids[5]);
  assert.deepEqual(lib.state.collections[0].clipIds, [ids[1]], 'deleting a clip cleans its references');
  await lib.renameCollection(created, 'Renamed');
  await lib.deleteCollection(created);
  assert.equal(lib.state.clips.length, 11, 'deleting a collection leaves its clips');
  await assert.rejects(lib.createCollection(''), /Name/);
  await assert.rejects(lib.createCollection('x'.repeat(61)), /60 characters/);
  for (let i = lib.state.collections.length; i < 50; i++) await lib.createCollection(`C${i}`);
  await assert.rejects(lib.createCollection('One more'), /50 collections/);
  const again = await reload(lib);
  assert.equal(again.state.collections.length, 50);
});

test('trigger modes and exclusive groups validate, persist, and clean up; loop + overlap is rejected', async () => {
  const { lib, ids } = await fixture(3);
  assert.equal(lib.state.clips[0].triggerMode, 'toggle', 'old clips default to toggle');
  await lib.edit(ids[0], { triggerMode: 'overlap' });
  await assert.rejects(lib.edit(ids[0], { loop: true }), /Looping sounds/);
  await assert.rejects(lib.edit(ids[1], { loop: true, triggerMode: 'overlap' }), /Looping sounds/);
  await lib.edit(ids[1], { loop: true, triggerMode: 'restart' });
  await assert.rejects(lib.edit(ids[1], { triggerMode: 'shuffle' }), /Toggle, Restart, or Overlap/);
  const { created: group } = await lib.createGroup('Music beds');
  await lib.edit(ids[1], { exclusiveGroupId: group }); await lib.edit(ids[2], { exclusiveGroupId: group });
  await assert.rejects(lib.edit(ids[0], { exclusiveGroupId: crypto.randomUUID() }), /no longer exists/);
  let again = await reload(lib);
  assert.deepEqual(again.state.clips.map(c => [c.triggerMode, c.exclusiveGroupId]), [['overlap', ''], ['restart', group], ['toggle', group]]);
  await lib.deleteGroup(group);
  assert.deepEqual(lib.state.clips.map(c => c.exclusiveGroupId), ['', '', '']);
  again = await reload(lib);
  assert.deepEqual(again.state.groups, []);
});

test('the queue stores up to 100 clip references (duplicates allowed) and restores them without playing', async () => {
  const { lib, ids } = await fixture(2);
  const entries = [ids[0], ids[1], ids[0]].map(clipId => ({ id: crypto.randomUUID(), clipId }));
  await lib.setQueue(entries);
  await assert.rejects(lib.setQueue(Array.from({ length: 101 }, () => ({ id: crypto.randomUUID(), clipId: ids[0] }))), /100/);
  await assert.rejects(lib.setQueue([{ id: 'x', clipId: ids[0] }]), /Invalid/);
  await lib.remove(ids[1]);
  const again = await reload(lib);
  assert.deepEqual(again.state.queue.map(q => q.clipId), [ids[0], ids[1], ids[0]], 'a deleted clip stays queued so it can be reported and skipped');
});
