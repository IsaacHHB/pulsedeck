/**
 * Encodes one (mono) or two (stereo) channels of float samples as interleaved 16-bit PCM WAV.
 * Samples are clamped to ±1 as a last resort; Studio renders are peak-limited before they get here.
 */
export function encodeWavChannels(channels, sampleRate) {
    const count = channels.length, frames = channels[0]?.length ?? 0;
    if (count < 1 || count > 2) throw new Error('Only mono and stereo WAV files are supported.');
    if (channels.some(channel => channel.length !== frames)) throw new Error('Every channel must have the same length.');
    const dataBytes = frames * count * 2;
    const bytes = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(bytes);
    const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
    text(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); text(8, 'WAVE');
    text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, count, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * count * 2, true); view.setUint16(32, count * 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, dataBytes, true);
    let offset = 44;
    for (let i = 0; i < frames; i++) {
        for (let c = 0; c < count; c++, offset += 2) {
            const clamped = Math.max(-1, Math.min(1, channels[c][i]));
            view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
        }
    }
    return new Uint8Array(bytes);
}

/** Encodes mono float samples as a 16-bit PCM WAV file. */
export function encodeWav(samples, sampleRate) {
    return encodeWavChannels([samples], sampleRate);
}

/** Peak envelope of a buffer for drawing a waveform with `columns` bars. */
export function waveformPeaks(samples, columns) {
    const peaks = new Float32Array(columns);
    const step = samples.length / columns;
    for (let column = 0; column < columns; column++) {
        const start = Math.floor(column * step), end = Math.min(samples.length, Math.floor((column + 1) * step) || start + 1);
        let peak = 0;
        for (let i = start; i < end; i++) { const value = Math.abs(samples[i]); if (value > peak) peak = value; }
        peaks[column] = peak;
    }
    return peaks;
}

/** Trims silence-free head/tail padding: returns [startSeconds, endSeconds] of the audible region, with a little margin. */
export function audibleRange(samples, sampleRate, threshold = 0.01, margin = 0.15) {
    let first = -1, last = -1;
    for (let i = 0; i < samples.length; i++) { if (Math.abs(samples[i]) > threshold) { first = i; break; } }
    for (let i = samples.length - 1; i >= 0; i--) { if (Math.abs(samples[i]) > threshold) { last = i; break; } }
    if (first === -1) return [0, samples.length / sampleRate];
    return [Math.max(0, first / sampleRate - margin), Math.min(samples.length / sampleRate, last / sampleRate + margin)];
}
