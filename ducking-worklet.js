/**
 * Microphone-driven ducking. Input 0 is the soundboard bus; input 1 is the live microphone after mute
 * and gain (never the board mix). While the microphone is above the threshold, the board is lowered by
 * `reduction` dB with separate attack, hold, and release times. Runs on the audio clock, so it keeps
 * working while the window is hidden. Disabled means a smooth return to unity gain.
 */
class Ducker extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.gain = 1; this.level = 0; this.hold = 0; this.reported = 1; this.sinceReport = 0;
        this.detector = Math.exp(-1 / (sampleRate * 0.01));
        this.configure({ enabled: false, threshold: -35, reduction: 12, attack: 20, hold: 150, release: 300, ...options?.processorOptions });
        this.port.onmessage = event => this.configure(event.data);
    }

    configure(settings) {
        const s = { ...this.settings, ...settings };
        this.settings = s;
        this.enabled = Boolean(s.enabled);
        this.thresholdPower = 10 ** (s.threshold / 10);          // compared with mean square
        this.floor = 10 ** (-Math.max(0, s.reduction) / 20);
        // Attack and release are the times to complete about 95% of the change (three time constants).
        this.attackCoef = Math.exp(-3 / (sampleRate * Math.max(0.001, s.attack / 1000)));
        this.releaseCoef = Math.exp(-3 / (sampleRate * Math.max(0.001, s.release / 1000)));
        this.holdFrames = Math.round(sampleRate * Math.max(0, s.hold) / 1000);
    }

    process(inputs, outputs) {
        const board = inputs[0] || [], mic = inputs[1] || [], output = outputs[0];
        const frames = output?.[0]?.length || 0;
        for (let i = 0; i < frames; i++) {
            let power = 0;
            if (mic.length) { for (const channel of mic) { const v = channel[i]; if (Number.isFinite(v)) power += v * v; } power /= mic.length; }
            this.level = this.detector * this.level + (1 - this.detector) * power;
            let target = 1;
            if (this.enabled) {
                if (this.level > this.thresholdPower) this.hold = this.holdFrames + 1;
                if (this.hold > 0) { this.hold--; target = this.floor; }
            } else this.hold = 0;
            const coef = target < this.gain ? this.attackCoef : this.releaseCoef;
            this.gain = target + (this.gain - target) * coef;
            for (let ch = 0; ch < output.length; ch++) {
                const v = board[ch]?.[i] ?? board[0]?.[i] ?? 0;
                output[ch][i] = Number.isFinite(v) ? v * this.gain : 0;
            }
        }
        this.sinceReport += frames;
        if (this.sinceReport >= sampleRate / 20 && Math.abs(this.gain - this.reported) > 0.005) {
            this.reported = this.gain; this.sinceReport = 0;
            this.port.postMessage({ gain: this.gain });
        }
        return true;
    }
}

registerProcessor('ducker', Ducker);
