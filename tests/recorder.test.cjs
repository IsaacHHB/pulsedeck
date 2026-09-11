const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function recorder(maxFrames) {
    let Processor;
    const messages = [];
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../recorder-worklet.js'), 'utf8'), {
        sampleRate: 48000, Float32Array, Number,
        AudioWorkletProcessor: class { constructor() { this.port = { postMessage: data => messages.push(data) }; } },
        registerProcessor: (_, type) => { Processor = type; }
    });
    const node = new Processor({ processorOptions: { maxFrames } });
    const send = type => node.port.onmessage({ data: { type } });
    const block = (value, channels = 1) => [Array.from({ length: channels }, (_, c) => new Float32Array(128).fill(typeof value === 'function' ? value(c) : value))];
    const samples = () => { const parts = messages.filter(m => m.type === 'chunk').map(m => m.samples); const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
    return { node, messages, send, block, samples };
}

test('nothing is recorded before start; chunks are bounded and transferred in order', () => {
    const r = recorder(48000 * 180);
    assert.equal(r.node.process(r.block(0.5)), true);
    assert.equal(r.messages.length, 0);
    r.send('start');
    for (let i = 0; i < 300; i++) r.node.process(r.block(i / 1000));
    const chunks = r.messages.filter(m => m.type === 'chunk');
    assert.ok(chunks.length >= 2 && chunks.every(c => c.samples.length === 16384), 'full chunks only while recording');
    r.send('stop');
    const done = r.messages.at(-1);
    assert.deepEqual([done.type, done.reason, done.frames], ['done', 'stopped', 300 * 128]);
    const all = r.samples();
    assert.equal(all.length, 300 * 128, 'the partial last chunk is flushed on stop');
    assert.ok(Math.abs(all[128 * 7] - 0.007) < 1e-6 && Math.abs(all.at(-1) - 0.299) < 1e-6);
});

test('the hard frame limit ends the take with a limit reason and keeps every recorded frame', () => {
    const r = recorder(1000);
    r.send('start');
    let running = true;
    for (let i = 0; i < 20 && running; i++) running = r.node.process(r.block(0.1));
    assert.equal(running, false);
    const done = r.messages.find(m => m.type === 'done');
    assert.deepEqual([done.reason, done.frames], ['limit', 1000]);
    assert.equal(r.samples().length, 1000);
    r.send('start'); r.node.process(r.block(0.2));
    assert.equal(r.samples().length, 1000, 'a finished recorder never restarts');
});

test('stereo effect output is mixed to mono, invalid samples are contained, and silence advances time', () => {
    const r = recorder(48000);
    r.send('start');
    r.node.process(r.block(c => (c ? 0.6 : 0.2), 2));
    r.node.process([[new Float32Array(128).fill(NaN)]]);
    r.node.process([[]]);
    r.send('stop');
    const all = r.samples();
    assert.equal(all.length, 384);
    assert.ok(all.subarray(0, 128).every(v => Math.abs(v - 0.4) < 1e-6));
    assert.ok(all.subarray(128).every(v => v === 0));
});
