import { buildVoiceEffect } from './voice-effects.js';
import { isMac, microphoneHelp } from './platform.js';
import { resolveRegion, regionKey, envelopePoints, applyEnvelope } from './playback-region.js';

/**
 * PulseDeck audio engine.
 *
 *  microphone ─ voice effect ─ mic gain ─┐
 *                                        ├─ mix ─ limiter ─ broadcast gain ─ context sink (virtual cable)
 *  clips ─ clip gain ─ soundboard gain ──┘            └──── monitor bus ─ headphones (optional)
 *
 *  editor / TTS / Studio preview ─ preview bus ─ preview limiter ─ headphones only (never the mix)
 *
 * The broadcast gain stays at zero unless a broadcast is deliberately connected,
 * so the microphone can be captured for headphone preview without leaking anywhere.
 */
/** Loudness target for auto-leveled clips, in dBFS RMS (speech into a mic sits around -18 to -14). */
export const LEVEL_TARGET_DB = -13;
export const INSTANCE_LIMITS = Object.freeze({ total: 32, perClip: 8 });
const MAX_BOOST_DB = 20, MAX_CUT_DB = -14;
const dbToGain = db => 10 ** (db / 20);
const LOOP_FADE_MIN_SECONDS = 0.05;

/**
 * RMS loudness of frames [start, end) in dBFS, ignoring near-silent blocks so gaps and fades don't skew it.
 * Regions shorter than one analysis block are measured as a single block. Silence returns null (no boost).
 */
export function measureLoudness(buffer, start = 0, end = buffer.length) {
    const size = Math.max(1, Math.min(2048, end - start));
    let sum = 0, count = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const data = buffer.getChannelData(channel);
        for (let block = start; block + size <= end; block += size) {
            let energy = 0;
            for (let i = block; i < block + size; i++) energy += data[i] * data[i];
            if (Math.sqrt(energy / size) > 0.003) { sum += energy; count += size; }
        }
    }
    if (!count) return null;
    return Math.max(-60, 20 * Math.log10(Math.sqrt(sum / count)));
}

/** Makeup gain (dB) that brings a clip of the given loudness to the target. */
export function levelGainDb(loudness, peak) {
    if (!Number.isFinite(loudness)) return 0;
    const target = Math.max(MAX_CUT_DB, Math.min(MAX_BOOST_DB, LEVEL_TARGET_DB - loudness));
    // Leave 3 dB of peak headroom instead of forcing transient sounds into compression.
    return Number.isFinite(peak) && peak > 0 ? Math.min(target, -3 - 20 * Math.log10(peak)) : target;
}

export function measurePeak(buffer, start = 0, end = buffer.length) {
    let peak = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const data = buffer.getChannelData(channel);
        for (let i = start; i < end; i++) { const value = Math.abs(data[i]); if (value > peak) peak = value; }
    }
    return peak;
}

export class AudioEngine extends EventTarget {
    constructor() {
        super();
        this.analysis = new Map();
        this.context = null;
        this.stream = null;
        this.source = null;
        this.connected = false;
        this.previewing = false;
        this.muted = false;
        this.monitoring = false;
        this.buffers = new Map();
        this.instances = new Map();
        this.nextInstance = 1;
        this.regionWarnings = new Set();
        this.effect = null;
        this.settings = {};
        this.monitor = new Audio();
        this.monitor.autoplay = true;
        this.previewOut = new Audio();
        this.previewOut.autoplay = true;
        this.auditionSession = null;
        this.replay = null;
    }

    emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

    async init() {
        if (this.initializing) return this.initializing;
        this.initializing = this.initialize();
        try { await this.initializing; }
        finally { this.initializing = null; }
    }

    async initialize() {
        if (this.context) { await this.context.resume(); return; }
        const ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000, sinkId: { type: 'none' } });
        if (!ctx.setSinkId) { await ctx.close(); throw new Error('This audio runtime cannot select an output device.'); }
        try { await ctx.audioWorklet.addModule('./limiter-worklet.js'); await ctx.audioWorklet.addModule('./ducking-worklet.js'); }
        catch (error) { await ctx.close(); throw error; }
        this.context = ctx;
        ctx.addEventListener('sinkchange', () => {
            if (this.connected && ctx.sinkId !== this.settings.outputId) {
                this.disconnect();
                this.emit('fault', 'The broadcast output changed. Choose your output and reconnect.');
            }
        });
        this.board = ctx.createGain();
        this.mic = ctx.createGain();
        // The ducker sits between the board and the mix only while ducking is on (see routeDucking), so it costs nothing otherwise.
        this.boardOut = this.board; this.ducker = null; this.duckGain = 1;
        this.mix = ctx.createGain();
        this.limiter = new AudioWorkletNode(ctx, 'peak-limiter', { outputChannelCount: [2] });
        this.boardOut.connect(this.mix); this.mic.connect(this.mix); this.mix.connect(this.limiter);
        this.broadcast = ctx.createGain(); this.broadcast.gain.value = 0;
        this.limiter.connect(this.broadcast); this.broadcast.connect(ctx.destination);
        this.meter = ctx.createAnalyser(); this.meter.fftSize = 256; this.limiter.connect(this.meter);
        this.micMeter = ctx.createAnalyser(); this.micMeter.fftSize = 256; this.mic.connect(this.micMeter);
        this.monitorBus = ctx.createGain(); this.monitorBus.gain.value = 0;
        this.monitorLimiter = new AudioWorkletNode(ctx, 'peak-limiter', { outputChannelCount: [2], processorOptions: { ceiling: 10 ** (-3 / 20) } });
        this.monitorDestination = ctx.createMediaStreamDestination();
        this.monitorBus.connect(this.monitorLimiter); this.monitorLimiter.connect(this.monitorDestination);
        this.monitor.srcObject = this.monitorDestination.stream;
        // Private preview route: its own limiter and media element, never connected to the board or broadcast.
        this.previewBus = ctx.createGain();
        this.previewLimiter = new AudioWorkletNode(ctx, 'peak-limiter', { outputChannelCount: [2], processorOptions: { ceiling: 10 ** (-3 / 20) } });
        this.previewDestination = ctx.createMediaStreamDestination();
        // The preview limiter reaches its output only during a preview, so an idle preview route does no work.
        this.previewBus.connect(this.previewLimiter);
        this.previewOut.srcObject = this.previewDestination.stream;
        this.setMonitorVoice(Boolean(this.settings.monitorVoice));
        this.applySettings(this.settings);
        await ctx.resume();
    }

    /**
     * Shared microphone ownership. Each device has at most one stream; every user (the live mixer, a
     * recording) holds a lease, and the stream stops only when its last lease is released. A lease that
     * is cancelled while permission is pending releases the stream as soon as it arrives.
     */
    async acquireMic(deviceId, { isCancelled = () => false } = {}) {
        if (!deviceId || deviceId === 'none') throw new Error('Choose your microphone, or choose Sounds only.');
        await this.init();
        this.micPool ??= new Map();
        let entry = this.micPool.get(deviceId);
        if (!entry) {
            entry = { deviceId, users: new Set(), listeners: new Set(), stream: null, source: null };
            this.micPool.set(deviceId, entry);
            entry.ready = (async () => {
                if (window.deck?.requestMicrophone && !await window.deck.requestMicrophone()) throw new Error(microphoneHelp);
                let stream;
                try {
                    stream = await navigator.mediaDevices.getUserMedia({
                        video: false,
                        audio: { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }
                    });
                } catch (error) {
                    if (['NotAllowedError', 'SecurityError'].includes(error?.name)) throw new Error(`Microphone access was denied. ${microphoneHelp}`);
                    if (['NotFoundError', 'OverconstrainedError'].includes(error?.name)) throw new Error('That microphone is not connected. Plug it in, click Scan devices, and try again.');
                    throw error;
                }
                entry.stream = stream;
                entry.source = this.context.createMediaStreamSource(stream);
                for (const track of stream.getAudioTracks()) {
                    track.addEventListener('ended', () => {
                        // A dead stream is never reused; current users are told so they can keep what they have.
                        if (this.micPool.get(deviceId) === entry) this.micPool.delete(deviceId);
                        for (const listener of [...entry.listeners]) listener();
                    });
                }
            })();
            entry.ready.catch(() => { if (this.micPool.get(deviceId) === entry) this.micPool.delete(deviceId); });
        }
        const lease = { deviceId, released: false, listeners: new Set() };
        entry.users.add(lease);
        lease.release = () => {
            if (lease.released) return;
            lease.released = true;
            entry.users.delete(lease);
            for (const listener of lease.listeners) entry.listeners.delete(listener);
            if (!entry.users.size) {
                if (this.micPool.get(deviceId) === entry) this.micPool.delete(deviceId);
                try { entry.source?.disconnect(); } catch { /* already disconnected */ }
                entry.stream?.getTracks().forEach(track => track.stop());
            }
        };
        lease.onEnded = callback => {
            const listener = () => callback();
            lease.listeners.add(listener); entry.listeners.add(listener);
            return () => { lease.listeners.delete(listener); entry.listeners.delete(listener); };
        };
        try { await entry.ready; }
        catch (error) { lease.release(); throw error; }
        lease.stream = entry.stream; lease.source = entry.source;
        if (isCancelled()) { lease.release(); throw Object.assign(new Error('Recording cancelled.'), { code: 'CANCELLED' }); }
        return lease;
    }

    /** Opens the microphone for the live mix and wires a private tap through the current voice effect. */
    async captureMic(micId) {
        if (!micId) throw new Error('Choose your microphone, or choose Sounds only.');
        const lease = await this.acquireMic(micId);
        this.releaseMic();
        this.micLease = lease;
        this.stream = lease.stream;
        this.source = this.context.createGain();
        lease.source.connect(this.source);
        lease.offEnded = lease.onEnded(() => {
            if (this.micLease === lease && (this.connected || this.previewing)) {
                this.disconnect();
                this.emit('fault', 'Your microphone disconnected. Select it again and reconnect.');
            }
        });
        this.setEffect(this.settings.effect || 'clean');
    }

    /** Releases only the live mixer's lease; a recording on the same device keeps its stream. */
    releaseMic() {
        this.clearEffects();
        const lease = this.micLease, tap = this.source;
        if (tap) { try { lease?.source.disconnect(tap); } catch { /* not connected */ } tap.disconnect(); }
        this.source = null; this.stream = null; this.micLease = null;
        lease?.offEnded?.();
        lease?.release();
    }

    /** Number of live microphone streams (for leak checks). */
    micStreams() { return this.micPool?.size || 0; }

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
        this.stopPads('disconnect');
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
        this.previewBus.gain.setTargetAtTime((this.settings.monitorVolume ?? 50) / 100, now, 0.015);
        this.routeDucking();
    }

    /** Inserts the ducker while ducking is on. Turning it off releases toward unity first, then bypasses it. */
    routeDucking() {
        if (!this.context) return;
        const settings = this.duckingSettings();
        clearTimeout(this.duckBypassTimer);
        if (settings.enabled) {
            if (this.ducker) { this.ducker.port.postMessage(settings); return; }
            // Board → ducker (input 0), live mic after mute/gain → ducker (input 1). The ducker only lowers the board.
            const ducker = new AudioWorkletNode(this.context, 'ducker', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: settings });
            ducker.port.onmessage = event => { if (this.ducker === ducker) this.duckGain = event.data.gain; };
            this.mic.connect(ducker, 0, 1);
            this.board.connect(ducker, 0, 0);
            this.ducker = ducker; this.duckGain = 1;
            this.swapBoardOut(ducker);
        } else if (this.ducker) {
            const ducker = this.ducker;
            ducker.port.postMessage(settings);
            this.duckBypassTimer = setTimeout(() => {
                if (this.ducker !== ducker || this.duckingSettings().enabled) return;
                this.swapBoardOut(this.board);
                try { this.board.disconnect(ducker); } catch { /* already disconnected */ }
                try { this.mic.disconnect(ducker); } catch { /* already disconnected */ }
                ducker.disconnect(); ducker.port.onmessage = null;
                this.ducker = null; this.duckGain = 1;
            }, settings.release + 150);
        }
    }

    /** Moves the board's route to the mix (and to headphone monitoring without voice) onto `node`. */
    swapBoardOut(node) {
        const old = this.boardOut;
        if (old === node) return;
        try { old.disconnect(this.mix); } catch { /* not connected */ }
        try { old.disconnect(this.monitorBus); } catch { /* not connected */ }
        node.connect(this.mix);
        if (!this.settings.monitorVoice) node.connect(this.monitorBus);
        this.boardOut = node;
    }

    /** Ducking parameters from settings (off unless the user turned it on). */
    duckingSettings() {
        const d = this.settings.ducking || {};
        return { enabled: Boolean(d.enabled), threshold: d.threshold ?? -35, reduction: d.reduction ?? 12, attack: d.attack ?? 20, hold: d.hold ?? 150, release: d.release ?? 300 };
    }

    /** Current board reduction in dB (0 when not ducking). */
    duckingDb() { return this.duckGain > 0 ? 20 * Math.log10(this.duckGain) : -60; }

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
        try { this.boardOut.disconnect(this.monitorBus); } catch { /* not connected */ }
        try { this.limiter.disconnect(this.monitorBus); } catch { /* not connected */ }
        (includeVoice ? this.limiter : this.boardOut).connect(this.monitorBus);
    }

    async setMonitoring(enabled, deviceId) {
        if (!enabled) {
            this.monitoring = false;
            this.monitor.pause();
            this.applySettings(this.settings);
            if (!this.connected) { this.stopPads('monitor'); this.stopPreview(); }
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

    /* ─── Clip decoding and region analysis ─── */

    async load(clip) {
        let buffer = this.buffers.get(clip.id);
        if (buffer) {
            this.buffers.delete(clip.id); this.buffers.set(clip.id, buffer);
        } else {
            await this.init();
            const bytes = await window.deck.readSound(clip.id);
            try { buffer = await this.context.decodeAudioData(new Uint8Array(bytes).buffer); }
            catch { throw new Error(`“${clip.name}” could not be decoded. Try exporting it as MP3 or WAV.`); }
            const size = b => b.length * b.numberOfChannels * 4;
            const maxBytes = 128 * 1024 * 1024;
            if (size(buffer) > maxBytes) throw new Error('This sound is too long. Trim it to a shorter clip before importing.');
            let total = [...this.buffers.values()].reduce((sum, item) => sum + size(item), 0);
            const busy = new Set(this.activeClipIds());
            for (const [id, cached] of this.buffers) {
                if (total + size(buffer) <= maxBytes) break;
                if (!busy.has(id)) { this.buffers.delete(id); total -= size(cached); }
            }
            if (total + size(buffer) > maxBytes) throw new Error('Stop some playing sounds before loading another large clip.');
            this.buffers.set(clip.id, buffer);
        }
        this.analyze(clip, buffer);
        return buffer;
    }

    /** Measures the played region once per region; the cache is keyed by the region, so edits invalidate it. */
    analyze(clip, buffer) {
        const key = regionKey(clip.playback);
        if (this.analysis.get(clip.id)?.key === key) return this.analysis.get(clip.id);
        const region = resolveRegion(clip.playback, buffer);
        const result = { key, loudness: measureLoudness(buffer, region.startFrame, region.endFrame), peak: measurePeak(buffer, region.startFrame, region.endFrame) };
        this.analysis.set(clip.id, result);
        this.emit('analysis', { id: clip.id, duration: buffer.duration, loudness: result.loudness, peak: result.peak, analysisKey: key });
        return result;
    }

    /** Current loudness/peak for a clip's region: fresh analysis, else saved values measured for the same region. */
    analysisFor(clip) {
        const key = regionKey(clip.playback);
        const cached = this.analysis.get(clip.id);
        if (cached?.key === key) return cached;
        const savedKey = clip.analysisKey || 'full';
        if (savedKey === key && Number.isFinite(clip.loudness)) return { key, loudness: clip.loudness, peak: clip.peak };
        return null;
    }

    /** Re-applies clip gains to everything playing, e.g. after toggling auto-level. */
    relevel(clips) {
        for (const clip of clips) this.updateClip(clip);
    }

    /** Linear gain for a clip: its own volume, plus auto-leveling when enabled. */
    clipGain(clip) {
        const analysis = this.analysisFor(clip);
        const level = this.settings.autoLevel === false || !analysis ? 0 : levelGainDb(analysis.loudness, analysis.peak);
        return ((clip.volume ?? 100) / 100) * dbToGain(level);
    }

    /* ─── Playback instances ─── */

    /** Clip ids that are loading or playing, in start order. */
    activeClipIds() { return [...new Set([...this.instances.values()].map(inst => inst.clipId))]; }
    clipInstances(clipId) { return [...this.instances.values()].filter(inst => inst.clipId === clipId); }
    clipCount(clipId) { return this.clipInstances(clipId).length; }
    isLoading(clipId) { const list = this.clipInstances(clipId); return list.length > 0 && list.every(inst => inst.state === 'loading'); }
    get playingCount() { return this.activeClipIds().length; }

    register(clip, { owner, loop, from, gainOverride = null }) {
        let resolve;
        const done = new Promise(r => { resolve = r; });
        const inst = { id: this.nextInstance++, clipId: clip.id, groupId: clip.exclusiveGroupId || '', owner, loop, from, gainOverride, state: 'loading', resolve, done };
        inst.handle = { id: inst.id, clipId: clip.id, owner, done };
        this.instances.set(inst.id, inst);
        this.emit('playing', this.activeClipIds());
        return inst;
    }

    /**
     * Region-aware playback for every trigger path (pad, shortcut, overlay, queue).
     * Resolves with a handle whose `done` promise reports { reason } once that specific instance finishes,
     * or null when a Toggle pad was stopped instead.
     */
    async play(clip, { mode, owner = 'pad', from = 0 } = {}) {
        let trigger = mode || clip.triggerMode || 'toggle';
        const loop = owner === 'queue' ? false : Boolean(clip.loop);
        if (loop && trigger === 'overlap') trigger = 'restart';
        const active = this.clipInstances(clip.id);
        if (trigger === 'toggle' && active.length && owner !== 'queue') { this.stop(clip.id, 'toggle'); return null; }
        if (!this.connected && !this.monitoring) throw new Error('Connect the broadcast or enable headphone monitoring before playing sounds.');
        if (trigger === 'overlap') {
            if (active.length >= INSTANCE_LIMITS.perClip) throw new Error(`“${clip.name}” is already playing ${INSTANCE_LIMITS.perClip} times. Stop it before starting another copy.`);
        } else this.stop(clip.id, 'restart');
        if (this.instances.size >= INSTANCE_LIMITS.total) throw new Error(`${INSTANCE_LIMITS.total} sounds are already playing. Stop some before starting another.`);
        if (clip.exclusiveGroupId) {
            for (const other of [...this.instances.values()]) if (other.groupId === clip.exclusiveGroupId && other.clipId !== clip.id) this.stopInstance(other, 'group');
        }
        const inst = this.register(clip, { owner, loop, from });
        try {
            const buffer = await this.load(clip);
            if (this.instances.get(inst.id) !== inst) return inst.handle; // stopped while decoding
            this.startInstance(inst, clip, buffer);
        } catch (error) {
            this.finish(inst, 'error');
            throw error;
        }
        return inst.handle;
    }

    /** Plays already-decoded audio (text to speech) through the soundboard bus, like a pad. */
    async playBuffer(buffer, { id = `buffer-${this.nextInstance}`, name = 'Speech', volume = 100 } = {}) {
        if (!this.connected) throw new Error('Connect audio first. Speech plays only through your broadcast output, never your speakers.');
        if (this.instances.size >= INSTANCE_LIMITS.total) throw new Error(`${INSTANCE_LIMITS.total} sounds are already playing. Stop some before starting another.`);
        const clip = { id, name, volume, playback: null, loop: false, exclusiveGroupId: '' };
        const inst = this.register(clip, { owner: 'buffer', loop: false, from: 0, gainOverride: volume / 100 });
        this.startInstance(inst, clip, buffer);
        return inst.handle;
    }

    startInstance(inst, clip, buffer) {
        const ctx = this.context;
        const region = resolveRegion(clip.playback, buffer);
        if (region.warning && !this.regionWarnings.has(clip.id)) {
            this.regionWarnings.add(clip.id);
            this.emit('fault', `“${clip.name}”: ${region.warning}`);
        }
        const source = ctx.createBufferSource(), env = ctx.createGain(), gain = ctx.createGain();
        source.buffer = buffer;
        gain.gain.value = inst.gainOverride ?? this.clipGain(clip);
        source.connect(env); env.connect(gain); gain.connect(this.board);
        const when = ctx.currentTime;
        const from = Math.max(0, Math.min(Number(inst.from) || 0, region.duration - 1 / buffer.sampleRate));
        Object.assign(inst, { state: 'playing', source, env, gain, region, startedAt: when - from, duration: region.duration });
        if (inst.loop) {
            source.loop = true; source.loopStart = region.start; source.loopEnd = region.end;
            if (region.fadeIn || region.fadeOut) this.scheduleLoopFades(inst, when - from);
            source.start(when, region.start + from);
        } else {
            applyEnvelope(env.gain, when, envelopePoints(region.duration, region.fadeIn, region.fadeOut, { from }), from);
            source.start(when, region.start + from, region.duration - from);
        }
        source.onended = () => {
            source.disconnect(); env.disconnect(); gain.disconnect();
            if (this.instances.get(inst.id) === inst) this.finish(inst, 'ended');
        };
        this.emit('playing', this.activeClipIds());
    }

    /** Repeats the user's fades on every loop cycle, scheduled a little ahead on the audio clock. */
    scheduleLoopFades(inst, cycleZero) {
        const { region, env } = inst, length = region.duration;
        if (length < LOOP_FADE_MIN_SECONDS) return;
        const points = envelopePoints(length, region.fadeIn, region.fadeOut, { antiClick: false });
        let cycle = 0;
        const tick = () => {
            if (this.instances.get(inst.id) !== inst) return;
            const horizon = this.context.currentTime + 1.5;
            for (let n = 0; n < 64 && cycleZero + cycle * length < horizon; n++, cycle++) {
                const at = cycleZero + cycle * length;
                if (at + length <= this.context.currentTime) continue;
                env.gain.setValueAtTime(points[0][1], Math.max(at, this.context.currentTime));
                for (const [t, value] of points.slice(1)) env.gain.linearRampToValueAtTime(value, at + t);
            }
        };
        tick();
        inst.fadeTimer = setInterval(tick, 400);
    }

    finish(inst, reason, extra = {}) {
        if (this.instances.get(inst.id) !== inst) return;
        this.instances.delete(inst.id);
        clearInterval(inst.fadeTimer);
        inst.state = 'done';
        inst.resolve({ reason, ...extra });
        this.emit('playing', this.activeClipIds());
    }

    /** Region-relative position of an instance in seconds. */
    position(inst) {
        if (inst.state !== 'playing' || !this.context) return inst.from || 0;
        const elapsed = Math.max(0, this.context.currentTime - inst.startedAt);
        return inst.loop ? elapsed % inst.duration : Math.min(inst.duration, elapsed);
    }

    stopInstance(inst, reason = 'stop') {
        if (this.instances.get(inst.id) !== inst) return null;
        const position = this.position(inst);
        if (inst.source) {
            const now = this.context.currentTime, param = inst.env.gain;
            try {
                if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(now); else param.cancelScheduledValues(now);
                param.setTargetAtTime(0, now, 0.002);
                inst.source.stop(now + 0.012);
            } catch { /* already stopped */ }
        }
        this.finish(inst, reason, { position });
        return position;
    }

    /** Stops one handle (queue next/pause). Returns the region-relative position it reached. */
    stopHandle(handle, reason = 'queue') {
        const inst = this.instances.get(handle?.id);
        return inst ? this.stopInstance(inst, reason) : null;
    }

    /** Playback position of a clip from 0 to 1 (its most recent instance), or null when it is not playing. */
    progress(clipId) {
        const latest = this.clipInstances(clipId).filter(inst => inst.state === 'playing').at(-1);
        if (!latest || !this.context) return null;
        return latest.duration ? this.position(latest) / latest.duration : 0;
    }

    /** Applies volume/auto-level changes to a clip's playing instances. */
    updateClip(clip) {
        if (!clip) return;
        for (const inst of this.clipInstances(clip.id)) {
            if (inst.state === 'playing' && inst.gainOverride === null) inst.gain.gain.setTargetAtTime(this.clipGain(clip), this.context.currentTime, 0.01);
        }
    }

    stop(clipId, reason = 'stop') {
        for (const inst of this.clipInstances(clipId)) this.stopInstance(inst, reason);
        this.emit('playing', this.activeClipIds());
    }

    stopPads(reason = 'stopAll') {
        for (const inst of [...this.instances.values()]) this.stopInstance(inst, reason);
    }

    /** Stop all: every pad, queued sound, and preview. Microphone, replay, and recordings keep running. */
    stopAll() {
        this.stopPads('stopAll');
        this.stopAudition();
        this.emit('stopall');
    }

    forget(id) { this.stop(id, 'forget'); this.buffers.delete(id); this.analysis.delete(id); this.regionWarnings.delete(id); }

    /** Drops cached analysis after a region edit so the next play measures the new region. */
    invalidate(id) { this.analysis.delete(id); this.regionWarnings.delete(id); }

    /* ─── Private preview (headphones only) ─── */

    /** Throws when a preview would have to use the default output or the broadcast output. */
    checkPreviewDevice(deviceId) {
        if (!deviceId || ['default', 'communications', 'none'].includes(deviceId)) throw Object.assign(new Error('Choose your headphones in the mixer to preview. Previews play only in your headphones.'), { code: 'NO_PREVIEW_DEVICE' });
        if (deviceId === this.settings.outputId) throw Object.assign(new Error('Your headphones and broadcast output are the same device. Choose separate headphones to preview privately.'), { code: 'NO_PREVIEW_DEVICE' });
    }

    /**
     * Starts a preview session routed to headphones. Only one preview runs at a time; starting another
     * or pressing Stop all ends it. Callers connect sources to `session.input` and register them with `session.add`.
     */
    async startAudition(deviceId) {
        this.stopAudition();
        const epoch = this.auditionEpoch;
        await this.init();
        if (epoch !== this.auditionEpoch) throw Object.assign(new Error('Preview cancelled.'), { code: 'CANCELLED' });
        this.checkPreviewDevice(deviceId);
        const input = this.context.createGain();
        input.connect(this.previewBus);
        let resolve;
        const session = { input, sources: [], stopped: false, startedAt: 0, done: new Promise(r => { resolve = r; }) };
        session.resolve = resolve;
        session.add = source => { session.sources.push(source); return source; };
        this.auditionSession = session;
        this.previewLimiter.connect(this.previewDestination);
        try {
            await this.previewOut.setSinkId(deviceId);
            await this.previewOut.play();
        } catch (error) {
            if (this.auditionSession === session) this.stopAudition();
            throw new Error(`Preview could not play in your headphones (${error.message || error}). Choose them again in the mixer.`);
        }
        if (session.stopped) throw Object.assign(new Error('Preview cancelled.'), { code: 'CANCELLED' });
        session.startedAt = this.context.currentTime;
        this.emit('audition', true);
        return session;
    }

    /** Previews part of a decoded buffer with the same region, fade, and anti-click rules as pads. */
    async auditionBuffer(buffer, { deviceId, playback = null, gain = 1 } = {}) {
        const session = await this.startAudition(deviceId);
        if (session.stopped) throw Object.assign(new Error('Preview cancelled.'), { code: 'CANCELLED' });
        const ctx = this.context, region = resolveRegion(playback, buffer);
        const source = session.add(ctx.createBufferSource()), env = ctx.createGain(), level = ctx.createGain();
        source.buffer = buffer; level.gain.value = gain;
        source.connect(env); env.connect(level); level.connect(session.input);
        const when = ctx.currentTime;
        applyEnvelope(env.gain, when, envelopePoints(region.duration, region.fadeIn, region.fadeOut));
        source.start(when, region.start, region.duration);
        Object.assign(session, { startedAt: when, region });
        source.onended = () => { if (this.auditionSession === session) this.stopAudition('ended'); };
        return session;
    }

    auditionTime() {
        const session = this.auditionSession;
        return session && this.context ? Math.max(0, this.context.currentTime - session.startedAt) : null;
    }

    stopAudition(reason = 'stopped') {
        this.auditionEpoch = (this.auditionEpoch || 0) + 1;
        const session = this.auditionSession;
        if (!session) return;
        this.auditionSession = null;
        session.stopped = true;
        for (const source of session.sources) { try { source.onended = null; source.stop(); } catch { /* not started */ } }
        try { session.input.disconnect(); } catch { /* already disconnected */ }
        try { this.previewLimiter.disconnect(this.previewDestination); } catch { /* already disconnected */ }
        this.previewOut.pause();
        session.resolve({ reason });
        this.emit('audition', false);
    }

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
                const detail = error.message || String(error);
                if (error.name === 'NotAllowedError') {
                    throw new Error(`System audio access was denied. Allow PulseDeck under System Audio Recording in System Settings → Privacy & Security → Screen & System Audio Recording, then quit and reopen PulseDeck. ${detail}`);
                }
                throw new Error(`Could not start Mac system audio capture. Quit and reopen PulseDeck, then try again. ${detail}`);
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

    /** Pulls the most recent `seconds` from the ring buffer as mono float samples, without interrupting capture. */
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
