/**
 * Bounded microphone recorder. Copies mono PCM into fixed-size chunks and transfers each full chunk to
 * the main thread. No file, JSON, or growing-array work happens on the audio thread; a hard frame limit
 * stops the take (180 s by default) and reports that the limit was reached.
 */
const CHUNK = 16384;

class TakeRecorder extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.maxFrames = Math.max(1, Math.floor(options.processorOptions?.maxFrames || sampleRate * 180));
        this.recording = false; this.frames = 0; this.chunk = null; this.fill = 0; this.done = false;
        this.port.onmessage = event => {
            if (event.data.type === 'start' && !this.done) { this.recording = true; this.chunk = new Float32Array(CHUNK); this.fill = 0; }
            else if (event.data.type === 'stop') this.finish('stopped');
        };
    }

    flush() {
        if (!this.chunk || !this.fill) return;
        const out = this.fill === CHUNK ? this.chunk : this.chunk.slice(0, this.fill);
        this.port.postMessage({ type: 'chunk', samples: out }, [out.buffer]);
        this.chunk = this.recording ? new Float32Array(CHUNK) : null;
        this.fill = 0;
    }

    finish(reason) {
        if (this.done) return;
        this.recording = false; this.done = true;
        this.flush();
        this.port.postMessage({ type: 'done', reason, frames: this.frames });
    }

    process(inputs) {
        if (!this.recording) return !this.done;
        const input = inputs[0];
        const length = input?.[0]?.length || 128;
        for (let i = 0; i < length; i++) {
            if (this.frames >= this.maxFrames) { this.finish('limit'); return false; }
            let value = 0;
            if (input?.length) { for (const channel of input) value += channel[i]; value /= input.length; }
            this.chunk[this.fill++] = Number.isFinite(value) ? value : 0;
            this.frames++;
            if (this.fill === CHUNK) this.flush();
        }
        return true;
    }
}

registerProcessor('take-recorder', TakeRecorder);
