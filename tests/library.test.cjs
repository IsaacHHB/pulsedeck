const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Library } = require('../library.cjs');
async function fixture() {
  const base = path.join(__dirname, '..', 'test-results'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'library-'));
  const source = path.join(root, 'original.mp3'); await fs.writeFile(source, Buffer.from([73, 68, 51, 4]));
  const lib = new Library(path.join(root, 'data')); await lib.init();
  return { root, source, lib };
}
test('imported audio is copied, survives source deletion and reload, and stays local', async () => {
  const { lib, source } = await fixture(); const result = await lib.importFiles([source]);
  assert.equal(result.added.length, 1); await fs.unlink(source);
  const reload = new Library(lib.root); await reload.init();
  assert.deepEqual(await reload.read(result.added[0]), Buffer.from([73, 68, 51, 4]));
  assert.equal(reload.state.clips[0].hotkey, 'Control+Alt+1');
});
test('imports reject unsupported files, missing files, empty files, and files over 30 MB', async () => {
  const { lib, root } = await fixture();
  const empty = path.join(root, 'empty.wav'), large = path.join(root, 'large.mp3'); await fs.writeFile(empty, '');
  const handle = await fs.open(large, 'w'); await handle.truncate(31 * 1024 * 1024); await handle.close();
  const result = await lib.importFiles([path.join(root, 'script.exe'), path.join(root, 'missing.mp3'), empty, large]);
  assert.equal(result.errors.length, 4); assert.equal(result.clips.length, 0);
});
test('editing rejects positional-key takeover, reserved keys, and collisions; clamps volume', async () => {
  const { lib, source } = await fixture(); await lib.importFiles(Array(12).fill(source));
  const clips = lib.state.clips; const [a, b] = clips; const eleventh = clips[10], twelfth = clips[11];
  assert.deepEqual(clips.slice(0, 10).map(c => c.hotkey), ['Control+Alt+1', 'Control+Alt+2', 'Control+Alt+3', 'Control+Alt+4', 'Control+Alt+5', 'Control+Alt+6', 'Control+Alt+7', 'Control+Alt+8', 'Control+Alt+9', 'Control+Alt+0']);
  assert.equal(eleventh.hotkey, '');
  await assert.rejects(lib.edit(b.id, { hotkey: a.hotkey }), /follow pad order/);
  await assert.rejects(lib.edit(eleventh.id, { hotkey: 'Control+Alt+3' }), /follow pad order/);
  await assert.rejects(lib.edit(b.id, { hotkey: 'Control+Shift+Q' }), /first ten/);
  await assert.rejects(lib.edit(eleventh.id, { hotkey: 'Control+Alt+M' }), /reserved/);
  await assert.rejects(lib.edit(eleventh.id, { hotkey: 'Control+Alt+O' }), /reserved/);
  await assert.rejects(lib.edit(eleventh.id, { hotkey: 'Control+X' }), /Use Ctrl/);
  await lib.edit(eleventh.id, { hotkey: 'Control+Shift+Q' });
  await assert.rejects(lib.edit(twelfth.id, { hotkey: 'Control+Shift+Q' }), /another sound/);
  await lib.edit(a.id, { volume: 999, name: ' Renamed ', loop: true });
  assert.equal(a.volume, 150); assert.equal(a.name, 'Renamed'); assert.equal(a.loop, true);
});
test('reordering moves pads and their positional shortcuts follow the new order', async () => {
  const { lib, source } = await fixture(); await lib.importFiles(Array(11).fill(source));
  const ids = lib.state.clips.map(c => c.id);
  await lib.edit(ids[10], { hotkey: 'Control+Shift+Z' });
  const moved = [ids[10], ...ids.slice(0, 10)];
  await lib.reorder(moved);
  assert.deepEqual(lib.state.clips.map(c => c.id), moved);
  assert.equal(lib.state.clips[0].hotkey, 'Control+Alt+1');
  assert.equal(lib.state.clips[10].hotkey, '', 'a pad pushed past tenth loses its digit key');
  await assert.rejects(lib.reorder(ids.slice(1)), /changed/);
  const reload = new Library(lib.root); await reload.init();
  assert.deepEqual(reload.state.clips.map(c => c.id), moved);
});
test('serialized saves remain valid and retain the newest settings', async () => {
  const { lib } = await fixture(); const saves = [];
  for (let n = 0; n < 25; n++) { lib.updateSettings({ boardVolume: n }); saves.push(lib.commit()); }
  await Promise.all(saves); const disk = JSON.parse(await fs.readFile(path.join(lib.root, 'library.json'), 'utf8'));
  assert.equal(disk.settings.boardVolume, 24);
});
test('deleting a clip preserves original audio and rejects arbitrary path reads', async () => {
  const { lib, source } = await fixture(); const { added } = await lib.importFiles([source]);
  await assert.rejects(lib.read('../library.json'), /no longer/); await lib.remove(added[0]);
  assert.equal(lib.state.clips.length, 0); assert.ok((await fs.stat(source)).isFile());
  await assert.rejects(lib.read(added[0]), /no longer/);
});
test('corrupt state is preserved for recovery, with a visible warning', async () => {
  const { lib } = await fixture(); await fs.writeFile(path.join(lib.root, 'library.json'), '{broken');
  const reload = new Library(lib.root); const result = await reload.init(); assert.match(result.warning, /could not be read/);
  assert.ok((await fs.readdir(lib.root)).some(name => name.startsWith('library-recovery-')));
});
