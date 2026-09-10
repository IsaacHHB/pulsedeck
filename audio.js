import { buildVoiceEffect } from './voice-effects.js';
import { isMac, microphoneHelp } from './platform.js';

/**
 * PulseDeck audio engine.
 *
 *  microphone ─ voice effect ─ mic gain ─┐
 *                                        ├─ mix ─ limiter ─ broadcast gain ─ context sink (virtual cable)
 *  clips ─ clip gain ─ soundboard gain ──┘            └──── monitor bus ─ headphones (optional)
 *
 * The broadcast gain stays at zero unless a broadcast is deliberately connected,
 * so the microphone can be captured for headphone preview without leaking anywhere.
 */
/** Loudness target for auto-leveled clips, in dBFS RMS (speech into a mic sits around -18 to -14). */
export const LEVEL_TARGET_DB = -13;
const MAX_BOOST_DB = 20, MAX_CUT_DB = -14;
const dbToGain = db => 10 ** (db / 20);

/** RMS loudness of a decoded buffer in dBFS, ignoring near-silent frames so gaps and fades don't skew it. */
export function measureLoudness(buffer) {
    const frame = 2048;
    let sum = 0, count = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const data = buffer.getChannelData(channel);
        for (let start = 0; start + frame <= data.length; start += frame) {
            let energy = 0;
            for (let i = start; i < start + frame; i++) energy += data[i] * data[i];
            const rms = Math.sqrt(energy / frame);
            if (rms > 0.003) { sum += energy; count += frame; }
        }
    }
    if (!count) return -60;
    return Math.max(-60, 20 * Math.log10(Math.sqrt(sum / count)));
}

/** Makeup gain (dB) that brings a clip of the given loudness to the target. */
export function levelGainDb(loudness) {
    if (!Number.isFinite(loudness)) return 0;
    return Math.max(MAX_CUT_DB, Math.min(MAX_BOOST_DB, LEVEL_TARGET_DB - loudness));
}

export class AudioEngine extends EventTarget {
    constructor() {
        super();
        this.loudness = new Map();
        this.context = null;
        this.stream = null;
        this.source = null;
        this.connected = false;
        this.previewing = false;
        this.muted = false;
        this.monitoring = false;
        this.buffers = new Map();
        this.playing = new Map();
        this.effect = null;
        this.settings = {};
        this.monitor = new Audio();
        this.monitor.autoplay = true;
        this.replay = null;
    }

    emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

    async init() {
        if (this.context) { await this.context.resume(); return; }
        const ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000, sinkId: { type: 'none' } });
        if (!ctx.setSinkId) { await ctx.close(); throw new Error('This audio runtime cannot select an output device.'); }
        this.context = ctx;
        ctx.addEventListener('sinkchange', () => {
            if (this.connected && ctx.sinkId !== this.settings.outputId) {
                this.disconnect();
                this.emit('fault', 'The broadcast output changed. Choose your output and reconnect.');
            }
        });
        this.board = ctx.createGain();
        this.mic = ctx.createGain();
        this.mix = ctx.createGain();
        this.limiter = ctx.createDynamicsCompressor();
        // A brick-wall style limiter just under full scale keeps the mix hot without clipping the cable.
        this.limiter.threshold.value = -2; this.limiter.knee.value = 2; this.limiter.ratio.value = 20;
        this.limiter.attack.value = 0.002; this.limiter.release.value = 0.1;
        this.board.connect(this.mix); this.mic.connect(this.mix); this.mix.connect(this.limiter);
        this.broadcast = ctx.createGain(); this.broadcast.gain.value = 0;
        this.limiter.connect(this.broadcast); this.broadcast.connect(ctx.destination);
        this.meter = ctx.createAnalyser(); this.meter.fftSize = 256; this.limiter.connect(this.meter);
        this.micMeter = ctx.createAnalyser(); this.micMeter.fftSize = 256; this.mic.connect(this.micMeter);
        this.monitorBus = ctx.createGain(); this.monitorBus.gain.value = 0;
        this.monitorLimiter = ctx.createDynamicsCompressor(); this.monitorLimiter.threshold.value = -6; this.monitorLimiter.ratio.value = 20;
        this.monitorDestination = ctx.createMediaStreamDestination();
        this.monitorBus.connect(this.monitorLimiter); this.monitorLimiter.connect(this.monitorDestination);
        this.monitor.srcObject = this.monitorDestination.stream;
        this.setMonitorVoice(Boolean(this.settings.monitorVoice));
        this.applySettings(this.settings);
        await ctx.resume();
    }

    /** Opens the microphone and wires it through the current voice effect. */
    async captureMic(micId) {
        if (!micId) throw new Error('Choose your microphone, or choose Sounds only.');
        if (window.deck?.requestMicrophone && !await window.deck.requestMicrophone()) throw new Error(microphoneHelp);
        const stream = await navigator.mediaDevices.getUserMedia({
            video: false,
            audio: { deviceId: { exact: micId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }
        });
        this.releaseMic();
        this.stream = stream;
        this.source = this.context.createMediaStreamSource(stream);
        for (const track of stream.getAudioTracks()) {
            track.addEventListener('ended', () => {
                if (this.stream === stream && (this.connected || this.previewing)) {
                    this.disconnect();
                    this.emit('fault', 'Your microphone disconnected. Select it again and reconnect.');
                }
            });
        }
        this.setEffect(this.settings.effect || 'clean');
    }

    releaseMic() {
        this.clearEffects();
        this.source?.disconnect(); this.source = null;
        this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    }

    async connect(settings) {
        await this.init();
        this.disconnect();
        this.settings = { ...this.settings, ...settings };
        if (!settings.outputId || ['default', 'communications'].includes(settings.outputId)) throw new Error('Choose a specific broadcast output first.');
        try {
            // Select the sink while the output gain is zero; failure never falls back to speakers.
            await this.context.setSinkId(settings.outputId);
            if (settings.micId !== 'none') await this.captureMic(settings.micId);
            this.applySettings(settings);
            this.connected = true;
            this.broadcast.gain.setTargetAtTime(1, this.context.currentTime, 0.01);
            this.emit('connection', true);
        } catch (error) {
            this.disconnect();
            throw error;
        }
    }

    disconnect() {
        const wasLive = this.connected || this.previewing;
        this.connected = false;
        this.previewing = false;
        if (this.context) { this.broadcast.gain.cancelScheduledValues(this.context.currentTime); this.broadcast.gain.value = 0; }
        this.stopAll();
        this.releaseMic();
        if (wasLive || this.context) this.emit('connection', false);
    }

    /** Captures the microphone for headphone preview only. The broadcast stays silent. */
    async previewVoice(micId) {
        if (this.connected) return;
        await this.init();
        if (!micId || micId === 'none') throw new Error('Choose your microphone in the mixer to hear your voice.');
        await this.captureMic(micId);
        this.previewing = true;
        this.emit('connection', false);
    }

    stopPreview() {
        if (!this.previewing) return;
        this.previewing = false;
        this.releaseMic();
        this.emit('connection', false);
    }

    applySettings(settings) {
        this.settings = { ...this.settings, ...settings };
        if (!this.context) return;
        const now = this.context.currentTime;
        this.board.gain.setTargetAtTime((this.settings.boardVolume ?? 100) / 100, now, 0.015);
        this.mic.gain.setTargetAtTime(this.muted ? 0 : (this.settings.micVolume ?? 100) / 100, now, 0.015);
        this.monitorBus.gain.setTargetAtTime(this.monitoring ? (this.settings.monitorVolume ?? 50) / 100 : 0, now, 0.015);
    }

    toggleMute() { this.muted = !this.muted; this.applySettings(this.settings); this.emit('mute', this.muted); }

    clearEffects() {
        this.source?.disconnect();
        for (const node of this.effect?.nodes || []) {
            if (typeof node.stop === 'function') { try { node.stop(); } catch { /* already stopped */ } }
            node.disconnect();
        }
        this.effect = null;
    }

    /** Rebuilds the voice chain for a preset, using the saved pitch and mix. */
    setEffect(effect, options = {}) {
        this.settings.effect = effect;
        if ('voicePitch' in options) this.settings.voicePitch = options.voicePitch;
        if ('effectMix' in options) this.settings.effectMix = options.effectMix;
        if (!this.context || !this.source) return;
        this.clearEffects();
        this.effect = buildVoiceEffect(this.context, this.source, this.mic, effect, {
            pitch: this.settings.voicePitch || 0,
            mix: (this.settings.effectMix ?? 100) / 100
        });
    }

    /** Blends processed and natural voice live, without rebuilding the chain. */
    setEffectMix(percent) {
        this.settings.effectMix = percent;
        this.effect?.setMix(percent / 100);
    }

    setMonitorVoice(includeVoice) {
        this.settings.monitorVoice = Boolean(includeVoice);
        if (!this.context) return;
        try { this.board.disconnect(this.monitorBus); } catch { /* not connected */ }
        try { this.limiter.disconnect(this.monitorBus); } catch { /* not connected */ }
        (includeVoice ? this.limiter : this.board).connect(this.monitorBus);
    }

    async setMonitoring(enabled, deviceId) {
        if (!enabled) {
            this.monitoring = false;
            this.monitor.pause();
            this.applySettings(this.settings);
            if (!this.connected) { this.stopAll(); this.stopPreview(); }
            return;
        }
        if (!deviceId || ['default', 'communications'].includes(deviceId)) throw new Error('Choose your headphones for monitoring.');
        if (deviceId === this.settings.outputId) throw new Error('Monitoring and broadcast must use different outputs.');
        await this.init();
        try {
            await this.monitor.setSinkId(deviceId);
            await this.monitor.play();
            this.monitoring = true;
            this.applySettings(this.settings);
        } catch (error) {
            this.monitoring = false;
            this.monitor.pause();
            this.applySettings(this.settings);
            throw error;
        }
    }

    async load(clip) {
        if (this.buffers.has(clip.id)) {
            const buffer = this.buffers.get(clip.id);
            this.buffers.delete(clip.id); this.buffers.set(clip.id, buffer);
            return buffer;
        }
        await this.init();
        const bytes = await window.deck.readSound(clip.id);
        let buffer;
        try { buffer = await this.context.decodeAudioData(new Uint8Array(bytes).buffer); }
        catch { throw new Error(`“${clip.name}” could not be decoded. Try exporting it as MP3 or WAV.`); }
        const size = b => b.length * b.numberOfChannels * 4;
        const maxBytes = 128 * 1024 * 1024;
        if (size(buffer) > maxBytes) throw new Error('This sound is too long. Trim it to a shorter clip before importing.');
        let total = [...this.buffers.values()].reduce((sum, item) => sum + size(item), 0);
        for (const [id, cached] of this.buffers) {
            if (total + size(buffer) <= maxBytes) break;
            if (!this.playing.has(id)) { this.buffers.delete(id); total -= size(cached); }
        }
        if (total + size(buffer) > maxBytes) throw new Error('Stop some playing sounds before loading another large clip.');
        this.buffers.set(clip.id, buffer);
        const loudness = measureLoudness(buffer);
        this.loudness.set(clip.id, loudness);
        this.emit('analysis', { id: clip.id, duration: buffer.duration, loudness });
        return buffer;
    }

    /** Re-applies clip gains to everything playing, e.g. after toggling auto-level. */
    relevel(clips) {
        for (const clip of clips) this.updateClip(clip);
    }

    /** Linear gain for a clip: its own volume, plus auto-leveling when enabled. */
    clipGain(clip) {
        const loudness = this.loudness.get(clip.id) ?? clip.loudness;
        const level = this.settings.autoLevel === false ? 0 : levelGainDb(loudness);
        return (clip.volume / 100) * dbToGain(level);
    }

    async play(clip) {
        if (this.playing.has(clip.id)) { this.stop(clip.id); return; }
        if (!this.connected && !this.monitoring) throw new Error('Connect the broadcast or enable headphone monitoring before playing sounds.');
        const token = { loading: true };
        this.playing.set(clip.id, token);
        this.emit('playing', [...this.playing.keys()]);
        try {
            const buffer = await this.load(clip);
            if (this.playing.get(clip.id) !== token) return;
            const source = this.context.createBufferSource(), gain = this.context.createGain();
            source.buffer = buffer; source.loop = clip.loop; gain.gain.value = this.clipGain(clip);
            source.connect(gain); gain.connect(this.board);
            this.playing.set(clip.id, { source, gain, startedAt: this.context.currentTime, duration: buffer.duration });
            source.onended = () => {
                if (this.playing.get(clip.id)?.source === source) this.playing.delete(clip.id);
                source.disconnect(); gain.disconnect();
                this.emit('playing', [...this.playing.keys()]);
            };
            source.start();
            this.emit('playing', [...this.playing.keys()]);
        } catch (error) {
            if (this.playing.get(clip.id) === token) this.playing.delete(clip.id);
            this.emit('playing', [...this.playing.keys()]);
            throw error;
        }
    }

    /** Playback position of a clip from 0 to 1, or null when it is not playing. */
    progress(id) {
        const active = this.playing.get(id);
        if (!active?.source || !this.context) return null;
        const elapsed = this.context.currentTime - active.startedAt;
        if (!active.duration) return 0;
        return active.source.loop ? (elapsed % active.duration) / active.duration : Math.min(1, elapsed / active.duration);
    }

    updateClip(clip) {
        const active = this.playing.get(clip.id);
        if (active?.source) {
            active.source.loop = clip.loop;
            active.gain.gain.setTargetAtTime(this.clipGain(clip), this.context.currentTime, 0.01);
        }
    }

    stop(id) {
        const active = this.playing.get(id);
        this.playing.delete(id);
        if (active?.source) active.source.stop();
        this.emit('playing', [...this.playing.keys()]);
    }

    stopAll() { for (const id of this.playing.keys()) this.stop(id); }

    forget(id) { this.stop(id); this.buffers.delete(id); }

    /* ─── Replay buffer: rolling capture of system audio (what you hear) ─── */

    /** Opens system audio, using the supported desktop capture path on macOS. */
    async captureSystemAudio() {
        if (isMac) {
            let stream;
            try {
                stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
                stream.getVideoTracks().forEach(track => { track.stop(); stream.removeTrack(track); });
                if (!stream.getAudioTracks().some(track => track.readyState === 'live')) throw new Error('No system audio track was provided.');
                return stream;
            } catch (error) {
                stream?.getTracks().forEach(track => track.stop());
                throw new Error(`Could not capture your Mac’s audio. Allow PulseDeck in System Settings → Privacy & Security → Screen & System Audio Recording, then reopen PulseDeck and try again. ${error.message || error}`);
            }
        }
        try {
            // Legacy desktop-capture constraints work without a user gesture and give system loopback on Windows.
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { mandatory: { chromeMediaSource: 'desktop' } },
                video: { mandatory: { chromeMediaSource: 'desktop', maxWidth: 2, maxHeight: 2, maxFrameRate: 1 } }
            });
            stream.getVideoTracks().forEach(track => { track.stop(); stream.removeTrack(track); });
            if (!stream.getAudioTracks().length) throw new Error('no audio track');
            return stream;
        } catch (legacyError) {
            try {
                const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
                stream.getVideoTracks().forEach(track => { track.stop(); stream.removeTrack(track); });
                if (!stream.getAudioTracks().length) throw new Error('no audio track');
                return stream;
            } catch {
                throw new Error(`Could not listen to your computer's audio (${legacyError.message || legacyError}). Check Windows Settings → Privacy → Microphone allows desktop apps, then try again.`);
            }
        }
    }

    /** Starts (or restarts) the rolling buffer. `seconds` is how much history to keep. */
    async startReplay({ seconds = 60, includeMic = false, streamFactory } = {}) {
        await this.init();
        this.stopReplay();
        const ctx = this.context;
        if (!this.workletReady) { await ctx.audioWorklet.addModule('replay-worklet.js'); this.workletReady = true; }
        const stream = await (streamFactory || (() => this.captureSystemAudio()))();
        const source = ctx.createMediaStreamSource(stream);
        const capacity = Math.round(ctx.sampleRate * Math.max(15, Math.min(180, seconds)));
        const node = new AudioWorkletNode(ctx, 'ring-recorder', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { capacity } });
        const sink = ctx.createGain(); sink.gain.value = 0;
        node.connect(sink); sink.connect(ctx.destination); // silent; keeps the worklet processing
        const meter = ctx.createAnalyser(); meter.fftSize = 256; source.connect(meter);
        source.connect(node, 0, 0);
        this.replay = { stream, source, node, sink, meter, seconds, includeMic: false, pending: new Map(), token: 0 };
        node.port.onmessage = event => {
            const waiting = this.replay?.pending.get(event.data.token);
            if (waiting) { this.replay.pending.delete(event.data.token); waiting(event.data); }
        };
        for (const track of stream.getAudioTracks()) {
            track.addEventListener('ended', () => { if (this.replay?.stream === stream) { this.stopReplay(); this.emit('replay', { armed: false, reason: 'System audio capture stopped.' }); } });
        }
        this.setReplayMic(includeMic);
        this.emit('replay', { armed: true });
    }

    setReplayMic(includeMic) {
        if (!this.replay) return;
        try { this.mic.disconnect(this.replay.node); } catch { /* not connected */ }
        if (includeMic) this.mic.connect(this.replay.node, 0, 1);
        this.replay.includeMic = Boolean(includeMic);
    }

    stopReplay() {
        const replay = this.replay;
        if (!replay) return;
        this.replay = null;
        try { this.mic.disconnect(replay.node); } catch { /* not connected */ }
        replay.source.disconnect(); replay.node.disconnect(); replay.sink.disconnect(); replay.meter.disconnect();
        replay.node.port.onmessage = null;
        replay.stream.getTracks().forEach(track => track.stop());
        for (const waiting of replay.pending.values()) waiting({ samples: new Float32Array(0), sampleRate: this.context.sampleRate });
        this.emit('replay', { armed: false });
    }

    /** Pulls the most recent `seconds` from the ring buffer as mono float samples. */
    grabReplay(seconds) {
        if (!this.replay) return Promise.reject(new Error('The replay buffer is not running. Turn it on first.'));
        const token = ++this.replay.token;
        return new Promise(resolve => {
            this.replay.pending.set(token, resolve);
            this.replay.node.port.postMessage({ type: 'dump', seconds: seconds || this.replay.seconds, token });
        });
    }

    replayLevel() { return this.replay ? this.readLevel(this.replay.meter) : 0; }

    readLevel(analyser) {
        if (!analyser) return 0;
        const values = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(values);
        return Math.min(1, Math.sqrt(values.reduce((sum, n) => sum + n * n, 0) / values.length) * 3);
    }

    level() { return this.readLevel(this.meter); }

    micLevel() { return this.readLevel(this.micMeter); }
}
