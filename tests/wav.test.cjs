const { test } = require('node:test');
const assert = require('node:assert/strict');
const wav = import('../wav.js');
const { parseWav, assertCanonicalWav } = require('../wav-header.cjs');

test('mono encoding keeps its original layout: 44-byte header, PCM16, block align 2', async () => {
    const { encodeWav } = await wav;
    const bytes = Buffer.from(encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]), 44100));
    const info = parseWav(bytes);
    assert.equal(bytes.length, 44 + 7 * 2);
    assert.equal(bytes.readUInt32LE(4), bytes.length - 8, 'RIFF length');
    assert.deepEqual([info.format, info.channels, info.sampleRate, info.blockAlign, info.bitsPerSample, info.frames], [1, 1, 44100, 2, 16, 7]);
    assert.equal(bytes.readUInt32LE(28), 44100 * 2, 'byte rate');
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(i => bytes.readInt16LE(44 + i * 2)), [0, 16383, -16384, 32767, -32768, 32767, -32768]);
});

test('stereo encoding interleaves distinct channels with block align 4 and a correct byte rate', async () => {
    const { encodeWavChannels, encodeWav } = await wav;
    const left = new Float32Array([0.25, 0.5, 0.75]), right = new Float32Array([-0.25, -0.5, -0.75]);
    const bytes = Buffer.from(encodeWavChannels([left, right], 48000));
    const info = assertCanonicalWav(bytes);
    assert.deepEqual([info.channels, info.blockAlign, info.frames, info.sampleRate], [2, 4, 3, 48000]);
    assert.equal(bytes.readUInt32LE(28), 48000 * 4);
    assert.equal(bytes.readUInt32LE(40), 12, 'data length');
    const frames = [0, 1, 2].map(i => [bytes.readInt16LE(44 + i * 4), bytes.readInt16LE(46 + i * 4)]);
    assert.deepEqual(frames, [[8191, -8192], [16383, -16384], [24575, -24576]]);
    assert.deepEqual(Buffer.from(encodeWav(left, 48000)), Buffer.from(encodeWavChannels([left], 48000)), 'mono callers are unchanged');
    assert.throws(() => encodeWavChannels([left, right, left], 48000), /mono and stereo/);
    assert.throws(() => encodeWavChannels([left, new Float32Array(2)], 48000), /same length/);
});

test('the main-process WAV check rejects non-canonical, truncated, and empty audio', async () => {
    const { encodeWavChannels } = await wav;
    const good = Buffer.from(encodeWavChannels([new Float32Array(480)], 48000));
    assert.equal(assertCanonicalWav(good).duration, 0.01);
    assert.throws(() => assertCanonicalWav(Buffer.from(encodeWavChannels([new Float32Array(480)], 44100))), /48000/);
    assert.throws(() => assertCanonicalWav(Buffer.from(encodeWavChannels([new Float32Array(0)], 48000))), /no samples/);
    const truncated = Buffer.from(good); truncated.writeUInt32LE(99999, 40);
    assert.throws(() => assertCanonicalWav(truncated), /truncated/, 'declared data must exist in full');
    assert.throws(() => assertCanonicalWav(good.subarray(0, good.length - 2)), /truncated/);
    const badAlign = Buffer.from(good); badAlign.writeUInt16LE(4, 32);
    assert.throws(() => assertCanonicalWav(badAlign), /alignment/);
    const badRate = Buffer.from(good); badRate.writeUInt32LE(7, 28);
    assert.throws(() => assertCanonicalWav(badRate), /byte rate/);
    assert.throws(() => parseWav(Buffer.from('RIFF....WAVEjunk')), /not a WAV/);
});
