/**
 * Shared playback-region math for pads, the region editor, Studio insertion, and export.
 *
 * A clip's `playback` is { startSeconds, endSeconds, fadeInMs, fadeOutMs }. Times are seconds;
 * `endSeconds: null` means the decoded source end (not zero). Missing `playback` means the whole source.
 * Sample frames are derived from the decoded buffer's own rate, so a region is exact to one frame.
 */
export const MAX_FADE_MS = 5000;
/** Tiny internal ramp that hides clicks at hard region edges. Never persisted as a user fade. */
export const ANTI_CLICK_SECONDS = 0.002;

const finite = value => typeof value === 'number' && Number.isFinite(value);
const round6 = value => Math.round(value * 1e6) / 1e6;

/** The full-source region. */
export const FULL_REGION = Object.freeze({ startSeconds: 0, endSeconds: null, fadeInMs: 0, fadeOutMs: 0 });

/**
 * Validates a new region edit. Throws a readable error instead of guessing.
 * `duration` (seconds) is optional; when known, the end must fall inside the source.
 */
export function validatePlayback(playback, duration = null) {
    if (playback === null || playback === undefined) return { ...FULL_REGION };
    if (typeof playback !== 'object') throw new Error('The playback region is invalid.');
    const { startSeconds, endSeconds = null, fadeInMs = 0, fadeOutMs = 0 } = playback;
    if (!finite(startSeconds) || startSeconds < 0) throw new Error('The start time must be zero or later.');
    if (endSeconds !== null && (!finite(endSeconds) || endSeconds <= startSeconds)) throw new Error('The end time must be after the start time.');
    if (!finite(fadeInMs) || !finite(fadeOutMs) || fadeInMs < 0 || fadeOutMs < 0 || fadeInMs > MAX_FADE_MS || fadeOutMs > MAX_FADE_MS) {
        throw new Error('Fades must be between 0 and 5000 ms.');
    }
    const knownDuration = finite(duration) && duration > 0 ? duration : null;
    if (knownDuration !== null) {
        if (startSeconds >= knownDuration) throw new Error('The start time is past the end of the sound.');
        if (endSeconds !== null && endSeconds > knownDuration + 1e-6) throw new Error('The end time is past the end of the sound.');
    }
    const end = endSeconds ?? knownDuration;
    if (end !== null && (fadeInMs + fadeOutMs) / 1000 > end - startSeconds + 1e-9) throw new Error('The fades are longer than the selected region.');
    return { startSeconds: round6(startSeconds), endSeconds: endSeconds === null ? null : round6(endSeconds), fadeInMs: round6(fadeInMs), fadeOutMs: round6(fadeOutMs) };
}

/** Stable key describing a region, used to invalidate region-based loudness analysis. */
export function regionKey(playback) {
    if (!playback) return 'full';
    return `${playback.startSeconds ?? 0}:${playback.endSeconds ?? 'end'}`;
}

/**
 * Resolves a stored region against decoded audio ({ length, sampleRate }).
 * Stale ends are clamped to the real duration. An unusable historical region falls back to the
 * whole clip and reports `warning`, so playback never silently fails or plays nothing.
 */
export function resolveRegion(playback, { length, sampleRate }) {
    const full = !playback || (playback.startSeconds === 0 && playback.endSeconds == null);
    let startFrame = 0, endFrame = length, warning = '', clamped = false;
    if (playback && !full) {
        const start = playback.startSeconds, end = playback.endSeconds;
        const startOk = finite(start) && start >= 0;
        const endOk = end === null || end === undefined || finite(end);
        if (!startOk || !endOk) warning = 'The saved playback region was invalid, so the whole sound plays.';
        else {
            startFrame = Math.round(start * sampleRate);
            endFrame = end === null || end === undefined ? length : Math.round(end * sampleRate);
            if (endFrame > length) { endFrame = length; clamped = true; }
            if (startFrame >= length || endFrame <= startFrame) {
                warning = 'The saved playback region is outside this sound, so the whole sound plays.';
                startFrame = 0; endFrame = length;
            }
        }
    }
    if (endFrame - startFrame < 1) { startFrame = 0; endFrame = Math.max(1, length); }
    const duration = (endFrame - startFrame) / sampleRate;
    let fadeIn = Math.max(0, Number(playback?.fadeInMs) || 0) / 1000;
    let fadeOut = Math.max(0, Number(playback?.fadeOutMs) || 0) / 1000;
    if (warning) { fadeIn = 0; fadeOut = 0; }
    if (fadeIn + fadeOut > duration) {
        // Old data may carry fades longer than a clamped region. Scale them to fit instead of overlapping.
        const scale = duration / (fadeIn + fadeOut);
        fadeIn *= scale; fadeOut *= scale;
    }
    return {
        startFrame, endFrame, frames: endFrame - startFrame,
        start: startFrame / sampleRate, end: endFrame / sampleRate, duration,
        fadeIn, fadeOut, full: startFrame === 0 && endFrame === length, clamped, warning
    };
}

/** Seconds a pad plays, or null while the source duration is still unknown. */
export function playedDuration(clip) {
    const source = Number(clip?.duration) || 0;
    const p = clip?.playback;
    if (!p) return source > 0 ? source : null;
    const end = p.endSeconds ?? (source > 0 ? source : null);
    if (end === null) return null;
    const clampedEnd = source > 0 ? Math.min(end, source) : end;
    return clampedEnd > p.startSeconds ? clampedEnd - p.startSeconds : null;
}

/**
 * Gain envelope points for one pass through a region (seconds relative to the region start).
 * Used identically by live pads, previews, Studio preview, and offline render.
 * `from` skips into the region (resuming a paused queue entry).
 */
export function envelopePoints(duration, fadeIn, fadeOut, { antiClick = true, from = 0 } = {}) {
    const click = antiClick ? Math.min(ANTI_CLICK_SECONDS, duration / 4) : 0;
    const inLen = Math.max(fadeIn, click), outLen = Math.max(fadeOut, click);
    const level = t => {
        let g = 1;
        if (inLen > 0 && t < inLen) g = Math.min(g, t / inLen);
        if (outLen > 0 && t > duration - outLen) g = Math.min(g, Math.max(0, (duration - t) / outLen));
        return Math.max(0, Math.min(1, g));
    };
    const points = [[from, from === 0 && inLen > 0 ? 0 : level(from)]];
    if (inLen > 0 && from < inLen) points.push([inLen, level(inLen)]);
    if (outLen > 0 && duration - outLen > from) points.push([duration - outLen, level(duration - outLen)]);
    points.push([duration, outLen > 0 ? 0 : 1]);
    return points.filter((point, i, all) => i === 0 || point[0] > all[i - 1][0] - 1e-12);
}

/** Applies envelope points to an AudioParam starting at context time `when`. */
export function applyEnvelope(param, when, points, from = 0) {
    param.cancelScheduledValues(when);
    param.setValueAtTime(points[0][1], when);
    for (const [t, value] of points.slice(1)) param.linearRampToValueAtTime(value, when + (t - from));
}
