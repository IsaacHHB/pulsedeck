/**
 * Ring recorder: keeps the most recent N seconds of audio in a circular buffer.
 * Input 0 is system audio (loopback), input 1 is the optional microphone.
 * Both are summed to mono. "dump" returns the last `seconds` of audio.
 */
class RingRecorder extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.capacity = Math.max(sampleRate, options.processorOptions?.capacity || sampleRate * 60);
        this.buffer = new Float32Array(this.capacity);
        this.write = 0;
        this.filled = 0;
        this.port.onmessage = event => {
            if (event.data.type === 'dump') this.dump(event.data.seconds, event.data.token);
            else if (event.data.type === 'clear') { this.write = 0; this.filled = 0; }
        };
    }

    process(inputs) {
        let frames = 0;
        for (const input of inputs) if (input.length) { frames = input[0].length; break; }
        if (!frames) return true;
        for (let i = 0; i < frames; i++) {
            let value = 0;
            for (const input of inputs) {
                if (!input.length) continue;
                let sum = 0;
                for (const channel of input) sum += channel[i];
                value += sum / input.length;
            }
            this.buffer[this.write] = value;
            this.write = (this.write + 1) % this.capacity;
            if (this.filled < this.capacity) this.filled++;
        }
        return true;
    }

    dump(seconds, token) {
        const count = Math.min(this.filled, Math.round((seconds || 60) * sampleRate));
        const out = new Float32Array(count);
        const start = (this.write - count + this.capacity) % this.capacity;
        if (start + count <= this.capacity) out.set(this.buffer.subarray(start, start + count));
        else {
            const first = this.capacity - start;
            out.set(this.buffer.subarray(start));
            out.set(this.buffer.subarray(0, count - first), first);
        }
        this.port.postMessage({ type: 'dump', token, samples: out, sampleRate }, [out.buffer]);
    }
}

registerProcessor('ring-recorder', RingRecorder);
