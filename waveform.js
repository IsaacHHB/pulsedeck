/**
 * Zoomable waveform with a draggable selection. Times are seconds; drawing uses a peak cache so
 * long sources stay responsive. Audio outside the selection stays visible but darkened.
 */
const BLOCK = 256;
const HANDLE_PX = 8;

export class WaveformView extends EventTarget {
    constructor({ wrap, canvas, scroll, color = '#86c9ff' }) {
        super();
        Object.assign(this, { wrap, canvas, scroll, color });
        this.duration = 0; this.sampleRate = 48000; this.samples = null;
        this.view = [0, 0]; this.selection = [0, 0]; this.playheadTime = null; this.drag = null;
        canvas.addEventListener('pointerdown', event => this.pointerDown(event));
        canvas.addEventListener('pointermove', event => this.pointerMove(event));
        canvas.addEventListener('pointerup', event => this.pointerUp(event));
        canvas.addEventListener('pointercancel', () => this.cancelDrag());
        canvas.addEventListener('wheel', event => {
            if (!this.samples) return;
            event.preventDefault();
            if (event.ctrlKey || event.metaKey) this.zoom(event.deltaY < 0 ? 0.8 : 1.25, this.timeAt(event.offsetX));
            else this.pan((event.deltaY + event.deltaX) / this.width() * (this.view[1] - this.view[0]));
        }, { passive: false });
        scroll?.addEventListener('input', () => {
            const span = this.view[1] - this.view[0];
            const start = Number(scroll.value) / 1000 * Math.max(0, this.duration - span);
            this.view = [start, start + span]; this.draw();
        });
        new ResizeObserver(() => this.draw()).observe(wrap);
    }

    /** Mixes channels to one peak envelope. */
    setAudio(buffer) {
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
        const length = buffer.length;
        const mono = channels.length === 1 ? channels[0] : new Float32Array(length);
        if (channels.length > 1) for (const data of channels) for (let i = 0; i < length; i++) mono[i] += data[i] / channels.length;
        const blocks = Math.ceil(length / BLOCK);
        this.peaks = new Float32Array(blocks);
        for (let b = 0; b < blocks; b++) {
            let peak = 0;
            for (let i = b * BLOCK, end = Math.min(length, i + BLOCK); i < end; i++) { const v = Math.abs(mono[i]); if (v > peak) peak = v; }
            this.peaks[b] = peak;
        }
        this.samples = mono; this.sampleRate = buffer.sampleRate; this.duration = length / buffer.sampleRate;
        this.view = [0, this.duration];
        this.syncScroll(); this.draw();
    }

    clear() { this.samples = null; this.peaks = null; this.duration = 0; this.draw(); }
    width() { return Math.max(200, this.wrap.clientWidth); }
    timeAt(x) { return this.view[0] + (x / this.width()) * (this.view[1] - this.view[0]); }
    xAt(time) { return ((time - this.view[0]) / (this.view[1] - this.view[0] || 1)) * this.width(); }
    minLength() { return 1 / this.sampleRate; }

    setSelection(start, end, emit = false) {
        this.selection = [start, end];
        this.draw();
        if (emit) this.dispatchEvent(new CustomEvent('change', { detail: { start, end, final: true } }));
    }

    setPlayhead(time) { this.playheadTime = time; this.draw(); }

    zoom(factor, center = (this.view[0] + this.view[1]) / 2) {
        if (!this.duration) return;
        const min = Math.min(this.duration, Math.max(0.01, 256 / this.sampleRate));
        const span = Math.max(min, Math.min(this.duration, (this.view[1] - this.view[0]) * factor));
        let start = center - (center - this.view[0]) * (span / (this.view[1] - this.view[0]));
        start = Math.max(0, Math.min(this.duration - span, start));
        this.view = [start, start + span];
        this.syncScroll(); this.draw();
    }

    fit() { this.view = [0, this.duration]; this.syncScroll(); this.draw(); }
    /** Zooms to the selection with a little context on both sides. */
    zoomToSelection() {
        const [a, b] = this.selection, pad = Math.max((b - a) * 0.15, 0.05);
        const start = Math.max(0, a - pad), end = Math.min(this.duration, b + pad);
        this.view = [start, Math.max(end, start + Math.min(this.duration, 0.01))]; this.syncScroll(); this.draw();
    }

    pan(seconds) {
        const span = this.view[1] - this.view[0];
        const start = Math.max(0, Math.min(this.duration - span, this.view[0] + seconds));
        this.view = [start, start + span]; this.syncScroll(); this.draw();
    }

    syncScroll() {
        if (!this.scroll) return;
        const span = this.view[1] - this.view[0], room = this.duration - span;
        this.scroll.disabled = room <= 1e-9;
        this.scroll.value = room > 0 ? String(Math.round(this.view[0] / room * 1000)) : '0';
    }

    pointerDown(event) {
        if (!this.samples) return;
        const t = this.timeAt(event.offsetX), [a, b] = this.selection;
        const nearStart = Math.abs(this.xAt(a) - event.offsetX) <= HANDLE_PX, nearEnd = Math.abs(this.xAt(b) - event.offsetX) <= HANDLE_PX;
        const edge = nearStart && nearEnd ? (t < (a + b) / 2 ? 'start' : 'end') : nearStart ? 'start' : nearEnd ? 'end' : null;
        this.drag = { edge: edge || (Math.abs(t - a) <= Math.abs(t - b) ? 'start' : 'end'), original: [...this.selection], moved: false };
        this.canvas.setPointerCapture(event.pointerId);
        this.moveEdge(t);
    }

    pointerMove(event) {
        const t = this.timeAt(event.offsetX);
        if (!this.drag) {
            const near = [this.xAt(this.selection[0]), this.xAt(this.selection[1])].some(x => Math.abs(x - event.offsetX) <= HANDLE_PX);
            this.canvas.style.cursor = near ? 'ew-resize' : 'crosshair';
            return;
        }
        this.drag.moved = true;
        this.moveEdge(t);
    }

    moveEdge(t) {
        const min = this.minLength();
        let [a, b] = this.selection;
        t = Math.max(0, Math.min(this.duration, t));
        if (this.drag.edge === 'start') a = Math.min(t, b - min); else b = Math.max(t, a + min);
        this.selection = [Math.max(0, a), Math.min(this.duration, b)];
        this.draw();
        this.dispatchEvent(new CustomEvent('change', { detail: { start: this.selection[0], end: this.selection[1], final: false } }));
    }

    pointerUp(event) {
        if (!this.drag) return;
        this.canvas.releasePointerCapture?.(event.pointerId);
        this.drag = null;
        this.dispatchEvent(new CustomEvent('change', { detail: { start: this.selection[0], end: this.selection[1], final: true } }));
    }

    cancelDrag() {
        if (!this.drag) return;
        this.selection = this.drag.original; this.drag = null; this.draw();
        this.dispatchEvent(new CustomEvent('change', { detail: { start: this.selection[0], end: this.selection[1], final: true } }));
    }

    draw() {
        const canvas = this.canvas, width = this.width(), height = this.wrap.clientHeight || 150, scale = window.devicePixelRatio || 1;
        canvas.width = width * scale; canvas.height = height * scale;
        const ctx = canvas.getContext('2d'); ctx.setTransform(scale, 0, 0, scale, 0, 0);
        ctx.clearRect(0, 0, width, height);
        if (!this.samples) return;
        const [v0, v1] = this.view, mid = height / 2, perPx = (v1 - v0) * this.sampleRate / width;
        const [s0, s1] = this.selection, x0 = this.xAt(s0), x1 = this.xAt(s1);
        for (let x = 0; x < width; x++) {
            const from = Math.floor((v0 * this.sampleRate) + x * perPx), to = Math.max(from + 1, Math.floor(v0 * this.sampleRate + (x + 1) * perPx));
            let peak = 0;
            if (perPx >= BLOCK) { for (let b = Math.floor(from / BLOCK), end = Math.min(this.peaks.length, Math.ceil(to / BLOCK)); b < end; b++) if (this.peaks[b] > peak) peak = this.peaks[b]; }
            else for (let i = from, end = Math.min(this.samples.length, to); i < end; i++) { const v = Math.abs(this.samples[i]); if (v > peak) peak = v; }
            const inside = x >= x0 && x <= x1;
            ctx.fillStyle = inside ? this.color : '#4a525c';
            const h = Math.max(1, Math.min(1, peak) * (height - 10));
            ctx.fillRect(x, mid - h / 2, 1, h);
        }
        ctx.fillStyle = '#00000088';
        if (x0 > 0) ctx.fillRect(0, 0, Math.min(width, x0), height);
        if (x1 < width) ctx.fillRect(Math.max(0, x1), 0, width - Math.max(0, x1), height);
        ctx.fillStyle = '#ffffff18'; ctx.fillRect(0, mid, width, 1);
        ctx.fillStyle = this.color;
        for (const x of [x0, x1]) if (x >= -2 && x <= width + 2) { ctx.fillRect(x - 1, 0, 2, height); ctx.fillRect(x - 5, 0, 10, 8); ctx.fillRect(x - 5, height - 8, 10, 8); }
        if (this.playheadTime !== null && this.playheadTime >= v0 && this.playheadTime <= v1) { ctx.fillStyle = '#ffffff'; ctx.fillRect(this.xAt(this.playheadTime) - 1, 0, 2, height); }
    }
}

/** 1:02.345 style time with milliseconds. */
export function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return '—';
    const sign = seconds < 0 ? '-' : '';
    const ms = Math.round(Math.abs(seconds) * 1000);
    return `${sign}${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
