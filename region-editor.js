import { WaveformView, formatTime } from './waveform.js';
import { validatePlayback, resolveRegion, MAX_FADE_MS } from './playback-region.js';

/**
 * Playback-region dialog. Shows the whole source, lets the user choose the part a pad plays,
 * and never changes the source audio. Cancel leaves the clip untouched.
 */
export function createRegionEditor({ engine, previewDevice, onSave, onError }) {
    const $ = id => document.getElementById(id);
    const dialog = $('regionDialog');
    const view = new WaveformView({ wrap: $('regionWaveWrap'), canvas: $('regionWave'), scroll: $('regionScroll'), color: '#86c9ff' });
    let clip = null, buffer = null, token = 0, playheadFrame = 0;
    // Exact selection in seconds. The number fields show it rounded to milliseconds.
    let exact = { start: 0, end: 0 };

    const fields = () => ({ start: exact.start, end: exact.end, fadeIn: Number($('regionFadeIn').value), fadeOut: Number($('regionFadeOut').value) });

    function currentPlayback() {
        const { start, end, fadeIn, fadeOut } = fields();
        // An end at (or typed within half a millisecond of) the source end means “the whole rest of the sound”.
        const atEnd = buffer && Math.abs(end - buffer.duration) < 0.0005;
        return validatePlayback({ startSeconds: start, endSeconds: atEnd ? null : end, fadeInMs: fadeIn, fadeOutMs: fadeOut }, buffer?.duration ?? null);
    }

    function refresh() {
        let error = '';
        try { if (buffer) currentPlayback(); } catch (e) { error = e.message; }
        const { start, end } = fields();
        $('regionError').textContent = error;
        $('regionError').hidden = !error;
        $('regionSave').disabled = !buffer || Boolean(error);
        $('regionPreview').disabled = !buffer || Boolean(error);
        $('regionPlayed').textContent = buffer && end > start ? formatTime(end - start) : '—';
        $('regionSource').textContent = buffer ? formatTime(buffer.duration) : 'Loading…';
    }

    function setFields(start, end) {
        exact = { start, end };
        $('regionStart').value = start.toFixed(3); $('regionEnd').value = end.toFixed(3);
        refresh();
    }

    view.addEventListener('change', event => {
        setFields(event.detail.start, event.detail.end);
    });
    for (const id of ['regionStart', 'regionEnd']) $(id).addEventListener('input', () => {
        const start = $('regionStart').value === '' ? NaN : Number($('regionStart').value);
        const end = $('regionEnd').value === '' ? NaN : Number($('regionEnd').value);
        exact = { start, end };
        if (buffer && Number.isFinite(start) && Number.isFinite(end)) view.setSelection(Math.max(0, start), Math.min(buffer.duration, end));
        refresh();
    });
    for (const id of ['regionFadeIn', 'regionFadeOut']) $(id).addEventListener('input', refresh);
    $('regionZoomIn').onclick = () => view.zoom(0.5);
    $('regionZoomOut').onclick = () => view.zoom(2);
    $('regionZoomFit').onclick = () => view.fit();
    $('regionZoomSel').onclick = () => view.zoomToSelection();
    $('regionReset').onclick = () => { if (buffer) { view.setSelection(0, buffer.duration); setFields(0, buffer.duration); view.fit(); } };

    function stopPreview() {
        cancelAnimationFrame(playheadFrame);
        view.setPlayhead(null);
        $('regionPreview').querySelector('span:last-child').textContent = 'Play selection';
        if (engine.auditionSession?.owner === 'region') engine.stopAudition();
    }

    // A preview that ends on its own (or by Stop all) resets the button even when animation frames are paused.
    engine.addEventListener('audition', event => {
        if (!event.detail && engine.auditionSession?.owner !== 'region') {
            cancelAnimationFrame(playheadFrame); view.setPlayhead(null);
            $('regionPreview').querySelector('span:last-child').textContent = 'Play selection';
        }
    });

    $('regionPreview').onclick = async () => {
        if (engine.auditionSession?.owner === 'region') { stopPreview(); return; }
        try {
            const playback = currentPlayback();
            const session = await engine.auditionBuffer(buffer, { deviceId: previewDevice(), playback, gain: engine.clipGain({ ...clip, playback }) });
            session.owner = 'region';
            $('regionPreview').querySelector('span:last-child').textContent = 'Stop';
            const region = resolveRegion(playback, buffer);
            const tick = () => {
                const t = engine.auditionSession === session ? engine.auditionTime() : null;
                if (t === null) { stopPreview(); return; }
                view.setPlayhead(region.start + Math.min(t, region.duration));
                playheadFrame = requestAnimationFrame(tick);
            };
            tick();
        } catch (error) { if (error.code !== 'CANCELLED') onError(error); }
    };

    $('regionCancel').onclick = () => dialog.close();
    $('closeRegion').onclick = () => dialog.close();
    dialog.addEventListener('close', () => { token++; stopPreview(); clip = null; buffer = null; view.clear(); });

    $('regionSave').onclick = async () => {
        try {
            const playback = currentPlayback();
            const full = playback.startSeconds === 0 && playback.endSeconds === null && !playback.fadeInMs && !playback.fadeOutMs;
            $('regionSave').disabled = true;
            await onSave(clip, full ? null : playback);
            dialog.close();
        } catch (error) { onError(error); refresh(); }
    };

    return {
        async open(target) {
            const mine = ++token;
            clip = target; buffer = null;
            $('regionTitle').textContent = target.name;
            $('regionFadeIn').max = MAX_FADE_MS; $('regionFadeOut').max = MAX_FADE_MS;
            $('regionFadeIn').value = target.playback?.fadeInMs ?? 0; $('regionFadeOut').value = target.playback?.fadeOutMs ?? 0;
            $('regionStart').value = ''; $('regionEnd').value = '';
            view.clear(); refresh();
            dialog.showModal();
            try {
                const decoded = await engine.load(target);
                if (mine !== token) return;
                buffer = decoded;
                const region = resolveRegion(target.playback, decoded);
                if (region.warning) onError(new Error(region.warning));
                for (const id of ['regionStart', 'regionEnd']) { $(id).max = decoded.duration.toFixed(6); $(id).step = '0.001'; }
                view.setAudio(decoded);
                view.setSelection(region.start, region.end);
                setFields(region.start, region.end);
                if (region.duration < decoded.duration * 0.5) view.zoomToSelection();
            } catch (error) {
                if (mine !== token) return;
                $('regionError').textContent = error.message; $('regionError').hidden = false;
            }
        },
        get clipId() { return clip?.id ?? null; }
    };
}
