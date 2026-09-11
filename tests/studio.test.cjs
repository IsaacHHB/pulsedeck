const { test } = require('node:test');
const assert = require('node:assert/strict');
const model = import('../studio-model.js');

async function project() {
    const m = await model;
    let p = m.newProject('Test');
    p = m.addAsset(p, { id: 'a1', file: 'a1.wav', name: 'Tone A', duration: 1, channels: 1 });
    p = m.addAsset(p, { id: 'a2', file: 'a2.wav', name: 'Tone B', duration: 2, channels: 2 });
    return { m, p };
}

test('append concatenates on one track; layer stacks on a free track; the timeline length is the last region end', async () => {
    const { m, p: base } = await project();
    let { project: p } = m.placeAsset(base, { assetId: 'a1', mode: 'append' });
    ({ project: p } = m.placeAsset(p, { assetId: 'a2', mode: 'append' }));
    assert.deepEqual(p.regions.map(r => [r.atSeconds, r.outSeconds]), [[0, 1], [1, 2]]);
    ({ project: p } = m.placeAsset(p, { assetId: 'a1', mode: 'layer', playhead: 0.5 }));
    assert.equal(p.tracks.length, 2);
    assert.equal(p.regions[2].trackId, p.tracks[1].id);
    assert.equal(m.timelineDuration(p), 3);
    assert.deepEqual(m.renderRange(p), { startSeconds: 0, endSeconds: 3 });
});

test('insert at the playhead ripples later audio and splits a region under the playhead', async () => {
    const { m, p: base } = await project();
    let { project: p } = m.placeAsset(base, { assetId: 'a2', mode: 'append' });   // 0–2
    ({ project: p } = m.placeAsset(p, { assetId: 'a1', mode: 'append' }));        // 2–3
    ({ project: p } = m.placeAsset(p, { assetId: 'a1', mode: 'insert', playhead: 1, bounds: { inSeconds: 0.25, outSeconds: 0.75 } }));
    const spans = p.regions.map(r => [r.assetId, r.atSeconds, m.regionEnd(r), r.inSeconds]).sort((a, b) => a[1] - b[1]);
    assert.deepEqual(spans, [['a2', 0, 1, 0], ['a1', 1, 1.5, 0.25], ['a2', 1.5, 2.5, 1], ['a1', 2.5, 3.5, 0]]);
});

test('split, duplicate, trims, and removal keep sample-accurate nondestructive bounds', async () => {
    const { m, p: base } = await project();
    let { project: p, regionId } = m.placeAsset(base, { assetId: 'a2', mode: 'append', bounds: { fadeInMs: 100, fadeOutMs: 200 } });
    const split = m.splitRegion(p, regionId, 0.8);
    p = split.project;
    const [left, right] = p.regions;
    assert.deepEqual([left.inSeconds, left.outSeconds, left.fadeInMs, left.fadeOutMs], [0, 0.8, 100, 0]);
    assert.deepEqual([right.atSeconds, right.inSeconds, right.outSeconds, right.fadeInMs, right.fadeOutMs], [0.8, 0.8, 2, 0, 200]);
    assert.throws(() => m.splitRegion(p, right.id, 0.8), /inside/);
    const dup = m.duplicateRegion(p, right.id); p = dup.project;
    assert.equal(p.regions.at(-1).atSeconds, 2);
    p = m.updateRegion(p, left.id, { inSeconds: 0.1, gainDb: -6, pan: -1 });
    assert.throws(() => m.updateRegion(p, left.id, { outSeconds: 5 }), /past the end/);
    assert.throws(() => m.updateRegion(p, left.id, { gainDb: 20 }), /gain/);
    assert.throws(() => m.updateRegion(p, left.id, { pan: 2 }), /Pan/);
    assert.throws(() => m.updateRegion(p, left.id, { atSeconds: 179.9 }), /3 minutes/);
    assert.throws(() => m.updateRegion(p, left.id, { atSeconds: NaN }), /numbers/);
    p = m.removeRegion(p, dup.regionId);
    assert.equal(p.regions.length, 2);
});

test('mute and solo choose audible tracks; limits for tracks and regions are enforced', async () => {
    const { m, p: base } = await project();
    let p = base;
    for (let i = 1; i < 8; i++) p = m.addTrack(p).project;
    assert.throws(() => m.addTrack(p), /8 tracks/);
    p = m.updateTrack(p, p.tracks[1].id, { solo: true });
    p = m.updateTrack(p, p.tracks[2].id, { solo: true, mute: true });
    assert.deepEqual([...m.audibleTrackIds(p)], [p.tracks[1].id]);
    p = m.updateTrack(p, p.tracks[1].id, { solo: false }); p = m.updateTrack(p, p.tracks[2].id, { solo: false });
    p = m.updateTrack(p, p.tracks[0].id, { mute: true });
    assert.equal(m.audibleTrackIds(p).size, 6, "track 3 stays muted, track 1 is now muted");
    let q = base;
    for (let i = 0; i < 64; i++) q = m.placeAsset(q, { assetId: 'a1', mode: 'append', bounds: { inSeconds: 0, outSeconds: 0.5 } }).project;
    assert.throws(() => m.placeAsset(q, { assetId: 'a1', mode: 'append' }), /64 regions/);
});

test('undo/redo keeps 50+ small snapshots without audio and reports assets still needed by history', async () => {
    const { m, p: base } = await project();
    const history = new m.History();
    let p = base;
    for (let i = 0; i < 60; i++) { history.record(p); p = m.placeAsset(p, { assetId: i % 2 ? 'a1' : 'a2', mode: 'append', bounds: { inSeconds: 0, outSeconds: 0.01 } }).project; }
    assert.equal(p.regions.length, 60);
    for (let i = 0; i < 55; i++) p = history.undo(p);
    assert.equal(p.regions.length, 5);
    for (let i = 0; i < 3; i++) p = history.redo(p);
    assert.equal(p.regions.length, 8);
    assert.ok(history.assets().has('a1') && history.assets().has('a2'));
    history.record(p); assert.equal(history.canRedo, false, 'a new edit clears redo');
    assert.ok(JSON.stringify(history.past).length < 200000);
});

test('snapping uses a 10 ms grid and optional nearby region edges', async () => {
    const { m } = await project();
    assert.equal(m.snapTime(1.23456), 1.23);
    assert.equal(m.snapTime(1.23456, { grid: false }), 1.23456);
    assert.equal(m.snapTime(1.98, { edges: [2.004], threshold: 0.05 }), 2.004);
    assert.equal(m.snapTime(1.5, { edges: [2.004], threshold: 0.05 }), 1.5);
    assert.equal(m.snapTime(-3), 0);
});

test('project validation rejects bad schema, missing assets, and bad export ranges; wav size math matches PCM16', async () => {
    const { m, p: base } = await project();
    let { project: p } = m.placeAsset(base, { assetId: 'a1', mode: 'append' });
    assert.equal(m.checkProject(p), p);
    assert.throws(() => m.checkProject({ ...p, schemaVersion: 2 }), /unsupported/);
    assert.throws(() => m.checkProject({ ...p, assets: [] }), /missing/);
    assert.throws(() => m.setExportRange(p, { startSeconds: 2, endSeconds: 1 }), /export range/);
    p = m.setExportRange(p, { startSeconds: 0.25, endSeconds: 0.5 });
    assert.deepEqual(m.renderRange(p), { startSeconds: 0.25, endSeconds: 0.5 });
    assert.equal(m.wavBytes(48000 * 180, 2), 44 + 48000 * 180 * 4);
    assert.ok(m.wavBytes(48000 * 180, 2) > m.STUDIO_LIMITS.padBytes, 'a 3-minute stereo render exceeds the 30 MB pad limit');
});
