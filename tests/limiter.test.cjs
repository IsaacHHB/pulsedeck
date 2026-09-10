const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function render(channels, rate = 48000) {
    let Processor;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../limiter-worklet.js'), 'utf8'), {
        sampleRate: rate, Float32Array, Float64Array,
        AudioWorkletProcessor: class {}, registerProcessor: (_, type) => { Processor = type; }
    });
    const limiter = new Processor({}), length = channels[0].length + limiter.delay;
    const result = [new Float32Array(length), new Float32Array(length)];
    for (let start = 0; start < length; start += 128) {
        const size = Math.min(128, length - start);
        const input = channels.map(c => { const block = new Float32Array(size); block.set(c.subarray(start, Math.min(start + size, c.length))); return block; });
        const output = [new Float32Array(size), new Float32Array(size)];
        limiter.process([input], [output]);
        output.forEach((data, ch) => result[ch].set(data, start));
    }
    return { result, delay: limiter.delay };
}

test('unlimited audio keeps every sample, its pitch, and its duration with only a fixed 5 ms delay', () => {
    for (const rate of [44100, 48000, 96000]) {
        const input = Float32Array.from({ length: rate }, (_, i) => Math.sin(2 * Math.PI * 1000 * i / rate) * 0.2);
        const { result, delay } = render([input], rate);
        assert.deepEqual(result[0].subarray(delay), input);
        assert.deepEqual(result[1], result[0]);
        assert.ok(result[0].subarray(0, delay).every(n => n === 0));
    }
});

test('loud transients and mixed audio never exceed the output ceiling; stereo balance is preserved', () => {
    const left = Float32Array.from({ length: 48000 }, (_, i) => i % 6000 < 12 ? 8 : Math.sin(i * 0.2) * 2);
    const right = left.map(n => n / 2);
    const { result, delay } = render([left, right]);
    const ceiling = 10 ** (-1 / 20);
    for (let i = delay; i < result[0].length; i++) {
        assert.ok(Math.abs(result[0][i]) <= ceiling + 1e-6);
        assert.ok(Math.abs(result[0][i] / 2 - result[1][i]) < 1e-6);
    }
});

test('invalid input is contained and silent input remains silent', () => {
    const input = new Float32Array(4800); input[0] = NaN; input[1] = Infinity;
    const { result } = render([input]);
    assert.ok(result.flatMap(c => Array.from(c)).every(n => n === 0));
});

test('automatic leveling respects transient peaks while still boosting quiet recordings', async () => {
    const { levelGainDb, measurePeak } = await import('../audio.js');
    const peak = measurePeak({ numberOfChannels: 2, getChannelData: ch => ch ? new Float32Array([0.1, -0.9]) : new Float32Array([0, 0.3]) });
    const gain = 10 ** (levelGainDb(-30, peak) / 20);
    assert.ok(peak * gain <= 10 ** (-3 / 20) + 1e-8);
    assert.equal(levelGainDb(-50, 0.01), 20);
    assert.equal(levelGainDb(-20), 7, 'libraries without peak metadata remain readable until the clip is analyzed');
});
