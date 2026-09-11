/**
 * Sound Studio project model. Pure data: no audio buffers, no DOM. Every edit returns a new project
 * object so undo/redo can keep small JSON snapshots instead of copies of audio.
 *
 * Times are finite seconds on the project timeline; `inSeconds`/`outSeconds` are nondestructive bounds
 * inside a project-owned asset. Render and preview convert to 48 kHz frames.
 */
export const STUDIO_LIMITS = Object.freeze({
    tracks: 8, regions: 64, timelineSeconds: 180, takeSeconds: 180, projects: 100,
    assetSeconds: 180, assetBytes: 64 * 1024 * 1024, projectBytes: 256 * 1024 * 1024, padBytes: 30 * 1024 * 1024,
    history: 100, nameLength: 80, maxFadeMs: 5000, minGainDb: -60, maxGainDb: 12
});
export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;
export const SNAP_GRID = 0.01;
export const PROJECT_SCHEMA = 1;

const finite = value => typeof value === 'number' && Number.isFinite(value);
const round = value => Math.round(value * 1e6) / 1e6;
export const uuid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)));
const clone = value => JSON.parse(JSON.stringify(value));
export const regionLength = region => region.outSeconds - region.inSeconds;
export const regionEnd = region => region.atSeconds + regionLength(region);

export function newProject(name = 'Untitled project', id = uuid(), now = Date.now()) {
    return {
        schemaVersion: PROJECT_SCHEMA, id, revision: 0, name: String(name).slice(0, STUDIO_LIMITS.nameLength) || 'Untitled project',
        sampleRate: SAMPLE_RATE, channels: CHANNELS, createdAt: now, updatedAt: now,
        assets: [], tracks: [newTrack(1)], regions: [], exportRange: null
    };
}
export function newTrack(number, id = uuid()) { return { id, name: `Layer ${number}`, gainDb: 0, mute: false, solo: false }; }

/** Tracks that render: with any solo active, only soloed unmuted tracks; otherwise every unmuted track. */
export function audibleTrackIds(project) {
    const soloed = project.tracks.some(t => t.solo);
    return new Set(project.tracks.filter(t => !t.mute && (!soloed || t.solo)).map(t => t.id));
}
/** Timeline length: the end of the last region (all tracks). */
export const timelineDuration = project => project.regions.reduce((max, r) => Math.max(max, regionEnd(r)), 0);
/** Keep timeline duration stable when muting/soloing tracks; an explicit export range overrides it. */
export function renderRange(project) {
    if (project.exportRange) return { ...project.exportRange };
    return { startSeconds: 0, endSeconds: timelineDuration(project) };
}

function fail(message) { throw new Error(message); }

/** Validates one region against its asset and the timeline limits. */
export function checkRegion(region, project) {
    const asset = project.assets.find(a => a.id === region.assetId);
    if (!asset) fail('This region’s audio is missing from the project.');
    if (!project.tracks.some(t => t.id === region.trackId)) fail('This region’s track no longer exists.');
    for (const key of ['atSeconds', 'inSeconds', 'outSeconds', 'gainDb', 'pan', 'fadeInMs', 'fadeOutMs']) if (!finite(region[key])) fail('Region values must be numbers.');
    if (region.atSeconds < 0) fail('Regions cannot start before 0:00.');
    if (region.inSeconds < 0 || region.outSeconds <= region.inSeconds) fail('A region’s end must be after its start.');
    if (region.outSeconds > asset.duration + 1e-6) fail('A region cannot extend past the end of its audio.');
    if (regionEnd(region) > STUDIO_LIMITS.timelineSeconds + 1e-6) fail('The timeline is limited to 3 minutes.');
    if (region.gainDb < STUDIO_LIMITS.minGainDb || region.gainDb > STUDIO_LIMITS.maxGainDb) fail('Region gain must be between −60 and +12 dB.');
    if (region.pan < -1 || region.pan > 1) fail('Pan must be between −1 (left) and +1 (right).');
    if (region.fadeInMs < 0 || region.fadeOutMs < 0 || region.fadeInMs > STUDIO_LIMITS.maxFadeMs || region.fadeOutMs > STUDIO_LIMITS.maxFadeMs) fail('Fades must be between 0 and 5000 ms.');
    if ((region.fadeInMs + region.fadeOutMs) / 1000 > regionLength(region) + 1e-9) fail('The fades are longer than the region.');
    if (typeof region.label !== 'string' || region.label.length > STUDIO_LIMITS.nameLength) fail('Region labels can be at most 80 characters.');
}

/** Full-project validation used before saving, rendering, or accepting a recovery draft. */
export function checkProject(project) {
    if (!project || project.schemaVersion !== PROJECT_SCHEMA) fail('This project uses an unsupported format.');
    if (!Array.isArray(project.tracks) || !project.tracks.length || project.tracks.length > STUDIO_LIMITS.tracks) fail('A project has 1 to 8 tracks.');
    if (!Array.isArray(project.regions) || project.regions.length > STUDIO_LIMITS.regions) fail('A project has at most 64 regions.');
    for (const track of project.tracks) {
        if (!finite(track.gainDb) || track.gainDb < STUDIO_LIMITS.minGainDb || track.gainDb > STUDIO_LIMITS.maxGainDb) fail('Track gain must be between −60 and +12 dB.');
    }
    for (const region of project.regions) checkRegion(region, project);
    if (project.exportRange) {
        const { startSeconds, endSeconds } = project.exportRange;
        if (!finite(startSeconds) || !finite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds || endSeconds > STUDIO_LIMITS.timelineSeconds) fail('The export range is invalid.');
    }
    return project;
}

function touch(project) { project.updatedAt = Date.now(); return project; }

export function addAsset(project, asset) {
    const next = clone(project);
    if (!next.assets.some(a => a.id === asset.id)) next.assets.push({ id: asset.id, file: asset.file, name: String(asset.name || 'Audio').slice(0, 80), duration: asset.duration, channels: asset.channels, origin: asset.origin || null });
    return touch(next);
}

function makeRegion(project, { assetId, trackId, atSeconds, inSeconds = 0, outSeconds, label, gainDb = 0, pan = 0, fadeInMs = 0, fadeOutMs = 0 }) {
    const asset = project.assets.find(a => a.id === assetId) || fail('Add the audio to the project first.');
    return {
        id: uuid(), trackId, assetId, atSeconds: round(Math.max(0, atSeconds)), inSeconds: round(inSeconds), outSeconds: round(outSeconds ?? asset.duration),
        gainDb: round(gainDb), pan: round(pan), fadeInMs: round(fadeInMs), fadeOutMs: round(fadeOutMs), label: String(label ?? asset.name).slice(0, 80)
    };
}

function withRegions(project, regions) {
    const next = clone(project);
    next.regions = regions;
    if (next.regions.length > STUDIO_LIMITS.regions) fail('A project can have at most 64 regions.');
    for (const region of next.regions) checkRegion(region, next);
    return touch(next);
}

/**
 * Places audio from a project asset on the timeline.
 *  - insert: at the playhead on the chosen track, pushing later audio on that track to the right (splitting a region under the playhead)
 *  - append: after the last region on the chosen track
 *  - layer: at the playhead on a new track (or the first track that is free there)
 */
export function placeAsset(project, { assetId, mode = 'append', trackId, playhead = 0, bounds = {}, label, gainDb = 0 }) {
    let next = clone(project);
    const asset = next.assets.find(a => a.id === assetId) || fail('Add the audio to the project first.');
    const inSeconds = bounds.inSeconds ?? 0, outSeconds = bounds.outSeconds ?? asset.duration;
    const length = outSeconds - inSeconds;
    const at = round(Math.max(0, playhead));
    let track = next.tracks.find(t => t.id === trackId) || next.tracks[0];
    const fields = { assetId, inSeconds, outSeconds, label, gainDb, fadeInMs: bounds.fadeInMs ?? 0, fadeOutMs: bounds.fadeOutMs ?? 0 };
    if (mode === 'layer') {
        const free = next.tracks.find(t => !next.regions.some(r => r.trackId === t.id && r.atSeconds < at + length && regionEnd(r) > at));
        if (free) track = free;
        else {
            if (next.tracks.length >= STUDIO_LIMITS.tracks) fail('All 8 tracks have audio here. Move a region or use Insert instead.');
            track = newTrack(next.tracks.length + 1); next.tracks.push(track);
        }
        const region = makeRegion(next, { ...fields, trackId: track.id, atSeconds: at });
        return { project: withRegions(next, [...next.regions, region]), regionId: region.id };
    }
    if (mode === 'append') {
        const end = next.regions.filter(r => r.trackId === track.id).reduce((max, r) => Math.max(max, regionEnd(r)), 0);
        const region = makeRegion(next, { ...fields, trackId: track.id, atSeconds: end });
        return { project: withRegions(next, [...next.regions, region]), regionId: region.id };
    }
    // Ripple insert on one track.
    const regions = [];
    for (const r of next.regions) {
        if (r.trackId !== track.id || regionEnd(r) <= at + 1e-9) { regions.push(r); continue; }
        if (r.atSeconds >= at - 1e-9) { regions.push({ ...r, atSeconds: round(r.atSeconds + length) }); continue; }
        const cut = at - r.atSeconds;
        regions.push({ ...r, outSeconds: round(r.inSeconds + cut), fadeInMs: Math.min(r.fadeInMs, cut * 1000), fadeOutMs: 0 });
        const rest = { ...r, id: uuid(), atSeconds: round(at + length), inSeconds: round(r.inSeconds + cut), fadeInMs: 0 };
        rest.fadeOutMs = Math.min(rest.fadeOutMs, regionLength(rest) * 1000);
        regions.push(rest);
    }
    const region = makeRegion(next, { ...fields, trackId: track.id, atSeconds: at });
    regions.push(region);
    return { project: withRegions(next, regions), regionId: region.id };
}

export function updateRegion(project, id, patch) {
    const regions = project.regions.map(r => r.id === id ? { ...r, ...pick(patch, ['trackId', 'atSeconds', 'inSeconds', 'outSeconds', 'gainDb', 'pan', 'fadeInMs', 'fadeOutMs', 'label']) } : r);
    if (!project.regions.some(r => r.id === id)) fail('That region no longer exists.');
    return withRegions(project, regions.map(r => r.id === id ? { ...r, atSeconds: round(r.atSeconds), inSeconds: round(r.inSeconds), outSeconds: round(r.outSeconds) } : r));
}
function pick(patch, keys) { const out = {}; for (const key of keys) if (key in (patch || {})) out[key] = patch[key]; return out; }

export function removeRegion(project, id) { return withRegions(project, project.regions.filter(r => r.id !== id)); }

export function duplicateRegion(project, id) {
    const source = project.regions.find(r => r.id === id) || fail('That region no longer exists.');
    const copy = { ...source, id: uuid(), atSeconds: round(regionEnd(source)) };
    return { project: withRegions(project, [...project.regions, copy]), regionId: copy.id };
}

/** Splits a region at a timeline time. Fades stay on the outer edges. */
export function splitRegion(project, id, time) {
    const source = project.regions.find(r => r.id === id) || fail('That region no longer exists.');
    const cut = time - source.atSeconds;
    if (cut <= 1 / SAMPLE_RATE || cut >= regionLength(source) - 1 / SAMPLE_RATE) fail('Move the playhead inside the selected region to split it.');
    const left = { ...source, outSeconds: round(source.inSeconds + cut), fadeOutMs: 0 };
    left.fadeInMs = Math.min(left.fadeInMs, regionLength(left) * 1000);
    const right = { ...source, id: uuid(), atSeconds: round(time), inSeconds: round(source.inSeconds + cut), fadeInMs: 0 };
    right.fadeOutMs = Math.min(right.fadeOutMs, regionLength(right) * 1000);
    return { project: withRegions(project, project.regions.flatMap(r => r.id === id ? [left, right] : [r])), regionId: right.id };
}

export function addTrack(project) {
    if (project.tracks.length >= STUDIO_LIMITS.tracks) fail('A project can have at most 8 tracks.');
    const next = clone(project);
    const track = newTrack(next.tracks.length + 1); next.tracks.push(track);
    return { project: touch(next), trackId: track.id };
}
export function updateTrack(project, id, patch) {
    const next = clone(project);
    const track = next.tracks.find(t => t.id === id) || fail('That track no longer exists.');
    if ('name' in patch) track.name = String(patch.name).trim().slice(0, 40) || track.name;
    if ('gainDb' in patch) { if (!finite(patch.gainDb) || patch.gainDb < -60 || patch.gainDb > 12) fail('Track gain must be between −60 and +12 dB.'); track.gainDb = round(patch.gainDb); }
    if ('mute' in patch) track.mute = Boolean(patch.mute);
    if ('solo' in patch) track.solo = Boolean(patch.solo);
    return touch(next);
}
export function removeTrack(project, id) {
    if (project.tracks.length <= 1) fail('A project needs at least one track.');
    const next = clone(project);
    next.tracks = next.tracks.filter(t => t.id !== id);
    next.regions = next.regions.filter(r => r.trackId !== id);
    return touch(next);
}
export function setExportRange(project, range) {
    const next = clone(project);
    next.exportRange = range ? { startSeconds: round(range.startSeconds), endSeconds: round(range.endSeconds) } : null;
    checkProject(next);
    return touch(next);
}
export function renameProject(project, name) {
    const clean = String(name || '').trim();
    if (!clean) fail('Name the project.');
    if (clean.length > STUDIO_LIMITS.nameLength) fail('Project names can be at most 80 characters.');
    return touch({ ...clone(project), name: clean });
}

/** Snaps to the 10 ms grid and, when given, to nearby region edges (within `threshold` seconds). */
export function snapTime(time, { grid = true, edges = [], threshold = 0 } = {}) {
    let best = time;
    if (grid) best = Math.round(time / SNAP_GRID) * SNAP_GRID;
    if (threshold > 0) {
        let nearest = null;
        for (const edge of edges) if (Math.abs(edge - time) <= threshold && (nearest === null || Math.abs(edge - time) < Math.abs(nearest - time))) nearest = edge;
        if (nearest !== null) best = nearest;
    }
    return round(Math.max(0, best));
}
/** Region edges other than the region being moved, for edge snapping. */
export const regionEdges = (project, exceptId) => project.regions.filter(r => r.id !== exceptId).flatMap(r => [r.atSeconds, regionEnd(r)]);

/** Assets referenced by regions (others can be garbage-collected once no saved, draft, or history state needs them). */
export const referencedAssets = project => new Set(project.regions.map(r => r.assetId));

/** Undo/redo of whole-project snapshots. Audio lives in assets, so snapshots stay small. */
export class History {
    constructor(limit = STUDIO_LIMITS.history) { this.limit = limit; this.past = []; this.future = []; }
    record(before) {
        this.past.push(JSON.stringify(before));
        if (this.past.length > this.limit) this.past.shift();
        this.future = [];
    }
    undo(current) { if (!this.past.length) return null; this.future.push(JSON.stringify(current)); return JSON.parse(this.past.pop()); }
    redo(current) { if (!this.future.length) return null; this.past.push(JSON.stringify(current)); return JSON.parse(this.future.pop()); }
    clear() { this.past = []; this.future = []; }
    get canUndo() { return this.past.length > 0; }
    get canRedo() { return this.future.length > 0; }
    /** Every asset any history state still needs. */
    assets() { const ids = new Set(); for (const json of [...this.past, ...this.future]) for (const r of JSON.parse(json).regions) ids.add(r.assetId); return ids; }
}

/** Bytes of a PCM16 WAV: 44 header bytes plus frames × channels × 2. */
export const wavBytes = (frames, channels = CHANNELS) => 44 + frames * channels * 2;
