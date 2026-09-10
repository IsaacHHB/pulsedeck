const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function recorder(seconds = 60) {
    let Recorder;
    const messages = [];
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../replay-worklet.js'), 'utf8'), {
        sampleRate: 48000, Float32Array,
        AudioWorkletProcessor: class { constructor() { this.port = { postMessage: data => messages.push(data) }; } },
        registerProcessor: (_, type) => { Recorder = type; }
    });
    const instance = new Recorder({ processorOptions: { capacity: seconds * 48000 } });
    return { instance, dump(seconds = 60) { instance.dump(seconds, 1); return messages.at(-1).samples; } };
}

test('60-second replay retains exactly the newest samples in chronological order across wraparound', () => {
    const { instance, dump } = recorder();
    for (let sec = 0; sec < 73; sec++) instance.process([[new Float32Array(48000).fill(sec / 100)]]);
    const samples = dump();
    assert.equal(samples.length, 60 * 48000);
    for (let sec = 0; sec < 60; sec++) {
        assert.ok(Math.abs(samples[sec * 48000] - (sec + 13) / 100) < 1e-6);
        assert.ok(Math.abs(samples[(sec + 1) * 48000 - 1] - (sec + 13) / 100) < 1e-6);
    }
    assert.deepEqual(dump(), samples, 'saving does not consume or clear the rolling buffer');
});

test('startup saves only available audio; silence ages old audio out of the last minute', () => {
    const { instance, dump } = recorder();
    instance.process([[new Float32Array(48000).fill(0.4)]]);
    assert.equal(dump().length, 48000);
    for (let i = 0; i < 60 * 48000 / 128; i++) instance.process([[], []], [[new Float32Array(128)]]);
    const samples = dump();
    assert.equal(samples.length, 60 * 48000);
    assert.ok(samples.every(n => n === 0), 'stale sound must not survive a minute of silence');
});

test('stereo system audio is averaged and optional microphone is added once', () => {
    const { instance, dump } = recorder();
    instance.process([[new Float32Array(128).fill(0.2), new Float32Array(128).fill(0.6)], [new Float32Array(128).fill(0.1)]]);
    assert.ok(dump().every(n => Math.abs(n - 0.5) < 1e-6));
});
