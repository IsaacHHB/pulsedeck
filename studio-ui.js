import * as model from './studio-model.js';
import { scheduleProject, renderProject, bufferToWav, renderedBytes, canonicalAsset, samplesToAsset } from './studio-audio.js';
import { resolveRegion, playedDuration } from './playback-region.js';
import { formatTime } from './waveform.js';
import { askText, askChoice } from './dialogs.js';
import { levelGainDb } from './audio.js';

const HEADER = 168;          // track header column width, px
const CACHE_BYTES = 256 * 1024 * 1024;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };

/**
 * Sound Studio controller: project lifecycle, source browser, multitrack timeline, inspector,
 * headphone preview, and rendering. Audio routing goes through the engine's private preview bus;
 * rendered pads go through the library like any other sound.
 */
export function createStudio({ engine, toast, reportError, previewDevice, getState, acceptLibrary, armReplay, isVisible }) {
    const $ = id => document.getElementById(id);
    const history = new model.History();
    const decoded = new Map();      // `${projectId}:${assetId}` → AudioBuffer, least recently used first
    let current = null;             // { id, project, dirty, unsaved, selectedRegion, selectedTrack, playhead }
    let sourceTab = 'sounds', selectedSource = null, pps = 60, drag = null, playFrame = 0, draftTimer = null;
    let rendering = null, renderToken = 0, openToken = 0, previewSession = null, previewInfo = null, previewToken = 0, renderedWidth = -1;

    const run = async action => { try { return await action(); } catch (error) { reportError(error); return undefined; } };
    const projects = () => getState().projects || [];
    const regionById = id => current?.project.regions.find(r => r.id === id) || null;

    /* ─── Project lifecycle ─── */

    function setStatus(message) {
        const p = current?.project;
        $('studioStatus').textContent = message || (!p ? 'No project open' : current.dirty ? 'Unsaved changes · recovery draft kept' : current.unsaved ? 'New project · not saved yet' : `Saved · revision ${p.revision}`);
        const has = Boolean(p);
        for (const id of ['studioSave', 'studioSaveCopy', 'studioRename', 'studioDelete', 'studioRender', 'studioExport', 'studioPlay', 'studioReturn', 'studioAddTrack', 'studioGrab', 'studioImportFile']) $(id).disabled = !has;
        for (const id of ['srcInsert', 'srcAppend', 'srcLayer']) $(id).disabled = !selectedSource;
        $('srcPreview').disabled = !selectedSource;
        $('studioUndo').disabled = !has || !history.canUndo;
        $('studioRedo').disabled = !has || !history.canRedo;
        $('navStudio').textContent = p ? (current.dirty ? 'Edited' : 'Open') : '—';
        $('studioEmpty').hidden = has;
        $('studioWork').classList.toggle('empty', !has);
    }

    function renderProjectList() {
        const select = $('studioProject');
        select.replaceChildren(new Option(projects().length ? 'Open a project…' : 'No projects yet', ''));
        for (const entry of projects()) select.add(new Option(`${entry.name}${entry.saved ? '' : ' (not saved)'}`, entry.id));
        select.value = current?.id || '';
    }

    async function refreshProjects() {
        const list = await window.deck.listProjects();
        getState().projects = list;
        renderProjectList();
    }

    function scheduleDraft() {
        clearTimeout(draftTimer);
        const target = current, id = target?.id;
        draftTimer = setTimeout(() => {
            if (current !== target || !target.dirty) return;
            window.deck.saveProjectDraft(id, target.project).catch(error => { if (current === target) setStatus(`Recovery draft not saved: ${error.message}`); });
        }, 1000);
    }

    /** Applies one undoable edit. A thrown validation error leaves the project unchanged. */
    function edit(change) {
        if (!current) throw new Error('Open or create a project first.');
        const before = current.project;
        const next = change(before);
        history.record(before);
        current.project = next;
        current.dirty = true;
        scheduleDraft();
        renderAll();
        return next;
    }

    /** Save / Discard / Cancel before replacing an open project with unsaved edits. Resolves false on Cancel. */
    async function confirmUnsaved(action = 'continue') {
        if (!current || (!current.dirty && !(current.unsaved && current.project.regions.length))) return true;
        const choice = await askChoice({ eyebrow: 'Sound Studio', title: `Save changes to “${current.project.name}”?`, message: `You have unsaved edits. Save them before you ${action}, discard them, or cancel.`, choices: [{ id: 'cancel', label: 'Cancel' }, { id: 'discard', label: 'Discard', danger: true }, { id: 'save', label: 'Save', primary: true }] });
        if (choice === 'save') { await save(); return !current?.dirty; }
        if (choice === 'discard') { await discardCurrent(); return true; }
        return false;
    }

    async function closeCurrent() {
        if (!current) return;
        stopPreview();
        cancelRender();
        clearTimeout(draftTimer);
        const id = current.id;
        current = null; history.clear(); selectedSourceReset();
        for (const key of [...decoded.keys()]) if (key.startsWith(`${id}:`)) decoded.delete(key);
        await window.deck.closeProject(id).catch(() => {});
    }

    async function discardCurrent() {
        if (!current) return;
        const id = current.id;
        clearTimeout(draftTimer);
        current.dirty = false;
        await window.deck.discardProject(id);
        await closeCurrent();
        await refreshProjects();
        renderAll();
    }

    function selectedSourceReset() { selectedSource = null; renderSources(); }

    async function adopt(project, { dirty = false, unsaved = false } = {}) {
        current = { id: project.id, project, dirty, unsaved, selectedRegion: null, selectedTrack: project.tracks[0]?.id, playhead: 0 };
        history.clear();
        renderProjectList(); renderAll();
        if (dirty) scheduleDraft();
    }

    async function openProject(id, { recover } = {}) {
        if (current?.id === id) return;
        if (!await confirmUnsaved('open another project')) { renderProjectList(); return; }
        const mine = ++openToken;
        await closeCurrent();
        const result = await window.deck.openProject(id);
        if (mine !== openToken) return;
        let project = result.project, dirty = false;
        if (result.draft) {
            const use = recover ?? await askChoice({ eyebrow: 'Recovery', title: 'Recover unsaved changes?', message: `“${result.project.name}” has edits from ${new Date(result.draft.savedAt).toLocaleString()} that were never saved.`, choices: [{ id: 'saved', label: 'Open last save' }, { id: 'recover', label: 'Recover changes', primary: true }] }) === 'recover';
            if (use) { project = result.draft.project; dirty = true; }
            else await window.deck.discardProject(id);
        }
        await adopt(project, { dirty, unsaved: result.unsaved });
        if (result.draftError) toast(result.draftError, true);
        if (result.missing?.length) {
            const affected = project.regions.filter(r => result.missing.includes(r.assetId)).length;
            toast(`Audio for ${affected} region${affected === 1 ? ' is' : 's is'} missing from “${project.name}”. Preview and rendering will fail until you remove ${affected === 1 ? 'that region' : 'those regions'} or restore the files.`, true);
        }
        if (result.unsaved && result.project.regions.length) current.dirty = true;
        setStatus();
    }

    async function newProject(name) {
        if (!await confirmUnsaved('start a new project')) return false;
        const answer = name ? { text: name } : await askText({ eyebrow: 'Sound Studio', title: 'New project', label: 'Project name', value: 'Untitled project', confirm: 'Create' });
        if (!answer) return false;
        await closeCurrent();
        const project = await window.deck.createProject(answer.text);
        await refreshProjects();
        await adopt(project, { unsaved: true });
        return true;
    }

    async function save() {
        if (!current) return;
        const target = current;
        if (target.saving) return target.saving;
        const submitted = model.checkProject(target.project);
        clearTimeout(draftTimer);
        target.saving = (async () => {
            try {
                const saved = await window.deck.saveProject(target.id, submitted);
                if (current === target) {
                    // Editing is allowed during disk IO. Only replace the exact snapshot that was submitted.
                    if (target.project === submitted) { target.project = saved; target.dirty = false; }
                    else { target.project = { ...target.project, revision: saved.revision }; target.dirty = true; scheduleDraft(); }
                    target.unsaved = false;
                    await refreshProjects();
                    if (current === target) renderAll();
                }
                return saved;
            } finally { target.saving = null; }
        })();
        return target.saving;
    }

    async function saveCopy() {
        const target = current;
        const answer = await askText({ eyebrow: 'Sound Studio', title: 'Save as copy', label: 'Copy name', value: `${current.project.name} copy`, confirm: 'Save copy' });
        if (!answer || current !== target) return;
        const submitted = target.project;
        const copy = await window.deck.saveProjectCopy(target.id, submitted, answer.text);
        if (current !== target || target.project !== submitted) { await refreshProjects(); toast(`Saved “${copy.name}”. Your current edits are still open.`); return; }
        const originalName = current.project.name;
        current.dirty = false;
        await window.deck.discardProject(current.id).catch(() => {});
        await closeCurrent();
        await refreshProjects();
        await adopt(copy);
        toast(`Saved “${copy.name}”. “${originalName}” keeps its last saved version.`);
    }

    async function rename() {
        const target = current;
        const answer = await askText({ eyebrow: 'Sound Studio', title: 'Rename project', label: 'Project name', value: current.project.name, confirm: 'Rename' });
        if (!answer || current !== target) return;
        edit(p => model.renameProject(p, answer.text));
        await window.deck.renameProject(target.id, answer.text);
        if (current !== target) return;
        scheduleDraft();
        await refreshProjects(); renderAll();
    }

    async function remove() {
        const name = current.project.name;
        const choice = await askChoice({ eyebrow: 'Sound Studio', title: `Delete “${name}”?`, message: 'The project and its audio are removed. Sounds you already saved to the soundboard keep working.', choices: [{ id: 'cancel', label: 'Cancel' }, { id: 'delete', label: 'Delete project', danger: true }] });
        if (choice !== 'delete') return;
        const id = current.id;
        current.dirty = false;
        await closeCurrent();
        await window.deck.deleteProject(id);
        await refreshProjects(); renderAll();
        toast(`Deleted “${name}”.`);
    }

    /** Makes sure a project is open for an incoming source, asking whether to add to the open one. */
    async function targetProject(suggestedName) {
        if (current) {
            const choice = await askChoice({ eyebrow: 'Sound Studio', title: 'Add to which project?', message: `“${current.project.name}” is open.`, choices: [{ id: 'cancel', label: 'Cancel' }, { id: 'new', label: 'Start a new project' }, { id: 'current', label: 'Add to current project', primary: true }] });
            if (choice === 'current') return true;
            if (choice !== 'new') return false;
        }
        return newProject(`${suggestedName} project`.slice(0, 80));
    }

    /* ─── Sources ─── */

    async function addAsset(canonical, meta, place, target = current) {
        if (!target || current !== target) return null;
        const trackId = target.selectedTrack, playhead = target.playhead;
        const asset = await window.deck.addProjectAsset(target.id, canonical.bytes, meta);
        // A project may have been reopened while this write was pending. Its next normal close/startup
        // can collect this orphan; do not collect another session's unsaved audio here.
        if (current !== target) return null;
        edit(p => {
            const withAsset = model.addAsset(p, asset);
            const placed = model.placeAsset(withAsset, { assetId: asset.id, trackId, playhead, ...place });
            current.selectedRegion = placed.regionId;
            current.selectedTrack = placed.project.regions.find(r => r.id === placed.regionId).trackId;
            return placed.project;
        });
        return asset;
    }

    /** A pad's audio with its playback bounds, fades, and volume intent (never its loop). */
    async function addClip(clip, mode = 'append', { ask = true } = {}) {
        if (ask && !await targetProject(clip.name)) return;
        if (!current) return;
        const target = current;
        const buffer = await engine.load(clip);
        if (current !== target) return;
        const region = resolveRegion(clip.playback, buffer);
        let assetBounds = { inSeconds: 0, outSeconds: buffer.duration }, bounds = { inSeconds: region.start, outSeconds: region.end }, note = '';
        if (buffer.duration > model.STUDIO_LIMITS.assetSeconds) {
            if (region.duration > model.STUDIO_LIMITS.assetSeconds) throw new Error(`“${clip.name}” plays more than 3 minutes. Set a shorter playback region first.`);
            assetBounds = { inSeconds: region.start, outSeconds: region.end }; bounds = { inSeconds: 0, outSeconds: region.duration };
            note = ' Only its playback region was copied because the full source is longer than 3 minutes.';
        }
        const canonical = canonicalAsset(buffer, assetBounds);
        const analysis = engine.analysisFor(clip) || engine.analyze(clip, buffer);
        const levelDb = getState().settings.autoLevel === false ? 0 : levelGainDb(analysis?.loudness, analysis?.peak);
        const gainDb = Math.round(clamp(20 * Math.log10(Math.max(0.001, (clip.volume ?? 100) / 100)) + levelDb, -60, 12) * 10) / 10;
        if (!await addAsset(canonical, { name: clip.name, origin: { kind: 'clip', id: clip.id, label: clip.name } }, { mode, bounds: { ...bounds, fadeInMs: region.fadeIn * 1000, fadeOutMs: region.fadeOut * 1000 }, label: clip.name, gainDb }, target)) return;
        toast(`Added “${clip.name}” to “${current.project.name}”.${note}`);
    }

    /** A replay capture selection. The project keeps its own copy, so evicting the capture is safe. */
    async function addCapture(capture, buffer, start, end, mode = 'append', { ask = true } = {}) {
        if (ask && !await targetProject(capture.name)) return;
        if (!current) return;
        const canonical = canonicalAsset(buffer);
        if (!await addAsset(canonical, { name: capture.name, origin: { kind: 'capture', id: capture.id, label: capture.name } }, { mode, bounds: { inSeconds: start, outSeconds: end }, label: capture.name })) return;
        toast(`Added the selection from “${capture.name}” to “${current.project.name}”.`);
    }

    /** Any canonical audio (microphone takes, speech) placed at the playhead or appended. */
    async function addGenerated(canonical, meta, mode = 'append') {
        if (!current && !await newProject(`${meta.name} project`.slice(0, 80))) return null;
        return addAsset(canonical, meta, { mode, label: meta.name });
    }

    async function grabRecent() {
        const target = current;
        if (!engine.replay) {
            throw Object.assign(new Error('The replay buffer is off, so there is no recent audio to grab. Past audio cannot be recovered; turn the buffer on to keep audio from now on.'), { action: { label: 'Turn on replay buffer', run: () => armReplay(true) } });
        }
        const requested = engine.replay.seconds;
        const { samples, sampleRate } = await engine.grabReplay(requested);
        if (current !== target) return;
        if (samples.length < sampleRate * 0.05) throw new Error('The replay buffer has no audio yet. Give it a moment and try again.');
        const seconds = samples.length / sampleRate;
        const name = `Recent audio ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
        await addGenerated(samplesToAsset(samples, sampleRate), { name, origin: { kind: 'replay', label: `${seconds.toFixed(1)} s snapshot` } }, 'insert');
        toast(seconds < requested - 0.5 ? `Added ${seconds.toFixed(1)} s of recent audio. The buffer had only ${seconds.toFixed(1)} of ${requested} s so far.` : `Added the last ${Math.round(seconds)} s of audio. The replay buffer keeps running.`);
    }

    async function importFile() {
        const target = current;
        const file = await window.deck.importStudioFile();
        if (!file || current !== target) return;
        await engine.init();
        let buffer;
        try { buffer = await engine.context.decodeAudioData(new Uint8Array(file.bytes).buffer); }
        catch { throw new Error(`“${file.name}” could not be decoded. Try MP3 or WAV.`); }
        if (current !== target) return;
        await addGenerated(canonicalAsset(buffer), { name: file.name, origin: { kind: 'file', label: file.name } }, 'append');
    }

    function sourceItems() {
        const search = $('studioSearch').value.trim().toLowerCase();
        const state = getState();
        if (sourceTab === 'captures') return state.captures.filter(c => c.name.toLowerCase().includes(search)).map(c => ({ kind: 'capture', id: c.id, name: c.name, seconds: c.duration }));
        return state.clips.filter(c => c.name.toLowerCase().includes(search) || (c.tags || []).some(t => t.toLowerCase().includes(search))).map(c => ({ kind: 'clip', id: c.id, name: c.name, seconds: playedDuration(c) }));
    }

    function renderSources() {
        for (const tab of document.querySelectorAll('[data-source-tab]')) tab.classList.toggle('active', tab.dataset.sourceTab === sourceTab);
        const list = $('studioSourceList');
        list.replaceChildren();
        const listTab = sourceTab === 'sounds' || sourceTab === 'captures';
        list.hidden = !listTab; $('studioSearchWrap').hidden = !listTab; $('sourceActions').hidden = !listTab;
        for (const panel of document.querySelectorAll('[data-source-panel]')) panel.hidden = panel.dataset.sourcePanel !== sourceTab;
        if (!listTab) { setStatusButtons(); return; }
        const items = sourceItems();
        if (selectedSource && !items.some(i => i.id === selectedSource.id)) selectedSource = null;
        if (!items.length) list.append(el('p', 'field-help', sourceTab === 'captures' ? 'No replay captures yet.' : 'No matching sounds.'));
        for (const item of items) {
            const row = el('button', `source-row${selectedSource?.id === item.id ? ' active' : ''}`);
            row.type = 'button'; row.dataset.id = item.id;
            row.append(el('span', 'source-name', item.name), el('span', 'source-time', item.seconds ? formatTime(item.seconds).replace(/\.\d+$/, '') : '—'));
            row.onclick = () => { selectedSource = item; renderSources(); };
            row.ondblclick = () => run(() => addSelected('append'));
            list.append(row);
        }
        setStatusButtons();
    }
    function setStatusButtons() {
        for (const id of ['srcInsert', 'srcAppend', 'srcLayer']) $(id).disabled = !selectedSource || !current;
        $('srcPreview').disabled = !selectedSource;
    }

    async function addSelected(mode) {
        if (!selectedSource) return;
        if (!current) throw new Error('Create or open a project first.');
        const state = getState();
        const target = current;
        if (selectedSource.kind === 'clip') {
            const clip = state.clips.find(c => c.id === selectedSource.id) || (() => { throw new Error('That sound is no longer on the board.'); })();
            await addClip(clip, mode, { ask: false });
        } else {
            const capture = state.captures.find(c => c.id === selectedSource.id) || (() => { throw new Error('That capture is no longer available.'); })();
            const buffer = await decodeBytes(await window.deck.readCapture(capture.id), capture.name);
            if (current !== target) return;
            await addCapture(capture, buffer, 0, buffer.duration, mode, { ask: false });
        }
    }

    async function previewSource() {
        if (previewSession?.owner === 'source' && engine.auditionSession === previewSession) { stopPreview(); return; }
        stopPreview();
        const token = previewToken, selected = selectedSource;
        if (!selected) return;
        const state = getState();
        let buffer, playback = null, gain = 1;
        if (selected.kind === 'clip') {
            const clip = state.clips.find(c => c.id === selected.id);
            buffer = await engine.load(clip); playback = clip.playback; gain = engine.clipGain(clip);
        } else buffer = await decodeBytes(await window.deck.readCapture(selected.id), selected.name);
        if (token !== previewToken) return;
        const session = await engine.auditionBuffer(buffer, { deviceId: previewDevice(), playback, gain });
        if (token !== previewToken) { if (engine.auditionSession === session) engine.stopAudition(); return; }
        previewSession = session;
        previewSession.owner = 'source';
        $('srcPreview').textContent = 'Stop preview';
    }

    async function decodeBytes(bytes, name) {
        await engine.init();
        try { return await engine.context.decodeAudioData(new Uint8Array(bytes).buffer); }
        catch { throw new Error(`“${name}” could not be decoded.`); }
    }

    /** Decodes project audio on demand (never on launch), keeping about 256 MB of decoded audio. */
    async function loadBuffers(project) {
        const needed = new Set(project.regions.map(r => r.assetId)), map = new Map();
        const bytes = project.assets.filter(a => needed.has(a.id)).reduce((total, a) => total + Math.ceil(a.duration * model.SAMPLE_RATE) * a.channels * 4, 0);
        if (bytes > CACHE_BYTES) throw new Error('This project needs more than 256 MB of decoded audio. Use shorter source selections or split it into smaller projects. Your saved project is unchanged.');
        for (const assetId of needed) {
            const key = `${project.id}:${assetId}`;
            let buffer = decoded.get(key);
            if (buffer) { decoded.delete(key); decoded.set(key, buffer); }
            else {
                const asset = project.assets.find(a => a.id === assetId);
                buffer = await decodeBytes(await window.deck.readProjectAsset(project.id, assetId), asset?.name || 'Project audio');
                decoded.set(key, buffer);
                let total = [...decoded.values()].reduce((sum, b) => sum + b.length * b.numberOfChannels * 4, 0);
                for (const [k, b] of decoded) {
                    if (total <= CACHE_BYTES) break;
                    if (k.startsWith(`${project.id}:`) && needed.has(k.slice(project.id.length + 1))) continue;
                    decoded.delete(k); total -= b.length * b.numberOfChannels * 4;
                }
            }
            map.set(assetId, buffer);
        }
        return map;
    }

    /* ─── Preview transport (headphones only) ─── */

    function playRange() {
        const p = current.project;
        return p.exportRange ? { ...p.exportRange } : { startSeconds: 0, endSeconds: model.timelineDuration(p) };
    }

    async function togglePlay() {
        if (!current) return;
        if (previewSession?.owner === 'studio' && engine.auditionSession === previewSession) { pause(); return; }
        stopPreview();
        const token = previewToken, target = current;
        const project = model.checkProject(current.project);
        const range = playRange();
        if (range.endSeconds <= range.startSeconds) throw new Error('Add audio to the timeline to preview it.');
        let from = current.playhead;
        if (from < range.startSeconds || from >= range.endSeconds - 0.005) from = range.startSeconds;
        const deviceId = previewDevice();
        const buffers = await loadBuffers(project);
        if (token !== previewToken || current !== target) return;
        const session = await engine.startAudition(deviceId);
        if (token !== previewToken || current !== target) { if (engine.auditionSession === session) engine.stopAudition(); return; }
        session.owner = 'studio';
        const when = engine.context.currentTime + 0.03;
        for (const source of scheduleProject(engine.context, session.input, project, buffers, { from, to: range.endSeconds, when })) session.add(source);
        previewSession = session; previewInfo = { from, when, end: range.endSeconds };
        $('studioPlay').textContent = '❚❚ Pause';
        // A timer (not animation frames) keeps the playhead and end-of-timeline stop working in a hidden window.
        const tick = () => {
            if (engine.auditionSession !== session || !previewInfo) return;
            const t = previewInfo.from + Math.max(0, engine.context.currentTime - previewInfo.when);
            if (t >= previewInfo.end) { current.playhead = previewInfo.end; stopPreview(); renderPlayhead(); return; }
            current.playhead = t; renderPlayhead();
            playFrame = setTimeout(tick, 40);
        };
        tick();
    }

    function pause() {
        if (previewSession?.owner === 'studio' && engine.auditionSession === previewSession && previewInfo) {
            current.playhead = Math.min(previewInfo.end, previewInfo.from + Math.max(0, engine.context.currentTime - previewInfo.when));
        }
        stopPreview(); renderPlayhead();
    }

    function stopPreview() {
        previewToken++;
        clearTimeout(playFrame);
        if (previewSession && engine.auditionSession === previewSession) engine.stopAudition();
        previewSession = null; previewInfo = null;
        $('studioPlay').textContent = '▶ Preview';
        $('srcPreview').textContent = 'Preview';
    }

    engine.addEventListener('audition', event => { if (!event.detail && previewSession && engine.auditionSession !== previewSession) { clearTimeout(playFrame); previewSession = null; previewInfo = null; $('studioPlay').textContent = '▶ Preview'; $('srcPreview').textContent = 'Preview'; } });
    engine.addEventListener('stopall', stopPreview);

    function returnToStart() { stopPreview(); if (current) { current.playhead = playRange().startSeconds; renderPlayhead(); } }

    /* ─── Render, save as sound, export ─── */

    async function renderCurrent(project) {
        if (rendering) throw new Error('A render is already running. Wait for it or cancel it.');
        const token = ++renderToken;
        rendering = { token, cancelled: false };
        $('studioProgress').hidden = false; $('studioProgressBar').value = 0;
        try {
            const checked = model.checkProject(structuredClone(project));
            const buffers = await loadBuffers(checked);
            const result = await renderProject(checked, buffers, { onProgress: value => { if (rendering?.token === token) $('studioProgressBar').value = value; }, isCancelled: () => rendering?.token !== token || rendering.cancelled });
            if (!result || rendering?.token !== token || rendering.cancelled) return null;
            return result;
        } finally {
            if (rendering?.token === token) rendering = null;
            $('studioProgress').hidden = true;
        }
    }

    async function saveAsSound() {
        const target = current;
        const answer = await askText({ eyebrow: 'Sound Studio', title: 'Save as new sound', label: 'Sound name', value: current.project.name, colors: true, confirm: 'Render and add to soundboard', help: 'Renders the saved project to a new pad. Later project edits do not change it.' });
        if (!answer || current !== target) return;
        const saved = current.dirty || current.unsaved ? await save() : current.project;
        if (current !== target) return;
        const snapshot = structuredClone(saved), projectId = target.id;
        const result = await renderCurrent(snapshot);
        if (!result || current !== target) { toast('Render cancelled. Nothing was saved.'); return; }
        const bytes = renderedBytes(result.buffer);
        if (bytes > model.STUDIO_LIMITS.padBytes) {
            throw new Error(`This render is ${(bytes / 1048576).toFixed(1)} MB (${formatTime(result.buffer.duration)} of stereo audio). Pads are limited to 30 MB, about 2:43 of stereo. Set an export range to shorten it, or use Export WAV. Your project is unchanged.`);
        }
        const library = await window.deck.saveStudioSound(projectId, snapshot.revision, answer.text, answer.color, bufferToWav(result.buffer));
        acceptLibrary(library);
        toast(`“${answer.text}” is on your soundboard (${formatTime(result.buffer.duration)}).${result.limited ? ' Peaks were reduced to prevent clipping.' : ''}`);
    }

    async function exportWav() {
        const target = current, snapshot = structuredClone(target.project);
        const result = await renderCurrent(snapshot);
        if (!result || current !== target) { toast('Render cancelled. No file was written.'); return; }
        const saved = await window.deck.exportWav(`${snapshot.name}.wav`, bufferToWav(result.buffer));
        if (saved) toast(`Exported ${saved} (${formatTime(result.buffer.duration)}, stereo).${result.limited ? ' Peaks were reduced to prevent clipping.' : ''}`);
    }

    function cancelRender() { if (rendering) { rendering.cancelled = true; $('studioProgress').hidden = true; } }

    /* ─── Timeline ─── */

    const contentSeconds = () => Math.max(30, model.timelineDuration(current.project) + 10, ($('studioTimeline').clientWidth - HEADER) / pps);
    const timeAt = clientX => Math.max(0, (clientX - $('studioInner').getBoundingClientRect().left - HEADER) / pps);
    const snapOn = () => $('studioSnap').checked;
    const snap = (time, exceptId) => model.snapTime(time, { grid: snapOn(), edges: $('studioSnapEdges').checked ? [...model.regionEdges(current.project, exceptId), current.playhead] : [], threshold: $('studioSnapEdges').checked ? 8 / pps : 0 });

    function renderAll() { renderTimeline(); renderInspector(); setStatus(); renderSources(); }

    function renderTimeline() {
        const rows = $('studioTracks');
        renderedWidth = $('studioTimeline').clientWidth;
        rows.replaceChildren();
        if (!current) { $('studioRuler').replaceChildren(); return; }
        const p = current.project, width = contentSeconds() * pps, audible = model.audibleTrackIds(p);
        $('studioInner').style.width = `${HEADER + width}px`;
        renderRuler(width);
        for (const [index, track] of p.tracks.entries()) {
            const row = el('div', `track-row${current.selectedTrack === track.id ? ' selected' : ''}${audible.has(track.id) ? '' : ' silent'}`);
            const head = el('div', 'track-head');
            const name = el('input', 'track-name'); name.value = track.name; name.maxLength = 40; name.setAttribute('aria-label', `Track ${index + 1} name`);
            name.onchange = () => run(() => edit(q => model.updateTrack(q, track.id, { name: name.value })));
            const mute = el('button', `track-toggle${track.mute ? ' on' : ''}`, 'M'); mute.type = 'button'; mute.title = 'Mute'; mute.setAttribute('aria-pressed', String(track.mute));
            mute.onclick = () => run(() => edit(q => model.updateTrack(q, track.id, { mute: !track.mute })));
            const solo = el('button', `track-toggle solo${track.solo ? ' on' : ''}`, 'S'); solo.type = 'button'; solo.title = 'Solo'; solo.setAttribute('aria-pressed', String(track.solo));
            solo.onclick = () => run(() => edit(q => model.updateTrack(q, track.id, { solo: !track.solo })));
            const gain = el('input', 'track-gain'); gain.type = 'number'; gain.min = '-60'; gain.max = '12'; gain.step = '0.5'; gain.value = String(track.gainDb); gain.title = 'Track gain (dB)'; gain.setAttribute('aria-label', `${track.name} gain in dB`);
            gain.onchange = () => run(() => edit(q => model.updateTrack(q, track.id, { gainDb: Number(gain.value) }))).then(() => renderTimeline());
            const drop = el('button', 'track-remove', '×'); drop.type = 'button'; drop.title = 'Remove track and its regions'; drop.disabled = p.tracks.length <= 1;
            drop.onclick = () => run(() => edit(q => model.removeTrack(q, track.id)));
            const controls = el('div', 'track-controls'); controls.append(mute, solo, gain, el('span', 'track-db', 'dB'), drop);
            head.append(name, controls);
            head.onclick = event => { if (event.target === head) { current.selectedTrack = track.id; renderTimeline(); } };
            const lane = el('div', 'track-lane'); lane.dataset.track = track.id; lane.style.width = `${width}px`;
            for (const region of p.regions.filter(r => r.trackId === track.id)) lane.append(regionNode(region));
            row.append(head, lane);
            rows.append(row);
        }
        const range = p.exportRange;
        $('studioRange').hidden = !range;
        if (range) Object.assign($('studioRange').style, { left: `${HEADER + range.startSeconds * pps}px`, width: `${(range.endSeconds - range.startSeconds) * pps}px` });
        renderPlayhead();
    }

    function renderRuler(width) {
        const ruler = $('studioRuler');
        ruler.replaceChildren();
        ruler.style.width = `${width}px`;
        const step = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30].find(s => s * pps >= 60) || 60;
        for (let t = 0; t * pps <= width; t += step) {
            const tick = el('span', 'ruler-tick', formatTime(t).replace(/^0:/, '').replace(/\.000$/, '').replace(/0+$/, '').replace(/\.$/, ''));
            tick.style.left = `${t * pps}px`;
            ruler.append(tick);
        }
    }

    function regionNode(region) {
        const node = el('div', `studio-region${current.selectedRegion === region.id ? ' selected' : ''}`);
        node.dataset.id = region.id;
        const length = model.regionLength(region);
        node.style.left = `${region.atSeconds * pps}px`;
        node.style.width = `${Math.max(3, length * pps)}px`;
        node.style.setProperty('--fade-in', `${Math.min(length, region.fadeInMs / 1000) * pps}px`);
        node.style.setProperty('--fade-out', `${Math.min(length, region.fadeOutMs / 1000) * pps}px`);
        node.title = `${region.label} · ${formatTime(length)}${region.gainDb ? ` · ${region.gainDb > 0 ? '+' : ''}${region.gainDb} dB` : ''}${region.pan ? ` · pan ${region.pan}` : ''}`;
        node.append(el('span', 'region-label', region.label || 'Audio'), el('span', 'region-length', formatTime(length)));
        return node;
    }

    function renderPlayhead() {
        if (!current) return;
        $('studioPlayhead').style.left = `${HEADER + current.playhead * pps}px`;
        $('studioTime').textContent = formatTime(current.playhead);
    }

    function setZoom(next, anchorTime = current?.playhead ?? 0) {
        const scroller = $('studioTimeline');
        const offset = anchorTime * pps - scroller.scrollLeft;
        pps = clamp(next, 8, 1200);
        renderTimeline();
        scroller.scrollLeft = Math.max(0, anchorTime * pps - offset);
    }

    $('studioInner').addEventListener('pointerdown', event => {
        if (!current || event.button !== 0 || event.target.closest('.track-head')) return;
        const node = event.target.closest('.studio-region');
        if (!node) {
            if (event.target.closest('.track-lane')) current.selectedTrack = event.target.closest('.track-lane').dataset.track;
            current.playhead = snap(timeAt(event.clientX));
            current.selectedRegion = null;
            renderTimeline(); renderInspector();
            return;
        }
        const region = regionById(node.dataset.id);
        current.selectedRegion = region.id; current.selectedTrack = region.trackId;
        const rect = node.getBoundingClientRect(), edge = Math.min(8, rect.width / 3);
        const mode = event.clientX - rect.left < edge ? 'trim-start' : rect.right - event.clientX < edge ? 'trim-end' : 'move';
        drag = { mode, id: region.id, startX: event.clientX, grab: timeAt(event.clientX) - region.atSeconds, original: current.project, candidate: null, pointer: event.pointerId };
        $('studioInner').setPointerCapture(event.pointerId);
        renderTimeline(); renderInspector();
    });

    $('studioInner').addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.pointer) return;
        const base = drag.original, region = base.regions.find(r => r.id === drag.id);
        const time = timeAt(event.clientX);
        let patch;
        if (drag.mode === 'move') {
            let at = time - drag.grab;
            const length = model.regionLength(region);
            const snappedStart = snap(at, region.id), snappedEnd = snap(at + length, region.id) - length;
            at = Math.abs(snappedEnd - at) < Math.abs(snappedStart - at) && $('studioSnapEdges').checked ? snappedEnd : snappedStart;
            const lane = document.elementFromPoint(event.clientX, event.clientY)?.closest('.track-lane');
            patch = { atSeconds: Math.max(0, at), trackId: lane?.dataset.track || region.trackId };
        } else if (drag.mode === 'trim-start') {
            const at = clamp(snap(time, region.id), region.atSeconds - region.inSeconds, model.regionEnd(region) - 1 / model.SAMPLE_RATE);
            patch = { atSeconds: at, inSeconds: region.inSeconds + (at - region.atSeconds) };
        } else {
            const asset = base.assets.find(a => a.id === region.assetId);
            const end = clamp(snap(time, region.id), region.atSeconds + 1 / model.SAMPLE_RATE, region.atSeconds + asset.duration - region.inSeconds);
            patch = { outSeconds: region.inSeconds + (end - region.atSeconds) };
        }
        try { drag.candidate = model.updateRegion(base, drag.id, patch); }
        catch { return; }
        current.project = drag.candidate;
        renderTimeline(); renderInspector();
    });

    function endDrag(commit) {
        if (!drag) return;
        const { original, candidate } = drag;
        drag = null;
        if (commit && candidate && JSON.stringify(candidate.regions) !== JSON.stringify(original.regions)) {
            history.record(original); current.dirty = true; scheduleDraft();
        } else current.project = original;
        renderAll();
    }
    $('studioInner').addEventListener('pointerup', event => { if (drag?.pointer === event.pointerId) endDrag(true); });
    $('studioInner').addEventListener('pointercancel', () => endDrag(false));
    $('studioTimeline').addEventListener('wheel', event => {
        if (!current || !(event.ctrlKey || event.metaKey)) return;
        event.preventDefault();
        setZoom(pps * (event.deltaY < 0 ? 1.25 : 0.8), timeAt(event.clientX));
    }, { passive: false });

    /* ─── Inspector ─── */

    const fields = { inspLabel: 'label', inspAt: 'atSeconds', inspIn: 'inSeconds', inspOut: 'outSeconds', inspGain: 'gainDb', inspPan: 'pan', inspFadeIn: 'fadeInMs', inspFadeOut: 'fadeOutMs' };
    function renderInspector() {
        const region = current && regionById(current.selectedRegion);
        $('inspectorEmpty').hidden = Boolean(region);
        $('inspectorFields').hidden = !region;
        if (region) {
            for (const [id, key] of Object.entries(fields)) if (document.activeElement !== $(id)) $(id).value = key === 'label' ? region.label : String(Math.round(region[key] * 1000) / 1000);
            const asset = current.project.assets.find(a => a.id === region.assetId);
            $('inspSource').textContent = `${asset?.name || 'Audio'} · ${formatTime(asset?.duration || 0)} · ${asset?.channels === 2 ? 'stereo' : 'mono'}`;
            $('inspLength').textContent = formatTime(model.regionLength(region));
        }
        const range = current?.project.exportRange;
        $('rangeEnabled').checked = Boolean(range);
        $('rangeEnabled').disabled = !current;
        $('rangeStart').disabled = $('rangeEnd').disabled = !range;
        if (document.activeElement !== $('rangeStart')) $('rangeStart').value = range ? String(range.startSeconds) : '';
        if (document.activeElement !== $('rangeEnd')) $('rangeEnd').value = range ? String(range.endSeconds) : '';
        $('rangeFromRegion').disabled = !region;
    }
    for (const [id, key] of Object.entries(fields)) {
        $(id).addEventListener('change', () => run(() => {
            const value = key === 'label' ? $(id).value : Number($(id).value);
            edit(p => model.updateRegion(p, current.selectedRegion, { [key]: value }));
        }).finally(() => renderInspector()));
    }
    const setRange = range => run(() => edit(p => model.setExportRange(p, range))).finally(() => renderInspector());
    $('rangeEnabled').onchange = () => {
        if (!$('rangeEnabled').checked) { setRange(null); return; }
        const end = model.timelineDuration(current.project);
        if (end <= 0) { $('rangeEnabled').checked = false; reportError(new Error('Add audio before choosing an export range.')); return; }
        setRange({ startSeconds: 0, endSeconds: end });
    };
    for (const id of ['rangeStart', 'rangeEnd']) $(id).onchange = () => setRange({ startSeconds: Number($('rangeStart').value), endSeconds: Number($('rangeEnd').value) });
    $('rangeFromRegion').onclick = () => { const r = regionById(current?.selectedRegion); if (r) setRange({ startSeconds: r.atSeconds, endSeconds: model.regionEnd(r) }); };

    /* ─── Commands ─── */

    const selected = () => regionById(current?.selectedRegion) || (() => { throw new Error('Select a region first.'); })();
    const commands = {
        split: () => { const r = selected(); edit(p => { const out = model.splitRegion(p, r.id, current.playhead); current.selectedRegion = out.regionId; return out.project; }); },
        duplicate: () => { const r = selected(); edit(p => { const out = model.duplicateRegion(p, r.id); current.selectedRegion = out.regionId; return out.project; }); },
        remove: () => { const r = selected(); edit(p => model.removeRegion(p, r.id)); current.selectedRegion = null; renderAll(); },
        undo: () => { if (!current) return; const prev = history.undo(current.project); if (prev) { current.project = prev; current.dirty = true; scheduleDraft(); renderAll(); } },
        redo: () => { if (!current) return; const next = history.redo(current.project); if (next) { current.project = next; current.dirty = true; scheduleDraft(); renderAll(); } },
        addTrack: () => edit(p => { const out = model.addTrack(p); current.selectedTrack = out.trackId; return out.project; })
    };

    /** Studio-only keys, ignored while typing and never with Alt (global shortcuts use Ctrl+Alt). */
    function handleKey(event) {
        if (!isVisible() || event.altKey || document.querySelector('dialog[open]')) return false;
        if (event.target.closest?.('input, textarea, select, [contenteditable]')) return false;
        const mod = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
        if (mod && key === 'z') { event.preventDefault(); event.shiftKey ? commands.redo() : commands.undo(); return true; }
        if (mod && key === 'y') { event.preventDefault(); commands.redo(); return true; }
        if (mod) return false;
        if (event.key === ' ' || event.code === 'Space') { event.preventDefault(); run(togglePlay); return true; }
        if ((event.key === 'Delete' || event.key === 'Backspace') && current?.selectedRegion) { event.preventDefault(); run(commands.remove); return true; }
        if (event.key === 'Escape' && drag) { endDrag(false); return true; }
        return false;
    }

    const wire = (id, action) => { $(id).onclick = () => run(action); };
    wire('studioNew', () => newProject());
    wire('studioEmptyNew', () => newProject());
    wire('studioSave', async () => { const saved = await save(); if (saved) toast(`Saved “${saved.name}”.${current?.dirty ? ' Newer edits are still unsaved.' : ''}`); });
    wire('studioSaveCopy', saveCopy);
    wire('studioRename', rename);
    wire('studioDelete', remove);
    wire('studioRender', saveAsSound);
    wire('studioExport', exportWav);
    wire('studioCancelRender', cancelRender);
    wire('studioPlay', togglePlay);
    wire('studioReturn', returnToStart);
    wire('studioUndo', commands.undo);
    wire('studioRedo', commands.redo);
    wire('studioAddTrack', commands.addTrack);
    wire('studioSplit', commands.split);
    wire('studioDuplicate', commands.duplicate);
    wire('studioRemove', commands.remove);
    wire('studioZoomIn', () => setZoom(pps * 1.5));
    wire('studioZoomOut', () => setZoom(pps / 1.5));
    wire('studioGrab', grabRecent);
    wire('studioImportFile', importFile);
    wire('srcInsert', () => addSelected('insert'));
    wire('srcAppend', () => addSelected('append'));
    wire('srcLayer', () => addSelected('layer'));
    wire('srcPreview', previewSource);
    $('studioProject').onchange = () => { const id = $('studioProject').value; if (id) run(() => openProject(id)); };
    $('studioSearch').oninput = renderSources;
    for (const tab of document.querySelectorAll('[data-source-tab]')) tab.onclick = () => { sourceTab = tab.dataset.sourceTab; renderSources(); };
    // Layout depends only on the timeline width. Showing the view already redraws it (refresh), so skip the
    // observer's follow-up notification for the same width: a needless redraw replaces every timeline node.
    new ResizeObserver(() => { if (current && !drag && isVisible() && $('studioTimeline').clientWidth !== renderedWidth) renderTimeline(); }).observe($('studioTimeline'));

    async function checkRecovery() {
        const list = await window.deck.recoverableProjects();
        const banner = $('studioRecovery');
        if (!list.length) { banner.hidden = true; return; }
        const item = list[0];
        $('studioRecoveryText').textContent = `Unsaved Studio work in “${item.name}” from ${new Date(item.savedAt).toLocaleString()} can be recovered.`;
        banner.hidden = false;
        $('studioRecover').onclick = () => run(async () => { banner.hidden = true; await openProject(item.id, { recover: true }); });
        $('studioRecoveryDiscard').onclick = () => run(async () => { banner.hidden = true; await window.deck.discardProject(item.id); await refreshProjects(); await checkRecovery(); });
    }

    return {
        init: async () => { renderProjectList(); renderAll(); await checkRecovery(); },
        refresh: () => { renderProjectList(); renderSources(); if (current && isVisible() && !drag) renderTimeline(); },
        addClip: clip => run(() => addClip(clip)),
        addCapture: (capture, buffer, start, end) => run(() => addCapture(capture, buffer, start, end)),
        addGenerated: (canonical, meta, mode) => addGenerated(canonical, meta, mode),
        openProject: id => run(() => openProject(id)),
        saveCurrent: async () => { if (current) await save(); },
        handleKey,
        stopPreview,
        get current() { return current; },
        get hasUnsaved() { return Boolean(current?.dirty); },
        get playhead() { return current?.playhead ?? 0; }
    };
}
