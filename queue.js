export const QUEUE_LIMIT = 100;
const uuid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`.replace(/\D/g, '').padEnd(32, '0').replace(/^(.{8})(.{4})(.{3})(.{3})(.{12}).*/, '$1-$2-4$3-8$4-$5'));

/**
 * Playback queue. Each entry is a clip reference; its latest saved settings are read when it is dispatched.
 * Every entry plays exactly once through the normal region-aware engine path, even for looping pads, and
 * advances on the instance's own completion signal — never on a guessed duration.
 */
export class PlaybackQueue extends EventTarget {
    constructor({ engine, getClip, save = () => {} }) {
        super();
        Object.assign(this, { engine, getClip, save });
        this.entries = [];
        this.state = 'stopped';      // stopped | playing | paused
        this.offset = 0;             // region-relative resume position for the head entry
        this.token = 0;
        this.handle = null;
        this.message = '';
    }

    emit(type = 'change') { this.dispatchEvent(new CustomEvent(type)); if (type !== 'change') this.dispatchEvent(new CustomEvent('change')); }
    persist() { this.save(this.entries.map(({ id, clipId }) => ({ id, clipId }))); }

    /** Restores saved entries. The queue always starts stopped. */
    load(entries) {
        this.entries = (entries || []).slice(0, QUEUE_LIMIT).map(({ id, clipId }) => ({ id, clipId }));
        this.state = 'stopped'; this.offset = 0; this.message = '';
        this.emit();
    }

    add(clipId) {
        if (this.entries.length >= QUEUE_LIMIT) throw new Error('The queue holds at most 100 sounds. Remove some first.');
        const entry = { id: uuid(), clipId };
        this.entries.push(entry);
        this.persist(); this.emit();
        return entry;
    }

    remove(entryId) {
        const index = this.entries.findIndex(e => e.id === entryId);
        if (index < 0) return;
        const active = index === 0 && this.state !== 'stopped';
        if (active) this.cancelInstance();
        this.entries.splice(index, 1);
        if (index === 0) this.offset = 0;
        this.persist();
        if (active && this.state === 'playing') this.dispatch(); else { if (!this.entries.length) this.state = 'stopped'; this.emit(); }
    }

    move(entryId, to) {
        const from = this.entries.findIndex(e => e.id === entryId);
        if (from < 0) return;
        const target = Math.max(0, Math.min(this.entries.length - 1, to));
        if (from === target) return;
        // The playing (or paused) head entry stays first; other entries reorder around it.
        const locked = this.state !== 'stopped';
        if (locked && (from === 0 || target === 0)) throw new Error('Stop the queue to move the current sound.');
        const [entry] = this.entries.splice(from, 1);
        this.entries.splice(target, 0, entry);
        this.persist(); this.emit();
    }

    clear() {
        this.cancelInstance();
        this.entries = []; this.state = 'stopped'; this.offset = 0; this.message = '';
        this.persist(); this.emit();
    }

    /** Starts, or resumes a paused entry from where it stopped. */
    async play() {
        if (this.state === 'playing') return;
        if (!this.entries.length) throw new Error('Add sounds to the queue first.');
        this.message = '';
        return this.dispatch();
    }

    /** Pauses the current entry, remembering its position inside the played region. */
    pause() {
        if (this.state !== 'playing') return;
        const position = this.cancelInstance();
        this.offset = position ?? this.offset;
        this.state = 'paused';
        this.emit();
    }

    /** Skips the current entry (also a missing one) and plays the next. */
    next() {
        if (!this.entries.length) return;
        const wasRunning = this.state !== 'stopped';
        this.cancelInstance();
        this.entries.shift(); this.offset = 0; this.message = '';
        this.persist();
        if (wasRunning && this.entries.length) { this.dispatch(); return; }
        this.state = 'stopped'; this.emit();
    }

    /** Stop (and Stop all): cancels playback and dispatch, keeps pending entries. */
    stop(message = '') {
        this.cancelInstance();
        this.state = 'stopped'; this.offset = 0; this.message = message;
        this.emit();
    }

    cancelInstance() {
        this.token++;
        let position = null;
        if (this.handle) position = this.engine.stopHandle(this.handle, 'queue');
        this.handle = null;
        // An entry still decoding has no handle yet; cancel it too.
        for (const inst of this.engine.clipInstances ? [...this.engine.instances.values()].filter(i => i.owner === 'queue') : []) this.engine.stopInstance(inst, 'queue');
        return position;
    }

    current() {
        const entry = this.entries[0];
        return entry ? { entry, clip: this.getClip(entry.clipId) } : null;
    }

    async dispatch() {
        const entry = this.entries[0];
        if (!entry) { this.state = 'stopped'; this.emit(); return; }
        const clip = this.getClip(entry.clipId);
        const token = ++this.token;
        if (!clip) {
            this.state = 'paused'; this.message = 'This queued sound was deleted. Skip it with Next or remove it.';
            this.emit('error');
            return;
        }
        this.state = 'playing'; this.emit();
        let handle;
        try {
            handle = await this.engine.play(clip, { owner: 'queue', mode: clip.triggerMode === 'overlap' ? 'overlap' : 'restart', from: this.offset });
        } catch (error) {
            if (token !== this.token) return;
            this.state = 'paused'; this.message = error.message;
            this.emit('error');
            return;
        }
        if (token !== this.token) { if (handle) this.engine.stopHandle(handle, 'queue'); return; }
        this.handle = handle;
        // Resolve once the entry has started; its own completion signal drives what happens next.
        handle.done.then(result => this.completed(entry, clip, token, result));
    }

    completed(entry, clip, token, { reason, position }) {
        if (token !== this.token) return;          // our own pause/next/stop
        this.handle = null;
        if (reason === 'ended') {
            if (this.entries[0] === entry) this.entries.shift();
            this.offset = 0;
            this.persist();
            if (this.entries.length) this.dispatch(); else { this.state = 'stopped'; this.emit(); }
            return;
        }
        if (['stopAll', 'disconnect', 'monitor'].includes(reason)) { this.state = 'stopped'; this.offset = 0; this.message = reason === 'stopAll' ? '' : 'The queue stopped because audio disconnected.'; this.emit(); return; }
        // Another trigger stopped this sound (its pad, a restart, an exclusive group). Pause instead of fighting it.
        this.state = 'paused'; this.offset = position ?? 0;
        this.message = reason === 'group' ? `Queue paused: another sound in “${clip.name}”’s exclusive group started.` : `Queue paused: “${clip.name}” was stopped outside the queue.`;
        this.emit('interrupted');
    }
}
