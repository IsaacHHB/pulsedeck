const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Library, SchemaError } = require('../library.cjs');

const base = path.join(__dirname, '..', 'test-results');
async function fixture() {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'library2-'));
  const source = path.join(root, 'original.mp3'); await fs.writeFile(source, Buffer.from([73, 68, 51, 4]));
  const lib = new Library(path.join(root, 'data')); await lib.init();
  return { root, source, lib };
}
const hash = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
function tinyWav(seconds = 1, rate = 48000) {
  const frames = Math.round(seconds * rate), data = Buffer.alloc(44 + frames * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) data.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), 44 + i * 2);
  return data;
}
module.exports = { tinyWav };

test('an unversioned library migrates with defaults, keeps ids/order/settings/files, and saves a pre-migration backup', async () => {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'migrate-')); await fs.mkdir(path.join(root, 'clips'), { recursive: true });
  const a = crypto.randomUUID(), b = crypto.randomUUID(), cap = crypto.randomUUID();
  const legacy = {
    clips: [
      { id: a, file: a + '.mp3', name: 'Horn', color: 'blue', volume: 90, loop: true, hotkey: 'Control+Alt+1', duration: 2.5, loudness: -20, peak: 0.5, junk: { evil: true } },
      { id: b, file: b + '.wav', name: 'Bad region', color: 'pink', volume: 100, loop: false, hotkey: '', duration: 3, playback: { startSeconds: 4, endSeconds: 1 } }
    ],
    captures: [{ id: cap, file: cap + '.wav', name: 'Cap', duration: 5, createdAt: 1 }],
    settings: { boardVolume: 140, effect: 'robot', replaySeconds: 90, outputId: 'dev', overlay: { x: 1, y: 2, width: 300, height: 300, opacity: 0.8 } }
  };
  const original = JSON.stringify(legacy);
  await fs.writeFile(path.join(root, 'library.json'), original);
  await fs.writeFile(path.join(root, 'clips', a + '.mp3'), 'mp3');
  const lib = new Library(root); const snap = await lib.init();
  assert.deepEqual(snap.clips.map(c => c.id), [a, b]);
  assert.equal(snap.clips[0].hotkey, 'Control+Alt+1'); assert.equal(snap.clips[1].hotkey, 'Control+Alt+2');
  assert.equal(snap.clips[0].loop, true); assert.equal(snap.clips[0].volume, 90); assert.equal(snap.clips[0].loudness, -20);
  assert.equal(snap.settings.boardVolume, 140); assert.equal(snap.settings.effect, 'robot'); assert.equal(snap.settings.replaySeconds, 90); assert.equal(snap.settings.overlay.width, 300);
  assert.deepEqual(snap.settings.ducking, { enabled: false, threshold: -35, reduction: 12, attack: 20, hold: 150, release: 300 });
  assert.equal(snap.clips[0].triggerMode, 'toggle'); assert.equal(snap.clips[0].favorite, false); assert.deepEqual(snap.clips[0].tags, []); assert.equal(snap.clips[0].playback, null);
  assert.equal(snap.clips[1].playback, null); assert.match(snap.warning, /invalid playback region/);
  assert.deepEqual(snap.collections, []); assert.deepEqual(snap.queue, []); assert.equal(snap.captures[0].id, cap);
  const disk = JSON.parse(await fs.readFile(path.join(root, 'library.json'), 'utf8'));
  assert.equal(disk.schemaVersion, 2); assert.equal(disk.clips[0].junk, undefined, 'unknown fields are not carried forward');
  const backups = (await fs.readdir(root)).filter(n => n.startsWith('library-pre-migration-v1-'));
  assert.equal(backups.length, 1); assert.equal(await fs.readFile(path.join(root, backups[0]), 'utf8'), original);
  assert.equal(await fs.readFile(path.join(root, 'clips', a + '.mp3'), 'utf8'), 'mp3');
  const again = new Library(root); await again.init();
  assert.equal((await fs.readdir(root)).filter(n => n.startsWith('library-pre-migration-')).length, 1, 'a migrated library is not migrated twice');
});

test('a library from a newer PulseDeck is rejected and left byte-for-byte unchanged', async () => {
  const { lib } = await fixture(); const file = path.join(lib.root, 'library.json');
  const future = JSON.stringify({ schemaVersion: 99, clips: [], futureField: 1 });
  await fs.writeFile(file, future);
  await assert.rejects(new Library(lib.root).init(), error => error instanceof SchemaError && /newer version/.test(error.message));
  assert.equal(await fs.readFile(file, 'utf8'), future);
});

test('playback regions validate on edit, reset to full, invalidate region loudness, and never touch source bytes', async () => {
  const { lib, root } = await fixture(); const source = path.join(root, 'long.wav'); await fs.writeFile(source, tinyWav(3));
  const { added: [id] } = await lib.importFiles([source]); const file = path.join(lib.root, 'clips', lib.state.clips[0].file);
  const before = await hash(file);
  await lib.edit(id, { loudness: -20, peak: 0.4, analysisKey: 'full', duration: 3 });
  await lib.edit(id, { playback: { startSeconds: 1.25, endSeconds: 2.5, fadeInMs: 10, fadeOutMs: 30 } });
  let clip = lib.state.clips[0];
  assert.deepEqual(clip.playback, { startSeconds: 1.25, endSeconds: 2.5, fadeInMs: 10, fadeOutMs: 30 });
  assert.equal(clip.loudness, null, 'a region change invalidates loudness measured for the old region');
  for (const bad of [{ startSeconds: -1 }, { startSeconds: 2, endSeconds: 1 }, { startSeconds: 0, endSeconds: 0.01, fadeInMs: 20 }, { startSeconds: NaN }, { startSeconds: 0, fadeInMs: 9000 }, 'text']) {
    await assert.rejects(lib.edit(id, { playback: bad }), undefined, JSON.stringify(bad));
  }
  assert.equal(lib.state.clips[0].playback.startSeconds, 1.25, 'rejected edits leave the saved region alone');
  await lib.edit(id, { playback: { startSeconds: 0.5, endSeconds: 0.5 + 1 / 48000 } });
  assert.ok(lib.state.clips[0].playback.endSeconds > 0.5, 'a one-sample region is accepted');
  await lib.edit(id, { name: 'Renamed', color: 'orange', playback: null });
  clip = lib.state.clips[0];
  assert.equal(clip.playback, null); assert.equal(clip.name, 'Renamed'); assert.equal(clip.color, 'orange');
  assert.equal(await hash(file), before, 'source bytes are identical after multiple edits and a reset');
  const reload = new Library(lib.root); await reload.init(); assert.equal(reload.state.clips[0].name, 'Renamed');
});

test('a capture becomes an expandable full-source pad that survives deleting or evicting the capture', async () => {
  const { lib } = await fixture();
  const bytes = tinyWav(2);
  const { added: captureId } = await lib.addCapture(bytes, 2, 'Friend');
  const result = await lib.captureToPad(captureId, 'Friend line', { startSeconds: 0.5, endSeconds: 1.5, fadeInMs: 0, fadeOutMs: 0 });
  const clip = result.clips.find(c => c.id === result.added[0]);
  assert.deepEqual(clip.playback, { startSeconds: 0.5, endSeconds: 1.5, fadeInMs: 0, fadeOutMs: 0 });
  assert.equal(clip.source.kind, 'capture'); assert.equal(clip.source.captureId, captureId); assert.equal(clip.duration, 2);
  for (let i = 0; i < 41; i++) await lib.addCapture(tinyWav(0.01), 0.01, 'filler');
  assert.ok(!lib.state.captures.some(c => c.id === captureId), 'the original capture was evicted');
  assert.equal((await fs.readdir(path.join(lib.root, 'captures'))).length, 40, 'evicted capture files are removed');
  assert.deepEqual(await lib.read(clip.id), bytes, 'the pad owns a full copy');
  await lib.edit(clip.id, { playback: { startSeconds: 0, endSeconds: 2 } });
  assert.equal(lib.state.clips[0].playback.endSeconds, 2, 'the pad can be expanded beyond the original selection');
  await assert.rejects(lib.captureToPad(captureId, 'gone', null), /no longer available/);
});

test('a failed commit leaves the last valid library in memory and on disk, and removes only new files', async () => {
  const { lib, source } = await fixture(); await lib.importFiles([source]);
  const good = await fs.readFile(path.join(lib.root, 'library.json'), 'utf8');
  await fs.mkdir(path.join(lib.root, 'library.json.tmp'));
  await assert.rejects(lib.importBuffer('New', tinyWav(0.1)));
  assert.equal(lib.state.clips.length, 1);
  assert.equal((await fs.readdir(path.join(lib.root, 'clips'))).length, 1, 'the staged audio file was removed');
  await assert.rejects(lib.edit(lib.state.clips[0].id, { name: 'Changed' }));
  assert.equal(lib.state.clips[0].name, 'original');
  assert.equal(await fs.readFile(path.join(lib.root, 'library.json'), 'utf8'), good);
  await fs.rmdir(path.join(lib.root, 'library.json.tmp'));
});

test('generated pads validate WAV bytes and report the byte limit with the actual size', async () => {
  const { lib } = await fixture();
  await assert.rejects(lib.importBuffer('Bad', Buffer.from('not a wav file at all, just text padding padding padding')), /not a WAV/);
  await assert.rejects(lib.importBuffer('Empty', tinyWav(0)), /no audio/);
  await assert.rejects(lib.importBuffer('Big', Buffer.alloc(31 * 1024 * 1024)), /31\.0 MB/);
  const ok = await lib.importBuffer('Ok', tinyWav(0.5), '.wav', { source: { kind: 'recording' }, playback: { startSeconds: 0.1, endSeconds: null } });
  const clip = ok.clips.at(-1); assert.equal(clip.source.kind, 'recording'); assert.equal(clip.duration, 0.5); assert.equal(clip.playback.startSeconds, 0.1);
});

test('concurrent mutations are serialized and every one is persisted', async () => {
  const { lib } = await fixture();
  await Promise.all(Array.from({ length: 12 }, (_, i) => lib.importBuffer(`Sound ${i}`, tinyWav(0.05))));
  assert.equal(lib.state.clips.length, 12);
  const reload = new Library(lib.root); await reload.init();
  assert.equal(reload.state.clips.length, 12);
  assert.deepEqual(reload.state.clips.slice(0, 10).map(c => c.hotkey), lib.state.clips.slice(0, 10).map(c => c.hotkey));
});
