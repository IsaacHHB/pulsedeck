const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const RATE = 48000;
function ducker(settings) {
    let Processor;
    const messages = [];
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ducking-worklet.js'), 'utf8'), {
        sampleRate: RATE, Math, Number,
        AudioWorkletProcessor: class { constructor() { this.port = { postMessage: data => messages.push(data) }; } },
        registerProcessor: (_, type) => { Processor = type; }
    });
    const node = new Processor({ processorOptions: { enabled: true, ...settings } });
    /** Runs `seconds` of a constant board signal and a microphone envelope `mic(t)` (amplitude of a sine). */
    function run(seconds, mic, board = 0.5) {
        const gains = [];
        for (let start = 0; start < seconds * RATE; start += 128) {
            const micBlock = new Float32Array(128), boardBlock = new Float32Array(128).fill(board);
            for (let i = 0; i < 128; i++) { const t = (node.t = (node.t || 0) + 1) / RATE; micBlock[i] = (mic ? mic(t) : 0) * Math.sin(2 * Math.PI * 200 * t); }
            const out = [new Float32Array(128), new Float32Array(128)];
            node.process([[boardBlock, boardBlock], mic === null ? [] : [micBlock]], [out]);
            gains.push(out[0][127] / board);
        }
        return gains;
    }
    return { node, run, messages, at: (gains, seconds) => gains[Math.min(gains.length - 1, Math.floor(seconds * RATE / 128))] };
}
const db = gain => 20 * Math.log10(gain);

test('speech above the threshold lowers the board by the reduction with the configured attack', () => {
    const d = ducker({ threshold: -35, reduction: 12, attack: 20, hold: 150, release: 300 });
    const gains = d.run(1, t => (t > 0.2 ? 0.2 : 0));
    assert.ok(Math.abs(d.at(gains, 0.15) - 1) < 1e-3, 'no ducking before speech');
    assert.ok(db(d.at(gains, 0.3)) < -11 && db(d.at(gains, 0.9)) > -12.01, `reaches −12 dB: ${db(d.at(gains, 0.3))}`);
    const halfway = gains.findIndex((g, i) => i * 128 / RATE > 0.2 && db(g) < -6) * 128 / RATE;
    assert.ok(halfway > 0.2 && halfway < 0.27, `attack is on the order of 20 ms (−6 dB at ${halfway.toFixed(3)} s)`);
});

test('quiet sound below the threshold does not duck; hold keeps the duck through short pauses; release returns smoothly', () => {
    const quiet = ducker({ threshold: -35, reduction: 12 });
    const q = quiet.run(0.5, () => 0.01); // about −43 dBFS
    assert.ok(q.every(g => Math.abs(g - 1) < 1e-3));
    const d = ducker({ threshold: -35, reduction: 12, attack: 5, hold: 400, release: 200 });
    const gains = d.run(1.6, t => (t < 0.5 ? 0.2 : t < 0.6 ? 0 : t < 0.7 ? 0.2 : 0));
    assert.ok(db(d.at(gains, 0.55)) < -11.5, 'a 100 ms pause inside the hold time keeps the duck');
    assert.ok(db(d.at(gains, 1.0)) < -11.5, 'still held until 400 ms after speech stops');
    assert.ok(db(d.at(gains, 1.25)) > -8 && db(d.at(gains, 1.25)) < -1, 'release is gradual');
    assert.ok(Math.abs(d.at(gains, 1.6) - 1) < 0.02, 'back near unity after release');
    const releaseStart = Math.floor(1.0 * RATE / 128);
    for (let i = releaseStart + 1; i < gains.length; i++) assert.ok(Math.abs(gains[i] - gains[i - 1]) < 0.05, 'the release ramps smoothly without jumps');
});

test('disabled, muted (silent), or missing microphone input leaves the board at unity', () => {
    const off = ducker({ enabled: false });
    assert.ok(off.run(0.5, () => 0.5).every(g => Math.abs(g - 1) < 1e-6));
    const muted = ducker({});
    assert.ok(muted.run(0.5, () => 0).every(g => Math.abs(g - 1) < 1e-6));
    const none = ducker({});
    assert.ok(none.run(0.5, null).every(g => Math.abs(g - 1) < 1e-6));
    const live = ducker({ attack: 5, release: 50 });
    live.run(0.4, () => 0.3);
    live.node.port.onmessage({ data: { enabled: false } });
    const after = live.run(0.5, () => 0.3);
    assert.ok(Math.abs(after.at(-1) - 1) < 0.01, 'turning ducking off returns to unity while speech continues');
    assert.ok(live.messages.some(m => m.gain < 0.3), 'the current gain is reported for the UI');
});

test('the board signal passes through unchanged when not ducked, in stereo, and invalid samples are contained', () => {
    const d = ducker({});
    const left = Float32Array.from({ length: 128 }, (_, i) => Math.sin(i / 5) * 0.4), right = left.map(v => -v);
    const out = [new Float32Array(128), new Float32Array(128)];
    d.node.process([[left, right], []], [out]);
    assert.deepEqual(Array.from(out[0]), Array.from(left)); assert.deepEqual(Array.from(out[1]), Array.from(right));
    const bad = new Float32Array(128).fill(NaN);
    d.node.process([[bad], [bad]], [out]);
    assert.ok(out[0].every(v => v === 0) && Number.isFinite(d.node.gain));
});
