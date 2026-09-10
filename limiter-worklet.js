// Linked-stereo, 5 ms lookahead peak limiter. No resampling or pitch processing.
class PeakLimiter extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.ceiling = options.processorOptions?.ceiling ?? 10 ** (-1 / 20);
        this.delay = Math.max(1, Math.round(sampleRate * 0.005));
        this.length = this.delay + 1;
        this.buffers = [new Float32Array(this.length), new Float32Array(this.length)];
        this.peaks = new Float32Array(this.length + 1);
        this.times = new Float64Array(this.length + 1);
        this.head = 0; this.tail = 0; this.frame = 0; this.envelope = 0;
        this.release = Math.exp(-1 / (sampleRate * 0.08));
    }

    process(inputs, outputs) {
        const input = inputs[0] || [], output = outputs[0];
        if (!output?.length) return true;
        const queueLength = this.peaks.length;
        for (let i = 0; i < output[0].length; i++, this.frame++) {
            const write = this.frame % this.length;
            let peak = 0;
            for (let ch = 0; ch < 2; ch++) {
                const sample = input[ch]?.[i] ?? input[0]?.[i] ?? 0;
                const value = Number.isFinite(sample) ? sample : 0;
                this.buffers[ch][write] = value; peak = Math.max(peak, Math.abs(value));
            }
            // Monotonic queue: maximum peak between the delayed sample and now.
            while (this.head !== this.tail && this.times[this.head] < this.frame - this.delay) this.head = (this.head + 1) % queueLength;
            while (this.head !== this.tail && this.peaks[(this.tail - 1 + queueLength) % queueLength] <= peak) this.tail = (this.tail - 1 + queueLength) % queueLength;
            this.peaks[this.tail] = peak; this.times[this.tail] = this.frame; this.tail = (this.tail + 1) % queueLength;
            this.envelope = Math.max(this.peaks[this.head], this.envelope * this.release);
            const gain = this.envelope > this.ceiling ? this.ceiling / this.envelope : 1;
            const read = (write + 1) % this.length;
            for (let ch = 0; ch < output.length; ch++) output[ch][i] = this.frame < this.delay ? 0 : this.buffers[Math.min(ch, 1)][read] * gain;
        }
        return true;
    }
}
registerProcessor('peak-limiter', PeakLimiter);
