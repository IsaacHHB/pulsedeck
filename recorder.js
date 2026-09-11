import { buildVoiceEffect } from './voice-effects.js';

export const TAKE_LIMIT_SECONDS = 180;
export const MIN_TAKE_SECONDS = 0.1;

/**
 * One microphone take. The recorder leases the microphone from the engine (sharing the live stream when
 * the device matches), taps it before the broadcast gain and mute, and never touches the live chain.
 * Dry takes record the raw microphone; processed takes run their own copy of the current voice effect.
 */
export class Recorder extends EventTarget {
    constructor(engine) {
        super();
        this.engine = engine;
        this.state = 'idle';        // idle → acquiring → recording → idle (with a take) | idle (no take)
        this.token = 0;
        this.take = null;
        this.session = null;
    }

    emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

    /** Starts a take. Device and effect are fixed for the whole take. */
    async start({ deviceId, processed = false, effect = 'clean', pitch = 0, mix = 1, monitorDevice = null, maxSeconds = TAKE_LIMIT_SECONDS }) {
        if (this.state !== 'idle') throw new Error('A recording is already running.');
        if (!deviceId || deviceId === 'none') throw new Error('Choose a microphone to record. Sounds only has no microphone.');
        const token = ++this.token;
        this.take = null;
        this.state = 'acquiring';
        this.emit('state', this.state);
        const engine = this.engine;
        try {
            await engine.init();
            if (!engine.recorderReady) { await engine.context.audioWorklet.addModule('./recorder-worklet.js'); engine.recorderReady = true; }
            // Editor previews could leak from speakers into the microphone.
            engine.stopAudition();
            const lease = await engine.acquireMic(deviceId, { isCancelled: () => token !== this.token });
            if (token !== this.token) { lease.release(); return; }
            const ctx = engine.context;
            const input = ctx.createGain(), tap = ctx.createGain(), sink = ctx.createGain(), meter = ctx.createAnalyser();
            sink.gain.value = 0; meter.fftSize = 256;
            const node = new AudioWorkletNode(ctx, 'take-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { maxFrames: Math.round(Math.min(TAKE_LIMIT_SECONDS, Math.max(0.1, Number(maxSeconds) || TAKE_LIMIT_SECONDS)) * ctx.sampleRate) } });
            lease.source.connect(tap);
            const chain = processed ? buildVoiceEffect(ctx, tap, input, effect, { pitch, mix }) : (tap.connect(input), null);
            input.connect(node); input.connect(meter); node.connect(sink); sink.connect(ctx.destination);
            const session = { token, lease, tap, input, node, sink, meter, chain, chunks: [], frames: 0, startedAt: performance.now(), processed, deviceId, monitor: null, finished: null };
            session.finished = new Promise(resolve => { session.resolveFinished = resolve; });
            node.port.onmessage = event => {
                if (event.data.type === 'chunk') { session.chunks.push(event.data.samples); session.frames += event.data.samples.length; }
                else if (event.data.type === 'done') this.finalize(session, session.stopReason || event.data.reason);
            };
            session.offEnded = lease.onEnded(() => this.stop('disconnected'));
            this.session = session;
            if (monitorDevice) {
                try {
                    const monitor = await engine.startAudition(monitorDevice);
                    if (token !== this.token || this.session !== session) {
                        if (engine.auditionSession === monitor) engine.stopAudition();
                        return;
                    }
                    monitor.owner = 'recorder'; input.connect(monitor.input); session.monitor = monitor;
                }
                catch (error) { this.emit('warning', `Monitoring is off: ${error.message}`); }
            }
            if (token !== this.token || this.session !== session) return;
            session.startedAt = ctx.currentTime;
            node.port.postMessage({ type: 'start' });
            this.state = 'recording';
            this.emit('state', this.state);
        } catch (error) {
            if (token === this.token) { this.state = 'idle'; this.emit('state', this.state); }
            throw error;
        }
    }

    /** Stops the take and resolves with it (or null when nothing usable was recorded). */
    async stop(reason = 'stopped') {
        const session = this.session;
        if (this.state === 'acquiring') { this.cancel(); return null; }
        if (!session) return this.take;
        if (!session.stopReason) { session.stopReason = reason; session.node.port.postMessage({ type: 'stop' }); }
        return session.finished;
    }

    finalize(session, reason) {
        if (this.session !== session) return;
        this.session = null;
        session.offEnded?.();
        if (session.monitor && this.engine.auditionSession === session.monitor) this.engine.stopAudition();
        for (const node of session.chain?.nodes || []) { if (typeof node.stop === 'function') { try { node.stop(); } catch { /* stopped */ } } node.disconnect(); }
        try { session.lease.source.disconnect(session.tap); } catch { /* already disconnected */ }
        for (const node of [session.tap, session.input, session.node, session.sink, session.meter]) node.disconnect();
        session.node.port.onmessage = null;
        session.lease.release();
        if (reason === 'cancelled') {
            session.chunks.length = 0;
            this.take = null; this.state = 'idle'; this.emit('state', this.state);
            session.resolveFinished(null);
            return;
        }
        const samples = new Float32Array(session.frames);
        let offset = 0; for (const chunk of session.chunks) { samples.set(chunk, offset); offset += chunk.length; }
        const sampleRate = this.engine.context.sampleRate;
        this.state = 'idle';
        if (samples.length < sampleRate * MIN_TAKE_SECONDS) {
            this.take = null;
            this.emit('state', this.state);
            this.emit('ended', { reason, take: null, message: reason === 'disconnected' ? 'Recording stopped: microphone disconnected before any audio was captured.' : 'The recording was too short to keep. Record for at least a tenth of a second.' });
            session.resolveFinished(null);
            return;
        }
        this.take = { samples, sampleRate, seconds: samples.length / sampleRate, processed: session.processed, reason, createdAt: Date.now() };
        this.emit('state', this.state);
        const message = reason === 'limit' ? 'Recording stopped at the 3-minute limit. Your take is kept.' : reason === 'disconnected' ? 'Recording stopped: microphone disconnected. The audio recorded so far is kept.' : '';
        this.emit('ended', { reason, take: this.take, message });
        session.resolveFinished(this.take);
    }

    /** Abandons a take that is starting or running. A stream that arrives later is released immediately. */
    cancel() {
        this.token++;
        const session = this.session;
        if (session) {
            session.stopReason = 'cancelled';
            if (this.state === 'acquiring') this.finalize(session, 'cancelled');
            else session.node.port.postMessage({ type: 'stop' });
        }
        if (this.state === 'acquiring') { this.state = 'idle'; this.emit('state', this.state); }
    }

    discard() { this.take = null; this.emit('state', this.state); }

    elapsed() { return this.state === 'recording' && this.session ? Math.max(0, this.engine.context.currentTime - this.session.startedAt) : this.take?.seconds ?? 0; }

    level() {
        const meter = this.session?.meter;
        if (!meter) return 0;
        const values = new Float32Array(meter.fftSize);
        meter.getFloatTimeDomainData(values);
        return Math.min(1, Math.sqrt(values.reduce((sum, n) => sum + n * n, 0) / values.length) * 3);
    }
}
