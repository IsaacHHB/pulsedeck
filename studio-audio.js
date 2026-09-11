import { envelopePoints, applyEnvelope } from './playback-region.js';
import { audibleTrackIds, renderRange, regionLength, SAMPLE_RATE, STUDIO_LIMITS, wavBytes } from './studio-model.js';
import { encodeWavChannels } from './wav.js';

/**
 * One scheduling function for Studio preview (a live AudioContext) and final render (OfflineAudioContext),
 * so gain, pan, fades, anti-click ramps, mute/solo, and timing always agree.
 */
export const RENDER_CEILING = 10 ** (-1 / 20);
const LIMITER_DELAY = Math.max(1, Math.round(SAMPLE_RATE * 0.005));
const dbToGain = db => 10 ** (db / 20);

/**
 * Schedules every audible region that overlaps [from, to) on the project timeline.
 * Timeline time `from` plays at context time `when`. Mono audio is duplicated to both channels at
 * unity; pan is a balance control (−1 left … +1 right) applied identically to mono and stereo sources.
 */
export function scheduleProject(ctx, destination, project, buffers, { from = 0, to = Infinity, when = 0 } = {}) {
    const audible = audibleTrackIds(project), tracks = new Map(), sources = [];
    for (const track of project.tracks) {
        if (!audible.has(track.id)) continue;
        const gain = ctx.createGain(); gain.gain.value = dbToGain(track.gainDb); gain.connect(destination);
        tracks.set(track.id, gain);
    }
    for (const region of project.regions) {
        const trackNode = tracks.get(region.trackId);
        if (!trackNode) continue;
        const buffer = buffers.get(region.assetId);
        if (!buffer) throw new Error(`Audio for “${region.label || 'a region'}” is missing. Undo the change or remove the region.`);
        const length = regionLength(region), start = region.atSeconds, end = start + length;
        if (end <= from || start >= to) continue;
        const skip = Math.max(0, from - start), playLength = Math.min(end, to) - Math.max(start, from);
        const source = ctx.createBufferSource(); source.buffer = buffer;
        // Explicit stereo with speaker up-mixing copies a mono source to both channels unchanged.
        const env = ctx.createGain(); env.channelCount = 2; env.channelCountMode = 'explicit'; env.channelInterpretation = 'speakers';
        const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2), left = ctx.createGain(), right = ctx.createGain();
        const level = dbToGain(region.gainDb);
        left.gain.value = level * (region.pan > 0 ? 1 - region.pan : 1);
        right.gain.value = level * (region.pan < 0 ? 1 + region.pan : 1);
        source.connect(env); env.connect(split);
        split.connect(left, 0); split.connect(right, 1);
        left.connect(merge, 0, 0); right.connect(merge, 0, 1); merge.connect(trackNode);
        const at = when + Math.max(0, start - from);
        applyEnvelope(env.gain, at, envelopePoints(length, region.fadeInMs / 1000, region.fadeOutMs / 1000, { from: skip }), skip);
        source.start(at, region.inSeconds + skip, playLength);
        sources.push(source);
    }
    return sources;
}

export function measurePeak(buffer) {
    let peak = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) for (const v of buffer.getChannelData(c)) { const a = Math.abs(v); if (a > peak) peak = a; }
    return peak;
}

/**
 * Renders the project (or its export range) at 48 kHz stereo. If the sum would exceed −1 dBFS,
 * the tested lookahead limiter runs offline as a second pass and `limited` reports it.
 * `isCancelled()` is checked between passes: an offline render cannot abort, but its result is discarded.
 */
export async function renderProject(project, buffers, { onProgress = () => {}, isCancelled = () => false } = {}) {
    const { startSeconds, endSeconds } = renderRange(project);
    const frames = Math.round((endSeconds - startSeconds) * SAMPLE_RATE);
    if (frames < 1) throw new Error('Nothing to render. Add audio to an unmuted track first.');
    if (endSeconds - startSeconds > STUDIO_LIMITS.timelineSeconds + 1e-6) throw new Error('The timeline is limited to 3 minutes.');
    // Preflight memory: two float passes of stereo audio.
    if (frames * 2 * 4 * 2 > 512 * 1024 * 1024) throw new Error('This render needs too much memory. Shorten the export range.');
    const ctx = new OfflineAudioContext(2, frames, SAMPLE_RATE);
    scheduleProject(ctx, ctx.destination, project, buffers, { from: startSeconds, to: endSeconds, when: 0 });
    const step = Math.max(0.5, (endSeconds - startSeconds) / 10);
    for (let t = step; t < endSeconds - startSeconds; t += step) {
        const at = t;
        ctx.suspend(at).then(() => { onProgress(Math.min(0.9, at / (endSeconds - startSeconds) * 0.9)); ctx.resume(); }).catch(() => {});
    }
    const mixed = await ctx.startRendering();
    if (isCancelled()) return null;
    const peakBefore = measurePeak(mixed);
    if (peakBefore <= RENDER_CEILING) { onProgress(1); return { buffer: mixed, limited: false, peakBefore, peak: peakBefore }; }
    const limited = await limitOffline(mixed);
    if (isCancelled()) return null;
    onProgress(1);
    return { buffer: limited, limited: true, peakBefore, peak: measurePeak(limited) };
}

/** Runs limiter-worklet.js offline and removes its fixed 5 ms lookahead delay so timing is unchanged. */
export async function limitOffline(buffer, ceiling = RENDER_CEILING) {
    const ctx = new OfflineAudioContext(2, buffer.length + LIMITER_DELAY, SAMPLE_RATE);
    await ctx.audioWorklet.addModule('./limiter-worklet.js');
    const source = ctx.createBufferSource(); source.buffer = buffer;
    const limiter = new AudioWorkletNode(ctx, 'peak-limiter', { outputChannelCount: [2], processorOptions: { ceiling } });
    source.connect(limiter); limiter.connect(ctx.destination); source.start(0);
    const out = await ctx.startRendering();
    const trimmed = new AudioBuffer({ length: buffer.length, numberOfChannels: 2, sampleRate: SAMPLE_RATE });
    for (let c = 0; c < 2; c++) trimmed.copyToChannel(out.getChannelData(c).subarray(LIMITER_DELAY, LIMITER_DELAY + buffer.length), c);
    return trimmed;
}

/** PCM16 WAV bytes for a rendered buffer, with the size known before encoding. */
export function bufferToWav(buffer) {
    return encodeWavChannels(Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)), buffer.sampleRate);
}
export const renderedBytes = buffer => wavBytes(buffer.length, buffer.numberOfChannels);

/**
 * Converts decoded audio (already resampled to 48 kHz by the engine's context) into a canonical
 * project asset: PCM16, mono or stereo, at most 3 minutes. Longer selections are rejected, never truncated.
 */
export function canonicalAsset(buffer, { inSeconds = 0, outSeconds = buffer.duration } = {}) {
    if (buffer.sampleRate !== SAMPLE_RATE) throw new Error('Audio must be decoded at 48 kHz before adding it to a project.');
    if (buffer.numberOfChannels > 2) throw new Error(`This audio has ${buffer.numberOfChannels} channels. Studio supports mono and stereo; export it as stereo first.`);
    const start = Math.max(0, Math.round(inSeconds * SAMPLE_RATE)), end = Math.min(buffer.length, Math.round(outSeconds * SAMPLE_RATE));
    const frames = end - start;
    if (frames < 1) throw new Error('The selection is empty.');
    if (frames / SAMPLE_RATE > STUDIO_LIMITS.assetSeconds + 1e-6) throw new Error(`This selection is ${Math.round(frames / SAMPLE_RATE)} seconds long. Project audio is limited to 3 minutes; choose a shorter selection.`);
    if (wavBytes(frames, buffer.numberOfChannels) > STUDIO_LIMITS.assetBytes) throw new Error('This selection is larger than 64 MB. Choose a shorter selection.');
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).subarray(start, end));
    return { bytes: encodeWavChannels(channels, SAMPLE_RATE), duration: frames / SAMPLE_RATE, channels: channels.length };
}

/** Mono float samples (replay snapshots, microphone takes) as a canonical asset. */
export function samplesToAsset(samples, sampleRate = SAMPLE_RATE) {
    if (sampleRate !== SAMPLE_RATE) throw new Error('Recordings must be 48 kHz.');
    if (!samples.length) throw new Error('The recording is empty.');
    if (samples.length / SAMPLE_RATE > STUDIO_LIMITS.assetSeconds + 1e-6) throw new Error('Recordings are limited to 3 minutes.');
    return { bytes: encodeWavChannels([samples], SAMPLE_RATE), duration: samples.length / SAMPLE_RATE, channels: 1 };
}
