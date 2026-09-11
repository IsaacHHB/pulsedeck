const { test } = require('node:test');
const assert = require('node:assert/strict');
const region = import('../playback-region.js');

test('full-source regions resolve to every decoded frame; null end is the real end, not zero', async () => {
    const { resolveRegion, playedDuration } = await region;
    const r = resolveRegion(null, { length: 48000 * 60, sampleRate: 48000 });
    assert.equal(r.startFrame, 0); assert.equal(r.endFrame, 48000 * 60); assert.ok(r.full); assert.equal(r.warning, '');
    const open = resolveRegion({ startSeconds: 10, endSeconds: null, fadeInMs: 0, fadeOutMs: 0 }, { length: 48000 * 60, sampleRate: 48000 });
    assert.equal(open.duration, 50);
    assert.equal(playedDuration({ duration: 60, playback: { startSeconds: 10, endSeconds: null } }), 50);
    assert.equal(playedDuration({ duration: 0, playback: null }), null, 'unknown duration stays unknown instead of zero');
});

test('the 12.500–17.250 s selection resolves to exact sample frames at 48 and 44.1 kHz', async () => {
    const { resolveRegion } = await region;
    for (const rate of [48000, 44100]) {
        const r = resolveRegion({ startSeconds: 12.5, endSeconds: 17.25, fadeInMs: 0, fadeOutMs: 0 }, { length: rate * 60, sampleRate: rate });
        assert.equal(r.startFrame, Math.round(12.5 * rate)); assert.equal(r.endFrame, Math.round(17.25 * rate));
        assert.ok(Math.abs(r.duration - 4.75) < 1 / rate);
    }
});

test('stale ends clamp to a shorter replacement; regions outside the audio fall back to full with a warning', async () => {
    const { resolveRegion } = await region;
    const stale = resolveRegion({ startSeconds: 5, endSeconds: 50, fadeInMs: 0, fadeOutMs: 0 }, { length: 48000 * 20, sampleRate: 48000 });
    assert.equal(stale.endFrame, 48000 * 20); assert.ok(stale.clamped); assert.equal(stale.warning, '');
    const outside = resolveRegion({ startSeconds: 30, endSeconds: 40, fadeInMs: 0, fadeOutMs: 0 }, { length: 48000 * 20, sampleRate: 48000 });
    assert.ok(outside.full); assert.match(outside.warning, /whole sound/);
    const inverted = resolveRegion({ startSeconds: 9, endSeconds: 3, fadeInMs: 0, fadeOutMs: 0 }, { length: 48000 * 20, sampleRate: 48000 });
    assert.ok(inverted.full); assert.ok(inverted.warning);
    const garbage = resolveRegion({ startSeconds: 'x', endSeconds: 3 }, { length: 48000, sampleRate: 48000 });
    assert.ok(garbage.full); assert.ok(garbage.warning);
});

test('a one-sample region is valid; fades are scaled to fit a clamped region', async () => {
    const { resolveRegion, validatePlayback } = await region;
    const one = resolveRegion({ startSeconds: 1, endSeconds: 1 + 1 / 48000, fadeInMs: 0, fadeOutMs: 0 }, { length: 96000, sampleRate: 48000 });
    assert.equal(one.frames, 1);
    assert.deepEqual(validatePlayback({ startSeconds: 1, endSeconds: 1 + 1 / 48000, fadeInMs: 0, fadeOutMs: 0 }, 2).startSeconds, 1);
    const fades = resolveRegion({ startSeconds: 0, endSeconds: 10, fadeInMs: 3000, fadeOutMs: 3000 }, { length: 48000 * 4, sampleRate: 48000 });
    assert.ok(fades.fadeIn + fades.fadeOut <= fades.duration + 1e-9);
});

test('new edits reject NaN, infinities, negative and inverted ranges, oversized fades, and ends past the source', async () => {
    const { validatePlayback } = await region;
    for (const bad of [
        { startSeconds: NaN }, { startSeconds: Infinity }, { startSeconds: -1 }, { startSeconds: 5, endSeconds: 5 }, { startSeconds: 5, endSeconds: 4 },
        { startSeconds: 0, endSeconds: 1, fadeInMs: 6000 }, { startSeconds: 0, endSeconds: 1, fadeInMs: 600, fadeOutMs: 600 }, { startSeconds: 0, endSeconds: 1, fadeInMs: -1 }, 'x'
    ]) assert.throws(() => validatePlayback(bad), undefined, JSON.stringify(bad));
    assert.throws(() => validatePlayback({ startSeconds: 0, endSeconds: 70 }, 60), /past the end/);
    assert.throws(() => validatePlayback({ startSeconds: 61, endSeconds: null }, 60), /past the end/);
    assert.deepEqual(validatePlayback(null), { startSeconds: 0, endSeconds: null, fadeInMs: 0, fadeOutMs: 0 });
});

test('envelopes include user fades and an internal anti-click ramp without persisting it', async () => {
    const { envelopePoints, ANTI_CLICK_SECONDS } = await region;
    const plain = envelopePoints(1, 0, 0);
    assert.deepEqual(plain[0], [0, 0]); assert.ok(Math.abs(plain[1][0] - ANTI_CLICK_SECONDS) < 1e-12); assert.deepEqual(plain.at(-1), [1, 0]);
    const faded = envelopePoints(2, 0.5, 0.25);
    assert.deepEqual(faded, [[0, 0], [0.5, 1], [1.75, 1], [2, 0]]);
    const resumed = envelopePoints(2, 0.5, 0.25, { from: 1 });
    assert.deepEqual(resumed[0], [1, 1], 'resuming inside a region starts at the envelope level there');
    const raw = envelopePoints(1, 0, 0, { antiClick: false });
    assert.deepEqual(raw, [[0, 1], [1, 1]]);
});
