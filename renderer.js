import { AudioEngine, levelGainDb } from './audio.js';
import { PRESETS, GROUPS } from './voice-effects.js';
import { encodeWav, waveformPeaks, audibleRange } from './wav.js';
import { playedDuration, resolveRegion, envelopePoints, applyEnvelope } from './playback-region.js';
import { limitOffline, bufferToWav, measurePeak, RENDER_CEILING } from './studio-audio.js';
import { createRegionEditor } from './region-editor.js';
import { createStudio } from './studio-ui.js';
import { createRecorderUI } from './recorder-ui.js';
import { createTtsUI } from './tts-ui.js';
import { createQueueUI } from './queue-ui.js';
import { askText, askPick, askChoice } from './dialogs.js';
import { isMac, cableOutputName, cableInputName, driverName, microphoneHelp, isCable, isVirtual, cableReturn, isFeedbackRoute, prettyKey, shortcutFromEvent } from './platform.js';
import { configureMacUI } from './mac-ui.js';

configureMacUI();

const $ = id => document.getElementById(id);
const engine = new AudioEngine();
let state = { clips: [], captures: [], settings: {}, projects: [], collections: [], groups: [], queue: [] };
let collectionId = '', selecting = false;
const selected = new Set();
let filter = 'all', editing = null, devices = [], toastTimer, saveTimer, effectTimer, busy = false, view = 'board', dragId = null;
const SLOTS = 10;

const duration = value => value ? `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}` : 'Ready';
const presetOf = id => PRESETS.find(preset => preset.id === id) || PRESETS[0];
const deviceLabel = id => devices.find(d => d.deviceId === id)?.label || '';

let lastFailedHotkeys = '';
function toast(message, error = false, action = null) {
    clearTimeout(toastTimer);
    if (window.deck.testMode) (window.__toasts ||= []).push(message);
    const host = document.querySelector('dialog[open]') || document.body;
    if ($('toast').parentElement !== host) host.append($('toast'));
    $('toastText').textContent = isMac ? message.replaceAll('Ctrl', 'Cmd').replaceAll('Alt', 'Option') : message;
    $('toastAction').hidden = !action;
    if (action) { $('toastAction').textContent = action.label; $('toastAction').onclick = () => { $('toast').hidden = true; action.run(); }; }
    $('toast').classList.toggle('error', error);
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, action ? 14000 : error ? 10000 : 5000);
}

/** Setup shortcut offered when a preview has no private headphone output. */
const chooseHeadphones = { label: 'Choose headphones', run: () => { for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close(); const select = $('monitorDevice'); select.scrollIntoView({ block: 'center' }); select.classList.add('flash-target'); setTimeout(() => select.classList.remove('flash-target'), 2500); select.focus(); } };

function reportError(error) {
    if (error?.code === 'CANCELLED') return;
    toast(error?.message || String(error), true, error?.code === 'NO_PREVIEW_DEVICE' ? chooseHeadphones : error?.action || null);
}

async function run(action) {
    try { return await action(); }
    catch (error) { reportError(error); }
}

/* ─── Views ────────────────────────────────────────────────── */
function showView(name) {
    if (view === 'studio' && name !== 'studio') studio.stopPreview();
    view = name;
    for (const [id, key] of [['boardView', 'board'], ['voiceView', 'voice'], ['replayView', 'replay'], ['studioView', 'studio'], ['ttsView', 'tts']]) $(id).hidden = name !== key;
    for (const [id, key] of [['boardNav', 'board'], ['voiceNav', 'voice'], ['replayNav', 'replay'], ['studioNav', 'studio'], ['ttsNav', 'tts']]) $(id).classList.toggle('active', name === key);
    $('crumbView').textContent = { board: 'Soundboard', voice: 'Voice changer', replay: 'Replay buffer', studio: 'Sound Studio', tts: 'Text to speech' }[name];
    if (name === 'replay') drawWaveform();
    if ($('guideDialog').open) $('guideDialog').close();
}

/* ─── Library ──────────────────────────────────────────────── */
function acceptLibrary(result) {
    if (!result) return;
    state.clips = result.clips;
    if (Array.isArray(result.captures)) { state.captures = result.captures; renderCaptures(); }
    if (Array.isArray(result.projects)) state.projects = result.projects;
    if (Array.isArray(result.collections)) state.collections = result.collections;
    if (Array.isArray(result.groups)) state.groups = result.groups;
    for (const id of [...selected]) if (!state.clips.some(c => c.id === id)) selected.delete(id);
    renderCollections();
    renderPads();
    queueUI?.render();
    studio?.refresh();
    // Repeat the shortcut warning only when the set of unavailable shortcuts changes.
    const failed = (result.failedHotkeys || []).join(',');
    if (Array.isArray(result.failedHotkeys)) { const changed = failed !== lastFailedHotkeys; lastFailedHotkeys = failed; if (!changed) result = { ...result, failedHotkeys: [] }; }
    if (result.failedHotkeys?.length) toast(`Unavailable shortcuts: ${result.failedHotkeys.map(prettyKey).join(', ')}. Free them in the other app, or assign a different sound shortcut. On-screen controls still work.`, true);
    if (result.errors?.length) toast(result.errors.join('\n'), true);
}

function renderPads() {
    const grid = $('soundGrid');
    grid.replaceChildren();
    $('clipCount').textContent = state.clips.length;
    $('navCount').textContent = state.clips.length;
    $('loopCount').textContent = state.clips.filter(c => c.loop).length;
    $('favCount').textContent = state.clips.filter(c => c.favorite).length;
    const search = $('search').value.trim().toLowerCase();
    const collection = state.collections.find(c => c.id === collectionId) || null;
    const byId = new Map(state.clips.map(c => [c.id, c]));
    const source = collection ? collection.clipIds.map(id => byId.get(id)).filter(Boolean) : state.clips;
    const matches = c => !search || c.name.toLowerCase().includes(search) || (c.tags || []).some(tag => tag.toLowerCase().includes(search));
    const clips = source.filter(c => (filter !== 'loops' || c.loop) && (filter !== 'favorites' || c.favorite) && matches(c));
    const canReorder = filter === 'all' && !search && !selecting;
    grid.classList.toggle('reorderable', canReorder);
    grid.classList.toggle('selecting', selecting);
    $('emptyState').hidden = state.clips.length > 0;
    if (state.clips.length && !clips.length) {
        const note = document.createElement('p');
        note.className = 'grid-note';
        const where = collection ? ` in “${collection.name}”` : '';
        note.textContent = search ? `No sounds match “${$('search').value.trim()}”${where}.`
            : filter === 'favorites' ? `No favorites${where} yet. Choose “Add to favorites” in a pad’s menu.`
            : filter === 'loops' ? `No looping sounds${where} yet. Turn on “Loop until stopped” in a sound’s settings.`
            : `“${collection?.name}” is empty. Use a pad’s menu → Add to collection, or Select several pads.`;
        grid.append(note);
    }
    for (const clip of clips) {
        const pad = document.createElement('article');
        pad.className = `sound-pad ${clip.color}${selected.has(clip.id) ? ' selected' : ''}`;
        pad.dataset.id = clip.id;

        const play = document.createElement('button');
        play.className = 'pad-main';
        play.title = `${selecting ? 'Select' : 'Play or stop'} ${clip.name}${clip.hotkey ? ` (${prettyKey(clip.hotkey)})` : ''}${clip.tags?.length ? ` · Tags: ${clip.tags.join(', ')}` : ''}`;
        const symbol = document.createElement('span'); symbol.className = 'pad-symbol'; symbol.textContent = '▶';
        const body = document.createElement('span'); body.className = 'pad-body';
        const name = document.createElement('span'); name.className = 'pad-name'; name.textContent = clip.name;
        const meta = document.createElement('span'); meta.className = 'pad-meta';
        const time = document.createElement('span'); time.className = 'pad-time'; time.textContent = duration(playedDuration(clip));
        const key = document.createElement('span'); key.className = 'pad-key'; key.textContent = clip.hotkey ? prettyKey(clip.hotkey).replaceAll(' ', '') : '';
        if (clip.favorite) { const star = document.createElement('span'); star.className = 'pad-fav'; star.textContent = '★'; star.title = 'Favorite'; meta.append(star); }
        meta.append(time);
        if (clip.loop) { const loop = document.createElement('span'); loop.className = 'pad-loop'; loop.textContent = '↻'; loop.title = 'Loops until stopped'; meta.append(loop); }
        if (clip.playback) { const region = document.createElement('span'); region.className = 'pad-region'; region.textContent = 'Region'; region.title = `Plays ${duration(playedDuration(clip))} of a ${duration(clip.duration)} source`; meta.append(region); }
        const count = document.createElement('span'); count.className = 'pad-count'; count.hidden = true; count.title = 'Copies playing'; meta.append(count);
        if (clip.hotkey) meta.append(key);
        body.append(name, meta);
        play.append(symbol, body);
        play.addEventListener('click', () => {
            if (selecting) { if (selected.has(clip.id)) selected.delete(clip.id); else selected.add(clip.id); renderPads(); updateBoardSelection(); return; }
            run(() => engine.play(clip));
        });

        const edit = document.createElement('button');
        edit.className = 'pad-edit'; edit.textContent = '⋯'; edit.title = `Edit ${clip.name}`;
        edit.setAttribute('aria-label', `Edit ${clip.name}`);
        edit.onclick = event => { event.stopPropagation(); openPadMenu(clip, edit); };

        const progress = document.createElement('div'); progress.className = 'pad-progress'; progress.append(document.createElement('div'));
        pad.append(play, edit, progress);
        pad.addEventListener('contextmenu', event => { event.preventDefault(); openPadMenu(clip, null, event.clientX, event.clientY); });
        if (canReorder) attachDrag(pad, clip);
        grid.append(pad);
    }
    if (state.clips.length) {
        const add = document.createElement('button');
        add.className = 'add-pad';
        const plus = document.createElement('span'); plus.textContent = '+';
        add.append(plus, 'Add sound');
        add.onclick = importSounds;
        grid.append(add);
    }
    updatePlaying();
}

/* ─── Drag to reorder (pads 1-10 own Ctrl+Alt+1…9,0 by position) ── */
function attachDrag(pad, clip) {
    pad.draggable = true;
    pad.addEventListener('dragstart', event => {
        dragId = clip.id;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('application/x-pulsedeck', clip.id);
        requestAnimationFrame(() => pad.classList.add('dragging'));
    });
    pad.addEventListener('dragend', () => {
        dragId = null;
        document.querySelectorAll('.sound-pad').forEach(p => p.classList.remove('dragging', 'drop-before', 'drop-after'));
    });
    pad.addEventListener('dragover', event => {
        if (!dragId || dragId === clip.id) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const before = event.offsetX < pad.offsetWidth / 2;
        pad.classList.toggle('drop-before', before);
        pad.classList.toggle('drop-after', !before);
    });
    pad.addEventListener('dragleave', () => pad.classList.remove('drop-before', 'drop-after'));
    pad.addEventListener('drop', event => {
        if (!dragId || dragId === clip.id) return;
        event.preventDefault(); event.stopPropagation();
        const before = pad.classList.contains('drop-before');
        pad.classList.remove('drop-before', 'drop-after');
        moveSound(dragId, clip.id, before);
        dragId = null;
    });
}

function moveSound(id, targetId, before) {
    const collection = state.collections.find(c => c.id === collectionId);
    if (collection) {
        // Reordering inside a collection changes only that collection; shortcuts keep following All sounds.
        const local = collection.clipIds.filter(x => x !== id);
        local.splice(local.indexOf(targetId) + (before ? 0 : 1), 0, id);
        collection.clipIds = local;
        renderPads();
        run(async () => acceptLibrary(await window.deck.reorderCollection(collection.id, local)));
        return;
    }
    const ids = state.clips.map(c => c.id).filter(x => x !== id);
    const at = ids.indexOf(targetId) + (before ? 0 : 1);
    ids.splice(at, 0, id);
    // Show the new order immediately; the library confirms and reassigns the digit shortcuts.
    const byId = new Map(state.clips.map(c => [c.id, c]));
    state.clips = ids.map(x => byId.get(x));
    renderPads();
    run(async () => acceptLibrary(await window.deck.reorderSounds(ids)));
}

function updatePlaying() {
    document.querySelectorAll('.sound-pad').forEach(pad => {
        const count = engine.clipCount(pad.dataset.id);
        pad.classList.toggle('playing', count > 0);
        pad.classList.toggle('loading', engine.isLoading(pad.dataset.id));
        pad.querySelector('.pad-symbol').textContent = count ? '■' : '▶';
        const badge = pad.querySelector('.pad-count');
        badge.hidden = count < 2; badge.textContent = `×${count}`;
        if (!count) pad.querySelector('.pad-progress > div').style.transform = 'scaleX(0)';
    });
    const count = engine.playingCount;
    $('libraryHint').textContent = count ? `${count} sound${count === 1 ? '' : 's'} playing · click a pad to stop it.` : 'Click a pad to play, click again to stop.';
    pushOverlay();
}

/* ─── Overlay mirror ───────────────────────────────────────── */
let overlayTimer;
function pushOverlay(immediate = true) {
    clearTimeout(overlayTimer);
    const send = () => {
        const progress = {};
        const playing = engine.activeClipIds(), counts = {};
        for (const id of playing) { const value = engine.progress(id); if (value !== null) progress[id] = value; counts[id] = engine.clipCount(id); }
        window.deck.overlayState({
            clips: state.clips.map(c => ({ id: c.id, name: c.name, color: c.color, hotkey: c.hotkey, loop: c.loop, favorite: c.favorite })),
            playing, counts, muted: engine.muted, live: engine.connected,
            voice: presetOf(state.settings.effect).name, progress, opacity: state.settings.overlay?.opacity, replay: engine.replay ? engine.replay.seconds : 0
        }).catch(() => {});
    };
    if (immediate) send(); else overlayTimer = setTimeout(send, 50);
}
function overlayUI(visible) {
    $('overlayBtn').setAttribute('aria-pressed', String(visible));
    $('overlayBtnText').textContent = visible ? 'Overlay on' : 'Overlay';
    $('navOverlay').textContent = visible ? 'On' : 'Off';
    $('overlayNav').classList.toggle('active-soft', visible);
}

function animateProgress() {
    if (engine.instances.size) {
        document.querySelectorAll('.sound-pad.playing').forEach(pad => {
            const value = engine.progress(pad.dataset.id);
            if (value !== null) pad.querySelector('.pad-progress > div').style.transform = `scaleX(${value})`;
        });
    }
    requestAnimationFrame(animateProgress);
}

async function importSounds() {
    await run(async () => {
        const result = await window.deck.importSounds();
        acceptLibrary(result);
        if (result?.added?.length && !result.errors.length && !result.failedHotkeys.length) toast(`Added ${result.added.length} sound${result.added.length === 1 ? '' : 's'} to your library.`);
    });
}

/* ─── Edit dialog ──────────────────────────────────────────── */
function editSound(clip) {
    editing = clip.id;
    $('editTitle').textContent = clip.name;
    $('editName').value = clip.name;
    $('editHotkey').value = prettyKey(clip.hotkey);
    $('editHotkey').dataset.key = clip.hotkey;
    const position = state.clips.indexOf(clip);
    const positional = position > -1 && position < SLOTS;
    $('editHotkey').disabled = positional;
    $('clearHotkey').hidden = positional;
    $('editHotkeyHelp').textContent = positional
        ? `Pad ${position + 1} always uses ${prettyKey(clip.hotkey)}. Drag pads on the soundboard to change the order . The first ten follow pad order.`
        : `${prettyKey('Control+Shift')} or ${prettyKey('Alt+Shift')} with a letter, number, or F-key. Works while another app has focus.`;
    $('editVolume').value = clip.volume;
    $('editVolumeValue').textContent = clip.volume + '%';
    const analysis = engine.analysisFor(clip);
    const loudness = analysis?.loudness;
    const gainDb = levelGainDb(loudness, analysis?.peak);
    $('editLevelInfo').textContent = analysis && !Number.isFinite(loudness) ? 'The played region is silent, so auto-level leaves it unchanged.' : Number.isFinite(loudness)
        ? `Measured level ${loudness.toFixed(0)} dB. ${state.settings.autoLevel === false ? 'Auto-level is off.' : gainDb >= 0 ? `Auto-level adds +${gainDb.toFixed(0)} dB.` : `Auto-level trims ${gainDb.toFixed(0)} dB.`}`
        : 'Level not measured yet — play the sound once.';
    const swatch = document.querySelector(`#editColor input[value="${clip.color}"]`) || document.querySelector('#editColor input');
    swatch.checked = true;
    $('editLoop').checked = clip.loop;
    $('editTrigger').value = clip.triggerMode || 'toggle';
    fillGroups(clip.exclusiveGroupId || '');
    $('editTags').value = (clip.tags || []).join(', ');
    syncTriggerOptions();
    $('deleteSound').textContent = 'Remove sound';
    $('editDialog').showModal();
}

$('editForm').onsubmit = event => {
    event.preventDefault();
    run(async () => {
        const color = document.querySelector('#editColor input:checked')?.value;
        const patch = { name: $('editName').value, volume: Number($('editVolume').value), color, loop: $('editLoop').checked, triggerMode: $('editTrigger').value, exclusiveGroupId: $('editGroup').value, tags: parseTags($('editTags').value) };
        if (!$('editHotkey').disabled) patch.hotkey = $('editHotkey').dataset.key;
        const before = state.clips.find(c => c.id === editing);
        const result = await window.deck.editSound(editing, patch);
        acceptLibrary(result);
        const after = state.clips.find(c => c.id === editing);
        // A playing copy keeps the loop shape it started with; changing the shape restarts on the next trigger.
        if (before && after && (before.loop !== after.loop || before.triggerMode !== after.triggerMode)) engine.stop(editing, 'edit');
        engine.updateClip(after);
        $('editDialog').close();
    });
};

$('editHotkey').addEventListener('keydown', event => {
    if (event.key === 'Tab') return;
    event.preventDefault();
    if (['Backspace', 'Delete'].includes(event.key)) { event.target.value = ''; event.target.dataset.key = ''; return; }
    const value = shortcutFromEvent(event);
    if (!value) return;
    event.target.dataset.key = value;
    event.target.value = prettyKey(value);
});
$('clearHotkey').onclick = () => { $('editHotkey').value = ''; $('editHotkey').dataset.key = ''; };
$('editVolume').oninput = () => { $('editVolumeValue').textContent = $('editVolume').value + '%'; };
$('closeEdit').onclick = () => $('editDialog').close();
$('deleteSound').onclick = () => run(async () => {
    if ($('deleteSound').textContent !== 'Confirm removal') { $('deleteSound').textContent = 'Confirm removal'; return; }
    engine.forget(editing);
    acceptLibrary(await window.deck.removeSound(editing));
    $('editDialog').close();
});

/* ─── Pad menu and playback regions ────────────────────────── */
const regionEditor = createRegionEditor({
    engine, previewDevice, onError: reportError,
    onSave: async (clip, playback) => {
        engine.stop(clip.id, 'edit');
        const result = await window.deck.editSound(clip.id, { playback });
        engine.invalidate(clip.id);
        acceptLibrary(result);
        const saved = state.clips.find(c => c.id === clip.id);
        toast(playback ? `“${saved.name}” now plays ${duration(playedDuration(saved))} of its ${duration(saved.duration)} source.` : `“${saved.name}” plays the whole sound again.`);
    }
});

const studio = createStudio({
    engine, toast, reportError, previewDevice, acceptLibrary,
    getState: () => state,
    armReplay: enabled => run(async () => { showView('replay'); await armReplay(enabled); }),
    isVisible: () => view === 'studio'
});

/**
 * Exports what the pad plays: its region, fades, volume, and auto-level. Board volume, ducking,
 * the microphone, and monitoring are not part of the file.
 */
async function exportRegion(clip) {
    const buffer = await engine.load(clip);
    if (buffer.numberOfChannels > 2) throw new Error('This sound has more than two channels. Use Export original audio instead.');
    const region = resolveRegion(clip.playback, buffer);
    const ctx = new OfflineAudioContext(buffer.numberOfChannels, region.frames, buffer.sampleRate);
    const source = ctx.createBufferSource(), env = ctx.createGain(), level = ctx.createGain();
    source.buffer = buffer; level.gain.value = engine.clipGain(clip);
    source.connect(env); env.connect(level); level.connect(ctx.destination);
    applyEnvelope(env.gain, 0, envelopePoints(region.duration, region.fadeIn, region.fadeOut));
    source.start(0, region.start, region.duration);
    let rendered = await ctx.startRendering(), limited = false;
    if (measurePeak(rendered) > RENDER_CEILING) { rendered = await limitOffline(rendered); limited = true; }
    const saved = await window.deck.exportWav(`${clip.name} (played region).wav`, bufferToWav(rendered));
    if (saved) toast(`Exported ${saved}: the played region (${duration(rendered.duration)}) with this pad’s volume and auto-level${limited ? ', peak-limited to prevent clipping' : ''}. Board volume, ducking, and your microphone are not included.`);
}

/* ─── Backup and restore ─── */
$('backupBtn').onclick = () => run(async () => {
    const choice = await askChoice({ eyebrow: 'Backup', title: 'Back up or restore your library', message: 'A backup copies your sounds, replay captures, collections, and saved Studio projects into a new folder you choose. Restoring merges a backup into this library: nothing here is replaced, and no devices, broadcast, or capture start.', choices: [{ id: 'cancel', label: 'Cancel' }, { id: 'restore', label: 'Restore from backup…' }, { id: 'backup', label: 'Back up now…', primary: true }] });
    if (choice === 'backup') {
        if (studio.hasUnsaved) {
            const save = await askChoice({ eyebrow: 'Backup', title: 'Save your Studio project first?', message: 'Backups include saved Studio projects only. Unsaved edits and recovery drafts are not included.', choices: [{ id: 'cancel', label: 'Cancel' }, { id: 'skip', label: 'Back up without it' }, { id: 'save', label: 'Save and back up', primary: true }] });
            if (!save || save === 'cancel') return;
            if (save === 'save') await studio.saveCurrent();
        }
        const summary = await window.deck.createBackup();
        if (summary) toast(`Backed up ${summary.clips} sounds, ${summary.captures} captures, and ${summary.projects} Studio projects to “${summary.name}”.`);
    } else if (choice === 'restore') {
        const result = await window.deck.restoreBackup();
        if (!result) return;
        acceptLibrary(result);
        const r = result.restored;
        toast(`Restored ${r.clips} sounds, ${r.captures} captures, ${r.projects} Studio projects, and ${r.collections} collections from “${r.from}”.${r.warnings.length ? ` ${r.warnings.join(' ')}` : ''}`);
    }
});

/* ─── Organization: favorites, tags, collections, groups ─── */
const parseTags = text => text.split(',').map(tag => tag.trim()).filter(Boolean);

async function editTags(clip) {
    const answer = await askText({ eyebrow: 'Tags', title: clip.name, label: 'Tags (comma separated)', value: (clip.tags || []).join(', '), maxLength: 800, confirm: 'Save tags', help: 'Up to 20 tags of 32 characters each. Search matches names and tags.' });
    if (answer) acceptLibrary(await window.deck.editSound(clip.id, { tags: parseTags(answer.text) }));
}

async function addToCollection(clipIds) {
    if (!clipIds.length) throw new Error('Select at least one sound first.');
    const pick = await askPick({ eyebrow: 'Collections', title: clipIds.length === 1 ? 'Add to collection' : `Add ${clipIds.length} sounds to a collection`, label: 'Collection', options: state.collections.map(c => ({ value: c.id, label: `${c.name} (${c.clipIds.length})` })), allowNew: true, newLabel: 'New collection…', confirm: 'Add' });
    if (!pick) return;
    let id = pick.value;
    if (pick.newName) { const created = await window.deck.createCollection(pick.newName, clipIds); acceptLibrary(created); id = created.created; }
    else acceptLibrary(await window.deck.addToCollection(id, clipIds));
    const collection = state.collections.find(c => c.id === id);
    toast(`Added ${clipIds.length === 1 ? 'the sound' : `${clipIds.length} sounds`} to “${collection?.name}”.`);
}

function renderCollections() {
    const select = $('collectionFilter');
    if (collectionId && !state.collections.some(c => c.id === collectionId)) collectionId = '';
    select.replaceChildren(new Option(`All sounds (${state.clips.length})`, ''));
    for (const c of state.collections) select.add(new Option(`${c.name} (${c.clipIds.length})`, c.id));
    select.value = collectionId;
}

function openCollectionMenu() {
    const collection = state.collections.find(c => c.id === collectionId);
    showMenu([
        { action: 'new-collection', icon: '＋', label: 'New collection…', run: async () => {
            const answer = await askText({ eyebrow: 'Collections', title: 'New collection', label: 'Collection name', maxLength: 60, confirm: 'Create' });
            if (!answer) return;
            const result = await window.deck.createCollection(answer.text, []);
            collectionId = result.created; acceptLibrary(result);
        } },
        ...(collection ? [
            { action: 'rename-collection', icon: '✎', label: `Rename “${collection.name}”…`, run: async () => {
                const answer = await askText({ eyebrow: 'Collections', title: 'Rename collection', label: 'Collection name', value: collection.name, maxLength: 60, confirm: 'Rename' });
                if (answer) acceptLibrary(await window.deck.renameCollection(collection.id, answer.text));
            } },
            { action: 'delete-collection', icon: '×', label: `Delete “${collection.name}”`, run: async () => {
                const choice = await askChoice({ eyebrow: 'Collections', title: `Delete “${collection.name}”?`, message: 'The collection is removed. Its sounds stay on your board.', choices: [{ id: 'cancel', label: 'Cancel' }, { id: 'delete', label: 'Delete collection', danger: true }] });
                if (choice === 'delete') { collectionId = ''; acceptLibrary(await window.deck.deleteCollection(collection.id)); }
            } }
        ] : [])
    ], $('collectionMenuBtn'));
}

function fillGroups(value) {
    const select = $('editGroup');
    select.replaceChildren(new Option('None', ''));
    for (const group of state.groups) select.add(new Option(group.name, group.id));
    select.add(new Option('New group…', '__new'));
    select.value = state.groups.some(g => g.id === value) ? value : '';
    select.dataset.previous = select.value;
}

function syncTriggerOptions() {
    const overlap = $('editTrigger').querySelector('option[value=overlap]');
    overlap.disabled = $('editLoop').checked;
    if ($('editLoop').checked && $('editTrigger').value === 'overlap') $('editTrigger').value = 'restart';
    $('editTriggerHelp').textContent = $('editLoop').checked ? 'Looping sounds can use Toggle or Restart. Overlap would stack endless copies.' : 'Overlap plays up to 8 copies of this sound at once.';
}

$('editLoop').addEventListener('change', syncTriggerOptions);
$('editGroup').addEventListener('change', () => run(async () => {
    const select = $('editGroup');
    if (select.value !== '__new') { select.dataset.previous = select.value; return; }
    select.value = select.dataset.previous || '';
    const answer = await askText({ eyebrow: 'Exclusive groups', title: 'New exclusive group', label: 'Group name', maxLength: 40, confirm: 'Create', help: 'Sounds in the same group stop each other when started.' });
    if (!answer) return;
    const result = await window.deck.createGroup(answer.text);
    acceptLibrary(result);
    fillGroups(result.created);
}));
$('manageGroups').onclick = () => run(async () => {
    if (!state.groups.length) { toast('No exclusive groups yet. Choose “New group…” to create one.'); return; }
    const pick = await askPick({ eyebrow: 'Exclusive groups', title: 'Manage groups', label: 'Group', options: state.groups.map(g => ({ value: g.id, label: `${g.name} (${state.clips.filter(c => c.exclusiveGroupId === g.id).length} sounds)` })), confirm: 'Next' });
    if (!pick?.value) return;
    const group = state.groups.find(g => g.id === pick.value);
    const choice = await askChoice({ eyebrow: 'Exclusive groups', title: group.name, message: 'Rename the group, or delete it. Deleting leaves its sounds on the board without a group.', choices: [{ id: 'cancel', label: 'Cancel' }, { id: 'delete', label: 'Delete group', danger: true }, { id: 'rename', label: 'Rename…', primary: true }] });
    if (choice === 'rename') { const answer = await askText({ eyebrow: 'Exclusive groups', title: 'Rename group', label: 'Group name', value: group.name, maxLength: 40, confirm: 'Rename' }); if (answer) acceptLibrary(await window.deck.renameGroup(group.id, answer.text)); }
    if (choice === 'delete') acceptLibrary(await window.deck.deleteGroup(group.id));
    fillGroups($('editGroup').dataset.previous === group.id && choice === 'delete' ? '' : $('editGroup').dataset.previous);
});

function updateBoardSelection() {
    $('selectionBar').hidden = !selecting;
    $('selectionCount').textContent = `${selected.size} selected`;
    $('selectModeBtn').setAttribute('aria-pressed', String(selecting));
    $('selectModeBtn').textContent = selecting ? 'Done selecting' : 'Select';
    $('selectionCollection').disabled = $('selectionQueue').disabled = !selected.size;
}
function setSelecting(on) { selecting = on; if (!on) selected.clear(); updateBoardSelection(); renderPads(); }
$('selectModeBtn').onclick = () => setSelecting(!selecting);
$('selectionDone').onclick = () => setSelecting(false);
$('selectionCollection').onclick = () => run(async () => { await addToCollection(state.clips.filter(c => selected.has(c.id)).map(c => c.id)); setSelecting(false); });
$('selectionQueue').onclick = () => run(async () => { queueUI.add(state.clips.filter(c => selected.has(c.id)).map(c => c.id)); setSelecting(false); });
$('collectionFilter').onchange = () => { collectionId = $('collectionFilter').value; renderPads(); pushOverlay(); };
$('collectionMenuBtn').onclick = event => { event.stopPropagation(); openCollectionMenu(); };

const queueUI = createQueueUI({ engine, toast, reportError, getState: () => state });

const recorderUI = createRecorderUI({
    engine, previewDevice, toast, reportError, acceptLibrary, studio,
    getState: () => state, getDevices: () => devices,
    presetName: () => presetOf(state.settings.effect).name
});
$('recordBtn').onclick = () => recorderUI.open('board');
const ttsUI = createTtsUI({
    engine, previewDevice, toast, reportError, acceptLibrary, studio, saveSettings,
    getState: () => state,
    connectAudio: () => { showView('board'); $('connectBtn').click(); }
});
for (const id of ['ttsNav', 'ttsBoardBtn', 'studioTtsBtn']) $(id).onclick = () => showView('tts');
$('studioRecordBtn').onclick = () => recorderUI.open('studio');

function padMenuItems(clip) {
    const collection = state.collections.find(c => c.id === collectionId);
    const items = [
        { action: 'edit', icon: '✎', label: 'Edit sound…', run: () => editSound(clip) },
        { action: 'region', icon: '✂', label: 'Playback region…', run: () => regionEditor.open(clip) },
        { action: 'favorite', icon: clip.favorite ? '★' : '☆', label: clip.favorite ? 'Remove from favorites' : 'Add to favorites', run: async () => acceptLibrary(await window.deck.editSound(clip.id, { favorite: !clip.favorite })) },
        { action: 'tags', icon: '#', label: 'Tags…', run: () => editTags(clip) },
        { action: 'collection', icon: '▤', label: 'Add to collection…', run: () => addToCollection([clip.id]) },
        ...(collection ? [{ action: 'uncollect', icon: '−', label: `Remove from “${collection.name}”`, run: async () => acceptLibrary(await window.deck.removeFromCollection(collection.id, [clip.id])) }] : []),
        { action: 'queue', icon: '☰', label: 'Add to queue', run: () => queueUI.add(clip.id) },
        'separator',
        { action: 'studio', icon: '◧', label: 'Use in Studio', run: async () => { showView('studio'); await studio.addClip(clip); } }
    ];
    if (clip.source?.kind === 'studio' && state.projects.some(p => p.id === clip.source.projectId)) {
        items.push({ action: 'source', icon: '↗', label: 'Open source project', run: async () => { showView('studio'); await studio.openProject(clip.source.projectId); } });
    }
    items.push('separator',
        { action: 'export-region', icon: '⤓', label: 'Export played region as WAV…', run: () => exportRegion(clip) },
        { action: 'export-original', icon: '⤓', label: 'Export original audio…', run: async () => { const saved = await window.deck.exportOriginal(clip.id); if (saved) toast(`Exported the untouched original file as ${saved}.`); } });
    return items;
}

function closePadMenu() { $('padMenu').hidden = true; $('padMenu').replaceChildren(); }
function openPadMenu(clip, anchor, x = 0, y = 0) { showMenu(padMenuItems(clip), anchor, x, y); }
function showMenu(entries, anchor, x = 0, y = 0) {
    const menu = $('padMenu');
    menu.replaceChildren();
    for (const item of entries) {
        if (item === 'separator') { menu.append(document.createElement('hr')); continue; }
        const button = document.createElement('button');
        button.type = 'button'; button.setAttribute('role', 'menuitem'); button.dataset.action = item.action;
        const icon = document.createElement('span'); icon.className = 'menu-icon'; icon.textContent = item.icon;
        button.append(icon, item.label);
        button.onclick = () => { closePadMenu(); run(item.run); };
        menu.append(button);
    }
    menu.hidden = false;
    const rect = anchor ? anchor.getBoundingClientRect() : { left: x, right: x, bottom: y };
    const left = anchor ? rect.right - menu.offsetWidth : rect.left;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, left))}px`;
    menu.style.top = `${Math.max(8, Math.min(window.innerHeight - menu.offsetHeight - 8, rect.bottom + 4))}px`;
    menu.querySelector('button')?.focus();
}
document.addEventListener('pointerdown', event => { if (!$('padMenu').hidden && !$('padMenu').contains(event.target)) closePadMenu(); }, true);
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('padMenu').hidden) { closePadMenu(); event.stopImmediatePropagation(); } });
window.addEventListener('blur', closePadMenu);

/* ─── Settings ─────────────────────────────────────────────── */
function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => run(() => { const { overlay, ...settings } = state.settings; return window.deck.saveSettings(settings); }), 200);
}

function syncSettingsUI() {
    for (const key of ['micVolume', 'boardVolume', 'monitorVolume']) {
        $(key).value = state.settings[key];
        $(key + 'Value').textContent = state.settings[key] + '%';
    }
    $('voicePitch').value = state.settings.voicePitch ?? 0;
    $('effectMix').value = state.settings.effectMix ?? 100;
    $('monitorVoice').checked = Boolean(state.settings.monitorVoice);
    $('autoLevel').checked = state.settings.autoLevel !== false;
    $('replaySeconds').value = String(state.settings.replaySeconds || 60);
    $('replayMic').checked = Boolean(state.settings.replayMic);
    $('replayAuto').checked = Boolean(state.settings.replayAuto);
    replayUI();
    syncVoiceUI();
    syncDucking();
    engine.applySettings(state.settings);
}

function syncVoiceUI() {
    const preset = presetOf(state.settings.effect);
    const pitch = Number($('voicePitch').value), mix = Number($('effectMix').value);
    document.querySelectorAll('[data-effect]').forEach(button => {
        const active = button.dataset.effect === preset.id;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    });
    $('effectDescription').textContent = preset.description;
    $('heroName').textContent = preset.name;
    $('heroSymbol').textContent = preset.symbol;
    $('headerVoiceName').textContent = preset.name;
    $('headerVoiceSymbol').textContent = preset.symbol;
    $('navVoice').textContent = preset.name;
    $('voicePitchValue').textContent = pitch > 0 ? `+${pitch}` : String(pitch);
    $('resetPitch').hidden = pitch === 0;
    $('effectMixValue').textContent = `${mix}%`;
    $('effectMix').disabled = preset.id === 'clean';
}

function chooseEffect(id) {
    state.settings.effect = id;
    engine.setEffect(id);
    syncVoiceUI();
    saveSettings();
    pushOverlay();
}

/* ─── Devices ──────────────────────────────────────────────── */
function deviceOptions(element, kind, saved, placeholder, soundsOnly = false) {
    element.replaceChildren();
    element.add(new Option(placeholder, ''));
    if (soundsOnly) element.add(new Option('Sounds only · no microphone', 'none'));
    devices.filter(d => d.kind === kind && d.deviceId && !['default', 'communications'].includes(d.deviceId))
        .forEach((d, i) => element.add(new Option(d.label || `${kind === 'audioinput' ? 'Microphone' : 'Output'} ${i + 1} · scan to identify`, d.deviceId)));
    if (saved && !Array.from(element.options).some(o => o.value === saved)) {
        const missing = new Option('Previously selected device · unavailable', saved);
        missing.disabled = true;
        element.add(missing);
    }
    element.value = saved || '';
}

async function refreshDevices(requestAccess = false) {
    if (requestAccess) {
        try {
            if (!await window.deck.requestMicrophone()) throw new Error(microphoneHelp);
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); stream.getTracks().forEach(track => track.stop());
        }
        catch { toast(`Microphone access was unavailable. You can still select Sounds only. ${microphoneHelp}`, true); }
    }
    devices = await navigator.mediaDevices.enumerateDevices();
    const concrete = devices.filter(d => !['default', 'communications'].includes(d.deviceId));
    if (!state.settings.outputId) state.settings.outputId = concrete.find(d => d.kind === 'audiooutput' && isCable(d.label))?.deviceId || '';
    if (!state.settings.micId) state.settings.micId = concrete.find(d => d.kind === 'audioinput' && !isVirtual(d.label))?.deviceId || '';
    deviceOptions($('micDevice'), 'audioinput', state.settings.micId, 'Choose your microphone', true);
    deviceOptions($('outputDevice'), 'audiooutput', state.settings.outputId, 'Choose a virtual cable');
    deviceOptions($('monitorDevice'), 'audiooutput', state.settings.monitorId, 'Choose your headphones');
    const outputMissing = !concrete.some(d => d.deviceId === state.settings.outputId);
    const micMissing = state.settings.micId !== 'none' && !concrete.some(d => d.deviceId === state.settings.micId);
    if (engine.connected && (outputMissing || micMissing)) {
        engine.disconnect();
        toast('An audio device is unavailable. Reconnect it, scan devices, and connect audio again.', true);
    }
    if (engine.previewing && micMissing) { engine.stopPreview(); toast('Voice preview stopped because the microphone disconnected.', true); }
    if (engine.monitoring && !concrete.some(d => d.deviceId === state.settings.monitorId)) {
        await engine.setMonitoring(false);
        $('monitorToggle').checked = false;
        toast('Headphone monitoring stopped because its output disconnected.', true);
    }
    routeHelp();
    connectionUI();
    saveSettings();
    recorderUI.refreshDevices();
}

/** The private preview output: the chosen physical headphones, never the broadcast or a default device. */
function previewDevice() {
    const id = state.settings.monitorId;
    const fail = message => { throw Object.assign(new Error(message), { code: 'NO_PREVIEW_DEVICE' }); };
    if (!id || !devices.some(d => d.deviceId === id && d.kind === 'audiooutput')) fail('Choose your headphones in the mixer to preview. Previews play only in your headphones, never in your broadcast.');
    if (isVirtual(deviceLabel(id))) fail('Choose physical headphones for previews, not a virtual audio cable.');
    if (id === state.settings.outputId) fail('Your headphones and broadcast output are the same device. Choose separate headphones to preview privately.');
    return id;
}

function routeHelp() {
    const output = devices.find(d => d.deviceId === state.settings.outputId && d.kind === 'audiooutput');
    const cable = isCable(output?.label);
    $('outputHelp').textContent = cable
        ? `In Zoom, Discord, OBS, or calls, choose ${cableReturn(output.label)} as the microphone. Keep meeting playback on your headphones.`
        : output ? 'For other apps to hear this mix, choose a virtual cable here. A physical speaker output only plays locally.'
        : `Choose ${cableOutputName} here. Choose ${cableInputName} as the microphone in your other apps.`;
}

function checklist() {
    const micId = state.settings.micId, output = devices.find(d => d.deviceId === state.settings.outputId && d.kind === 'audiooutput');
    const micOk = micId === 'none' || devices.some(d => d.deviceId === micId && d.kind === 'audioinput');
    const hasCableDevice = devices.some(d => d.kind === 'audiooutput' && isCable(d.label));
    const set = (id, status, text) => { $(id).className = status; $(id + 'Text').textContent = text; };
    set('checkMic', micOk ? 'done' : '', micId === 'none' ? 'Sounds only, no live voice' : micOk ? deviceLabel(micId) : 'Scan devices to choose one');
    set('checkCable', output && isCable(output.label) ? 'done' : output ? 'warn' : hasCableDevice ? 'warn' : '',
        output && isCable(output.label) ? output.label : output ? `${output.label} · not a virtual cable` : hasCableDevice ? 'Virtual cable found · select it below' : `Install ${driverName}, then pick ${cableOutputName}`);
    set('checkLive', engine.connected ? 'done' : '', engine.connected ? `Live · choose ${cableReturn(output?.label)} as the mic in your apps` : 'Connect to go live in your apps');
}

function connectionUI() {
    const live = engine.connected;
    $('statusPill').classList.toggle('live', live);
    $('statusPill').querySelector('span').textContent = live ? 'Live' : 'Offline';
    $('connectBtn').classList.toggle('connected', live);
    $('connectBtn').querySelector('.connect-text').textContent = live ? 'Disconnect audio' : 'Connect audio';
    $('connectBtn').querySelector('.connect-arrow').textContent = live ? '↙' : '↗';
    $('micDevice').disabled = live || busy;
    $('outputDevice').disabled = live || busy;
    $('sidebarDot').className = `dot ${live ? 'live' : engine.previewing ? 'preview' : ''}`;
    $('sidebarStatusText').textContent = live ? 'Broadcasting' : engine.previewing ? 'Previewing voice' : 'Broadcast offline';
    $('sidebarStatusHint').textContent = live ? `Sending to ${deviceLabel(state.settings.outputId) || 'your selected output'}.` : engine.previewing ? 'Only you can hear this, in your headphones.' : 'Connect audio in the mixer to go live.';
    $('engineStatus').textContent = live
        ? `48 kHz · ${state.settings.micId === 'none' ? 'Sounds only' : 'Microphone + sounds'} · ${presetOf(state.settings.effect).name} voice`
        : engine.previewing ? 'Headphone preview · broadcast offline'
        : engine.monitoring ? 'Headphone monitoring · broadcast offline' : 'Audio engine idle';
    $('hearBtn').setAttribute('aria-pressed', String(engine.monitoring && Boolean(state.settings.monitorVoice) && (live || engine.previewing)));
    $('hearBtn').querySelector('span:last-child').textContent = $('hearBtn').getAttribute('aria-pressed') === 'true' ? 'Stop listening' : 'Hear myself';
    $('hearBtn').querySelector('.btn-icon').textContent = $('hearBtn').getAttribute('aria-pressed') === 'true' ? '◉' : '◯';
    checklist();
    pushOverlay();
    run(() => window.deck.setAudioActive(live || engine.monitoring || engine.previewing || Boolean(engine.replay)));
}

/* ─── Mixer controls ───────────────────────────────────────── */
$('connectBtn').onclick = () => run(async () => {
    if (busy) return;
    if (engine.connected) { engine.disconnect(); return; }
    const mic = deviceLabel(state.settings.micId), output = deviceLabel(state.settings.outputId);
    if (isFeedbackRoute(mic, output)) throw new Error('Select your physical microphone. Using the virtual cable as your microphone would feed the mix back into itself.');
    if (engine.monitoring && state.settings.monitorId === state.settings.outputId) throw new Error('Choose separate outputs for broadcast and headphones.');
    busy = true; $('connectBtn').disabled = true; connectionUI();
    try {
        await engine.connect(state.settings);
        const { overlay, ...settings } = state.settings;
        await window.deck.saveSettings(settings);
    } finally {
        busy = false; $('connectBtn').disabled = false; connectionUI();
    }
});

$('refreshDevices').onclick = () => run(async () => {
    $('refreshDevices').disabled = true;
    try { await refreshDevices(true); } finally { $('refreshDevices').disabled = false; }
});

for (const [id, key] of [['micDevice', 'micId'], ['outputDevice', 'outputId'], ['monitorDevice', 'monitorId']]) {
    $(id).onchange = () => run(async () => {
        state.settings[key] = $(id).value;
        saveSettings(); routeHelp();
        if (key === 'monitorId' && engine.monitoring) { await engine.setMonitoring(false); $('monitorToggle').checked = false; }
        if (key === 'micId' && engine.previewing) engine.stopPreview();
        connectionUI();
    });
}

for (const key of ['micVolume', 'boardVolume', 'monitorVolume']) {
    $(key).oninput = () => {
        state.settings[key] = Number($(key).value);
        $(key + 'Value').textContent = $(key).value + '%';
        engine.applySettings(state.settings);
        saveSettings();
    };
}

async function setMonitoring(enabled) {
    if (enabled && isVirtual(deviceLabel(state.settings.monitorId))) throw new Error('Choose physical headphones for monitoring, not a virtual audio cable.');
    engine.applySettings(state.settings);
    await engine.setMonitoring(enabled, state.settings.monitorId);
    engine.setMonitorVoice($('monitorVoice').checked);
}

$('monitorToggle').onchange = () => run(async () => {
    const enabled = $('monitorToggle').checked;
    $('monitorToggle').disabled = true;
    try { await setMonitoring(enabled); }
    catch (error) { $('monitorToggle').checked = false; await engine.setMonitoring(false); throw error; }
    finally { $('monitorToggle').disabled = false; connectionUI(); }
});

$('monitorVoice').onchange = () => run(async () => {
    state.settings.monitorVoice = $('monitorVoice').checked;
    engine.setMonitorVoice(state.settings.monitorVoice);
    if (!state.settings.monitorVoice && engine.previewing) engine.stopPreview();
    saveSettings(); connectionUI();
});

/* "Hear myself": headphones on, voice included, microphone captured even while offline. */
$('hearBtn').onclick = () => run(async () => {
    const listening = $('hearBtn').getAttribute('aria-pressed') === 'true';
    if (listening) {
        if (engine.connected) {
            // Live: keep monitoring the sounds, just drop the voice from the headphones.
            $('monitorVoice').checked = false; state.settings.monitorVoice = false;
            engine.setMonitorVoice(false); saveSettings();
        } else {
            engine.stopPreview();
            await engine.setMonitoring(false); $('monitorToggle').checked = false;
        }
        connectionUI();
        return;
    }
    if (!state.settings.monitorId) throw new Error('Choose your headphones in the mixer first, then try again.');
    if (state.settings.micId === 'none' || !state.settings.micId) throw new Error('Choose your microphone in the mixer to hear your voice.');
    $('hearBtn').disabled = true;
    try {
        $('monitorVoice').checked = true; state.settings.monitorVoice = true;
        await setMonitoring(true); $('monitorToggle').checked = true;
        if (!engine.connected) await engine.previewVoice(state.settings.micId);
        saveSettings();
    } catch (error) {
        engine.stopPreview();
        throw error;
    } finally { $('hearBtn').disabled = false; connectionUI(); }
});

/* ─── Voice controls ───────────────────────────────────────── */
$('voicePitch').oninput = () => {
    state.settings.voicePitch = Number($('voicePitch').value);
    syncVoiceUI();
    clearTimeout(effectTimer);
    effectTimer = setTimeout(() => engine.setEffect(state.settings.effect, { voicePitch: state.settings.voicePitch }), 120);
    saveSettings();
};
$('resetPitch').onclick = () => { $('voicePitch').value = 0; $('voicePitch').dispatchEvent(new Event('input')); };
$('effectMix').oninput = () => {
    state.settings.effectMix = Number($('effectMix').value);
    engine.setEffectMix(state.settings.effectMix);
    syncVoiceUI();
    saveSettings();
};

for (const group of GROUPS) {
    const presets = PRESETS.filter(preset => preset.group === group.id);
    if (!presets.length) continue;
    const section = document.createElement('section');
    section.className = 'effect-group';
    const head = document.createElement('div'); head.className = 'effect-group-head';
    const title = document.createElement('h3'); title.textContent = group.name;
    const blurb = document.createElement('span'); blurb.textContent = group.blurb;
    head.append(title, blurb);
    const grid = document.createElement('div'); grid.className = 'effect-grid';
    for (const preset of presets) {
        const button = document.createElement('button');
        button.className = 'effect'; button.dataset.effect = preset.id; button.title = preset.description;
        button.setAttribute('aria-label', preset.name);
        const symbol = document.createElement('span'); symbol.className = 'effect-symbol'; symbol.textContent = preset.symbol;
        const label = document.createElement('span'); label.className = 'effect-name'; label.textContent = preset.name;
        button.append(symbol, label);
        button.onclick = () => chooseEffect(preset.id);
        grid.append(button);
    }
    section.append(head, grid);
    $('effects').append(section);
}


/* ─── Replay buffer ────────────────────────────────────────── */
const clock = seconds => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
let editorCapture = null, editorSamples = null, editorBuffer = null, editorRate = 48000, previewFrame = 0;

function replayUI(detail) {
    const armed = Boolean(engine.replay);
    $('replayToggle').checked = armed;
    $('replayArm').classList.toggle('armed', armed);
    const seconds = Number($('replaySeconds').value) || 60;
    $('replayTitle').textContent = armed ? `Keeping the last ${seconds} seconds` : 'Replay buffer is off';
    $('replayHint').textContent = armed
        ? `Listening to your computer’s audio. Press ${prettyKey('Control+Alt+R')} to save it.`
        : 'Turn it on to keep the last minute of everything you hear — Discord, game chat, anyone\'s voice — ready to save.';
    $('captureBtn').disabled = !armed;
    $('captureBtnText').textContent = `Save the last ${seconds} s`;
    $('navReplay').textContent = armed ? `${seconds}s` : 'Off';
    $('replayNav').classList.toggle('active-soft', armed);
    if (!armed) { $('replayLevelFill').style.transform = 'scaleX(0)'; $('replayLevelLabel').textContent = '—'; }
    if (detail?.reason) toast(detail.reason, true);
    pushOverlay();
}

async function armReplay(enabled) {
    if (!enabled) { engine.stopReplay(); return; }
    $('replayToggle').disabled = true;
    try {
        await engine.startReplay({ seconds: Number($('replaySeconds').value) || 60, includeMic: $('replayMic').checked });
    } catch (error) {
        $('replayToggle').checked = false;
        throw error;
    } finally { $('replayToggle').disabled = false; replayUI(); }
}

async function saveCapture() {
    if (!engine.replay) throw new Error('The replay buffer is off. Turn it on in the Replay buffer tab first.');
    const { samples, sampleRate } = await engine.grabReplay();
    if (samples.length < sampleRate * 0.25) throw new Error('Nothing captured yet — give it a second and try again.');
    $('captureBtn').classList.add('flash'); setTimeout(() => $('captureBtn').classList.remove('flash'), 300);
    const duration = samples.length / sampleRate;
    const result = await window.deck.saveCapture(encodeWav(samples, sampleRate), duration);
    acceptLibrary(result);
    toast(`Saved the last ${Math.round(duration)} seconds. Trim it in the Replay buffer tab.`);
    if (view === 'replay' && result.added) openCapture(result.added);
}

function renderCaptures() {
    const list = $('captureList');
    list.replaceChildren();
    $('captureCount').textContent = state.captures.length;
    $('captureEmpty').hidden = state.captures.length > 0;
    for (const capture of state.captures) {
        const button = document.createElement('button');
        button.className = `capture${capture.id === editorCapture?.id ? ' active' : ''}`;
        button.dataset.id = capture.id;
        const title = document.createElement('span'); title.className = 'capture-title'; title.textContent = capture.name;
        const sub = document.createElement('span'); sub.className = 'capture-sub';
        sub.textContent = `${clock(capture.duration)} · ${capture.createdAt ? new Date(capture.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}`;
        button.append(title, sub);
        button.onclick = () => run(() => openCapture(capture.id));
        list.append(button);
    }
    if (editorCapture && !state.captures.some(c => c.id === editorCapture.id)) closeEditor();
}

async function openCapture(id) {
    const capture = state.captures.find(c => c.id === id);
    if (!capture) return;
    stopCapturePreview();
    await engine.init();
    const bytes = await window.deck.readCapture(id);
    const buffer = await engine.context.decodeAudioData(new Uint8Array(bytes).buffer);
    editorCapture = capture; editorBuffer = buffer; editorRate = buffer.sampleRate; editorSamples = buffer.getChannelData(0);
    $('editor').hidden = false;
    $('captureName').value = capture.name;
    $('captureMeta').textContent = `${clock(buffer.duration)} · ${capture.createdAt ? new Date(capture.createdAt).toLocaleString() : ''}`;
    for (const id of ['trimStart', 'trimEnd']) { $(id).max = buffer.duration.toFixed(2); }
    const [start, end] = audibleRange(editorSamples, editorRate);
    $('trimStart').value = start.toFixed(2); $('trimEnd').value = end.toFixed(2);
    renderCaptures();
    updateSelection();
    drawWaveform();
}

function closeEditor() { stopCapturePreview(); editorCapture = null; editorSamples = null; editorBuffer = null; $('editor').hidden = true; }

function selectionRange() {
    let start = Number($('trimStart').value), end = Number($('trimEnd').value);
    if (end - start < 0.1) { if (start > 0.1) start = end - 0.1; else end = start + 0.1; }
    return [Math.max(0, start), Math.min(Number($('trimEnd').max) || end, end)];
}

function updateSelection() {
    if (!editorSamples) return;
    const [start, end] = selectionRange();
    const total = editorSamples.length / editorRate;
    $('trimStartValue').textContent = clock(start); $('trimEndValue').textContent = clock(end);
    $('selection').style.left = `${(start / total) * 100}%`;
    $('selection').style.width = `${((end - start) / total) * 100}%`;
    $('selectionMeta').textContent = `Selection ${clock(end - start)}`;
}

function drawWaveform() {
    const canvas = $('waveform'), wrap = $('waveWrap');
    if (!editorSamples || $('replayView').hidden) return;
    const width = Math.max(200, wrap.clientWidth), height = 140, scale = window.devicePixelRatio || 1;
    canvas.width = width * scale; canvas.height = height * scale;
    const ctx = canvas.getContext('2d'); ctx.scale(scale, scale);
    ctx.clearRect(0, 0, width, height);
    const peaks = waveformPeaks(editorSamples, width);
    const mid = height / 2;
    ctx.fillStyle = '#f0a24a';
    for (let x = 0; x < width; x++) { const h = Math.max(1, peaks[x] * (height - 8)); ctx.fillRect(x, mid - h / 2, 1, h); }
    ctx.fillStyle = '#ffffff20'; ctx.fillRect(0, mid, width, 1);
}

function resetCapturePreviewUI() {
    cancelAnimationFrame(previewFrame);
    $('playhead').hidden = true;
    $('previewBtn').querySelector('span:last-child').textContent = 'Play selection';
    $('previewBtn').querySelector('.btn-icon').textContent = '▶';
}

function stopCapturePreview() {
    resetCapturePreviewUI();
    if (engine.auditionSession?.owner === 'capture') engine.stopAudition();
}

/** Previews the selection in the chosen headphones only. Nothing reaches the broadcast or replay. */
async function previewSelection() {
    if (!editorBuffer) return;
    if (engine.auditionSession?.owner === 'capture') { stopCapturePreview(); return; }
    const [start, end] = selectionRange();
    const session = await engine.auditionBuffer(editorBuffer, { deviceId: previewDevice(), playback: { startSeconds: start, endSeconds: end } });
    session.owner = 'capture';
    $('previewBtn').querySelector('span:last-child').textContent = 'Stop';
    $('previewBtn').querySelector('.btn-icon').textContent = '■';
    const total = editorBuffer.duration, playhead = $('playhead');
    playhead.hidden = false;
    const tick = () => {
        if (engine.auditionSession !== session) { resetCapturePreviewUI(); return; }
        playhead.style.left = `${((start + Math.min(end - start, engine.auditionTime())) / total) * 100}%`;
        previewFrame = requestAnimationFrame(tick);
    };
    tick();
}

/** Copies the whole capture onto the board and plays only the selection, so the region can be widened later. */
async function addCaptureFullToBoard() {
    if (!editorBuffer) return;
    const [start, end] = selectionRange();
    const total = editorBuffer.duration;
    const playback = { startSeconds: start, endSeconds: end >= total - 0.5 / editorRate ? null : end, fadeInMs: 0, fadeOutMs: 0 };
    const name = $('captureName').value.trim() || editorCapture.name;
    const result = await window.deck.captureToPad(editorCapture.id, name, start === 0 && playback.endSeconds === null ? null : playback);
    acceptLibrary(result);
    toast(`“${name}” is on your soundboard. It plays ${clock(end - start)} and keeps the full ${clock(total)} capture, so you can change its region later.`);
}

/** The older path: a new, shorter file. It cannot be expanded later. */
async function addCaptureToBoard() {
    if (!editorSamples) return;
    const [start, end] = selectionRange();
    const slice = editorSamples.subarray(Math.floor(start * editorRate), Math.floor(end * editorRate));
    const name = $('captureName').value.trim() || editorCapture.name;
    const result = await window.deck.importCapture(name, encodeWav(slice, editorRate));
    acceptLibrary(result);
    toast(`“${name}” is on your soundboard as a trimmed copy (${clock(end - start)}).`);
}

$('replayToggle').onchange = () => run(() => armReplay($('replayToggle').checked));
$('replaySeconds').onchange = () => run(async () => {
    state.settings.replaySeconds = Number($('replaySeconds').value); saveSettings();
    if (engine.replay) await armReplay(true); else replayUI();
});
$('replayMic').onchange = () => { state.settings.replayMic = $('replayMic').checked; engine.setReplayMic(state.settings.replayMic); saveSettings(); };
$('replayAuto').onchange = () => { state.settings.replayAuto = $('replayAuto').checked; saveSettings(); };
$('captureBtn').onclick = () => run(() => saveCapture());
$('trimStart').oninput = () => { if (Number($('trimStart').value) > Number($('trimEnd').value) - 0.1) $('trimStart').value = (Number($('trimEnd').value) - 0.1).toFixed(2); updateSelection(); };
$('trimEnd').oninput = () => { if (Number($('trimEnd').value) < Number($('trimStart').value) + 0.1) $('trimEnd').value = (Number($('trimStart').value) + 0.1).toFixed(2); updateSelection(); };
$('waveWrap').addEventListener('click', event => {
    if (!editorSamples) return;
    const total = editorSamples.length / editorRate, at = (event.offsetX / $('waveWrap').clientWidth) * total;
    const [start, end] = selectionRange();
    // Click nearer the start handle moves the start; nearer the end handle moves the end.
    if (Math.abs(at - start) <= Math.abs(at - end)) $('trimStart').value = Math.min(at, end - 0.1).toFixed(2); else $('trimEnd').value = Math.max(at, start + 0.1).toFixed(2);
    updateSelection();
});
$('previewBtn').onclick = () => run(previewSelection);
$('snapBtn').onclick = () => { if (!editorSamples) return; const [a, b] = audibleRange(editorSamples, editorRate); $('trimStart').value = a.toFixed(2); $('trimEnd').value = b.toFixed(2); updateSelection(); };
$('selectAllBtn').onclick = () => { if (!editorSamples) return; $('trimStart').value = 0; $('trimEnd').value = $('trimEnd').max; updateSelection(); };
$('addCaptureBtn').onclick = () => run(addCaptureToBoard);
$('addCaptureFullBtn').onclick = () => run(addCaptureFullToBoard);
$('captureToStudio').onclick = () => run(async () => {
    if (!editorBuffer) return;
    const [start, end] = selectionRange();
    const capture = editorCapture, buffer = editorBuffer;
    showView('studio');
    await studio.addCapture(capture, buffer, start, end);
});
engine.addEventListener('audition', event => { if (!event.detail) resetCapturePreviewUI(); });
$('captureName').onchange = () => run(async () => { if (editorCapture) acceptLibrary(await window.deck.renameCapture(editorCapture.id, $('captureName').value)); });
$('deleteCapture').onclick = () => run(async () => {
    if ($('deleteCapture').textContent !== 'Confirm delete') { $('deleteCapture').textContent = 'Confirm delete'; setTimeout(() => { $('deleteCapture').textContent = 'Delete'; }, 3000); return; }
    $('deleteCapture').textContent = 'Delete';
    const id = editorCapture.id; closeEditor(); acceptLibrary(await window.deck.removeCapture(id));
});
$('replayNav').onclick = () => showView('replay');
window.addEventListener('resize', drawWaveform);
engine.addEventListener('replay', event => { replayUI(event.detail); connectionUI(); });

/* ─── Updates ──────────────────────────────────────────────── */
let appVersion = '', updateCountdown = 0, updatePending = false;
function updateUI(state) {
    const button = $('updateBtn'), version = $('versionBtn');
    button.hidden = !['ready', 'installing'].includes(state.status);
    button.disabled = updatePending || state.status === 'installing';
    if (state.status === 'ready') $('updateBtnText').textContent = `Restart to update to v${state.version}`;
    if (state.status === 'installing') $('updateBtnText').textContent = 'Restarting to update…';
    version.classList.toggle('busy', ['checking', 'downloading'].includes(state.status));
    version.textContent = {
        checking: `PulseDeck · v${appVersion} · checking for updates…`,
        downloading: `PulseDeck · v${appVersion} · downloading v${state.version || ''}${state.percent ? ` ${state.percent}%` : ''}`,
        ready: `PulseDeck · v${appVersion} · v${state.version} ready`,
        installing: `PulseDeck · v${appVersion} · restarting to update…`,
        latest: `PulseDeck · v${appVersion} · up to date`,
        manual: `PulseDeck · v${appVersion} · manual updates`,
        error: `PulseDeck · v${appVersion} · update failed`
    }[state.status] || `PulseDeck · v${appVersion}`;
    version.title = state.status === 'error' ? `${state.message || 'Could not reach the update server.'} Click to try again.` : state.status === 'manual' ? state.message : 'Check for updates';
}
$('updateBtn').onclick = () => run(async () => {
    if (updatePending) return;
    updatePending = true;
    $('updateBtn').disabled = true;
    const token = ++updateCountdown;
    try {
        if (engine.connected) {
            const seconds = 5;
            toast(`Updating in ${seconds} seconds. Your broadcast will stop. Press ${prettyKey('Control+Alt+Space')} to cancel.`);
            await new Promise(resolve => setTimeout(resolve, seconds * 1000));
        }
        if (token !== updateCountdown) { toast('Update canceled.'); return; }
        const result = await window.deck.installUpdate();
        if (!result?.ok) toast(result?.message || 'The update could not start. Click the version at the bottom to try again.');
    } finally {
        updatePending = false;
        updateUI(await window.deck.updateState());
    }
});
$('versionBtn').onclick = () => run(async () => {
    const state = await window.deck.checkForUpdates();
    if (['idle', 'manual'].includes(state.status)) { toast(state.message || 'This copy uses manual updates. Opening the download page.'); await window.deck.openReleases(); }
});
window.deck.onUpdate(updateUI);

/* ─── Global wiring ────────────────────────────────────────── */
$('muteBtn').onclick = () => engine.toggleMute();
$('autoLevel').onchange = () => {
    state.settings.autoLevel = $('autoLevel').checked;
    engine.applySettings(state.settings);
    engine.relevel(state.clips);
    saveSettings();
    toast(state.settings.autoLevel ? 'Auto-level on: quiet and loud sounds are evened out.' : 'Auto-level off: sounds play at their original loudness.');
};
for (const id of ['overlayBtn', 'overlayNav']) $(id).onclick = () => run(async () => overlayUI(await window.deck.toggleOverlay()));
window.deck.onOverlayVisible(overlayUI);
$('stopAll').onclick = () => engine.stopAll();
$('importBtn').onclick = importSounds;
$('emptyImport').onclick = importSounds;
$('search').oninput = renderPads;
for (const [id, value] of [['allTab', 'all'], ['favTab', 'favorites'], ['loopTab', 'loops']]) {
    $(id).onclick = () => {
        filter = value;
        for (const [tab, key] of [['allTab', 'all'], ['favTab', 'favorites'], ['loopTab', 'loops']]) $(tab).classList.toggle('active', key === value);
        renderPads();
    };
}

/* ─── Ducking controls ─── */
const DUCK_FIELDS = [['duckThreshold', 'threshold', ' dB'], ['duckReduction', 'reduction', ' dB'], ['duckAttack', 'attack', ' ms'], ['duckHold', 'hold', ' ms'], ['duckRelease', 'release', ' ms']];
function syncDucking() {
    const d = state.settings.ducking || {};
    $('duckEnabled').checked = Boolean(d.enabled);
    $('duckControls').hidden = !d.enabled;
    for (const [id, key, unit] of DUCK_FIELDS) { $(id).value = d[key]; $(id + 'Value').textContent = `${key === 'threshold' || key === 'reduction' ? String(d[key]).replace('-', '−') : d[key]}${unit}`; }
}
function saveDucking() { engine.applySettings(state.settings); syncDucking(); saveSettings(); }
$('duckEnabled').onchange = () => { state.settings.ducking = { ...state.settings.ducking, enabled: $('duckEnabled').checked }; saveDucking(); };
for (const [id, key] of DUCK_FIELDS) $(id).oninput = () => { state.settings.ducking = { ...state.settings.ducking, [key]: Number($(id).value) }; saveDucking(); };
$('boardNav').onclick = () => showView('board');
$('studioNav').onclick = () => showView('studio');
$('voiceNav').onclick = () => showView('voice');
$('headerVoice').onclick = () => showView('voice');
for (const id of ['guideNav', 'setupBtn']) $(id).onclick = () => $('guideDialog').showModal();
$('closeGuide').onclick = () => $('guideDialog').close();
$('driverLink').onclick = () => run(() => window.deck.openDriver());
$('openData').onclick = () => run(() => window.deck.openData());

engine.addEventListener('playing', updatePlaying);
engine.addEventListener('connection', connectionUI);
engine.addEventListener('fault', event => toast(event.detail, true));
engine.addEventListener('mute', event => {
    $('muteBtn').classList.toggle('muted', event.detail);
    $('muteBtn').querySelector('.mute-text').textContent = event.detail ? 'Mic muted' : 'Mic live';
    $('muteBtn').setAttribute('aria-pressed', String(event.detail));
    $('muteBtn').title = `${event.detail ? 'Unmute' : 'Mute'} microphone (${prettyKey('Control+Alt+M')})`;
    pushOverlay();
});
engine.addEventListener('analysis', event => run(async () => {
    const clip = state.clips.find(c => c.id === event.detail.id);
    if (!clip) return;
    const d = event.detail;
    const differs = (a, b, tolerance) => (a ?? null) === null || (b ?? null) === null ? (a ?? null) !== (b ?? null) : Math.abs(a - b) > tolerance;
    const changed = Math.abs(clip.duration - d.duration) > 0.01 || (clip.analysisKey || 'full') !== d.analysisKey || differs(clip.loudness, d.loudness, 0.5) || differs(clip.peak, d.peak, 0.001);
    if (changed) acceptLibrary(await window.deck.editSound(clip.id, { duration: d.duration, loudness: d.loudness, peak: d.peak, analysisKey: d.analysisKey }));
}));

window.deck.onShortcut(action => {
    if (action.type === 'stop') { updateCountdown++; engine.stopAll(); }
    else if (action.type === 'capture') run(() => saveCapture());
    else if (!$('editDialog').open && !$('guideDialog').open) {
        if (action.type === 'mute') engine.toggleMute();
        else { const clip = state.clips.find(c => c.id === action.id); if (clip) run(() => engine.play(clip)); }
    }
});

document.addEventListener('keydown', event => { if (view === 'studio') studio.handleKey(event); });
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !document.querySelector('dialog[open]') && engine.instances.size) engine.stopAll();
});

let dragDepth = 0;
window.addEventListener('dragenter', event => { event.preventDefault(); if (event.dataTransfer.types.includes('Files')) { dragDepth++; $('dropOverlay').hidden = false; } });
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('dragleave', event => { event.preventDefault(); if (--dragDepth <= 0) { $('dropOverlay').hidden = true; dragDepth = 0; } });
window.addEventListener('drop', event => {
    event.preventDefault(); dragDepth = 0; $('dropOverlay').hidden = true;
    const files = Array.from(event.dataTransfer.files);
    if (files.length) run(async () => { acceptLibrary(await window.deck.dropSounds(files)); showView('board'); });
});

navigator.mediaDevices.addEventListener('devicechange', () => run(() => refreshDevices()));
window.addEventListener('beforeunload', () => { clearTimeout(saveTimer); const { overlay, ...settings } = state.settings; window.deck.saveSettings(settings); engine.disconnect(); engine.monitor.pause(); });
window.addEventListener('unhandledrejection', event => { event.preventDefault(); toast(event.reason?.message || 'An unexpected audio error occurred.', true); });

setInterval(() => {
    const level = engine.level();
    $('levelFill').style.transform = `scaleX(${level})`;
    $('levelLabel').textContent = level > 0.02 ? 'ACTIVE' : 'SILENT';
    const voice = engine.micLevel();
    $('micLevelFill').style.transform = `scaleX(${voice})`;
    $('micLevelLabel').textContent = voice > 0.02 ? (voice > 0.7 ? 'Loud' : 'Speaking') : (engine.source ? 'Quiet' : 'Mic off');
    if (engine.replay) {
        const heard = engine.replayLevel();
        $('replayLevelFill').style.transform = `scaleX(${heard})`;
        $('replayLevelLabel').textContent = heard > 0.02 ? 'Sound' : 'Quiet';
    }
    if (engine.instances.size) pushOverlay(false);
    const ducking = state.settings.ducking?.enabled;
    const reduction = engine.context && ducking ? engine.duckingDb() : 0;
    $('duckState').textContent = !ducking ? 'Off' : reduction < -0.5 ? `Lowering sounds ${reduction.toFixed(0).replace('-', '−')} dB` : engine.connected && engine.source ? 'Listening for your voice' : 'On · connect your microphone';
}, 80);
requestAnimationFrame(animateProgress);

await run(async () => {
    const result = await window.deck.getLibrary();
    state.settings = result.settings;
    acceptLibrary(result);
    syncSettingsUI();
    await refreshDevices();
    overlayUI(await window.deck.overlayVisible());
    appVersion = await window.deck.version();
    document.querySelector('.version').textContent = `v${appVersion}`;
    updateUI(await window.deck.updateState());
    if (result.warning) toast(result.warning, true);
    queueUI.load(result.queue || []);
    await studio.init();
    await ttsUI.init();
    if (state.settings.replayAuto) run(() => armReplay(true));
});

// Automated runs measure the real engine; normal launches never expose internals.
if (window.deck.testMode) window.__test = { engine, studio, recorder: recorderUI.recorder, tts: ttsUI, queue: queueUI.queue, state: () => state };
