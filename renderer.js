import { AudioEngine, levelGainDb } from './audio.js';
import { PRESETS, GROUPS } from './voice-effects.js';
import { encodeWav, waveformPeaks, audibleRange } from './wav.js';

const $ = id => document.getElementById(id);
const engine = new AudioEngine();
let state = { clips: [], captures: [], settings: {} };
let filter = 'all', editing = null, devices = [], toastTimer, saveTimer, effectTimer, busy = false, view = 'board', dragId = null;
const SLOTS = 10;

const prettyKey = key => key.replaceAll('Control', 'Ctrl').replaceAll('+', ' + ');
const duration = value => value ? `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}` : 'Ready';
const presetOf = id => PRESETS.find(preset => preset.id === id) || PRESETS[0];
const deviceLabel = id => devices.find(d => d.deviceId === id)?.label || '';
const isCable = label => /cable input/i.test(label || '');
const isVirtual = label => /cable|voicemeeter|virtual/i.test(label || '');

function toast(message, error = false) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').classList.toggle('error', error);
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 10000 : 5000);
}

async function run(action) {
    try { return await action(); }
    catch (error) { toast(error.message || String(error), true); }
}

/* ─── Views ────────────────────────────────────────────────── */
function showView(name) {
    view = name;
    for (const [id, key] of [['boardView', 'board'], ['voiceView', 'voice'], ['replayView', 'replay']]) $(id).hidden = name !== key;
    for (const [id, key] of [['boardNav', 'board'], ['voiceNav', 'voice'], ['replayNav', 'replay']]) $(id).classList.toggle('active', name === key);
    $('crumbView').textContent = { board: 'Soundboard', voice: 'Voice changer', replay: 'Replay buffer' }[name];
    if (name === 'replay') drawWaveform();
    if ($('guideDialog').open) $('guideDialog').close();
}

/* ─── Library ──────────────────────────────────────────────── */
function acceptLibrary(result) {
    if (!result) return;
    state.clips = result.clips;
    if (Array.isArray(result.captures)) { state.captures = result.captures; renderCaptures(); }
    renderPads();
    if (result.failedHotkeys?.length) toast(`Unavailable shortcuts: ${result.failedHotkeys.map(prettyKey).join(', ')}. Free them in the other app, or assign a different sound shortcut. On-screen controls still work.`, true);
    if (result.errors?.length) toast(result.errors.join('\n'), true);
}

function renderPads() {
    const grid = $('soundGrid');
    grid.replaceChildren();
    $('clipCount').textContent = state.clips.length;
    $('navCount').textContent = state.clips.length;
    $('loopCount').textContent = state.clips.filter(c => c.loop).length;
    const search = $('search').value.trim().toLowerCase();
    const clips = state.clips.filter(c => (filter !== 'loops' || c.loop) && c.name.toLowerCase().includes(search));
    const canReorder = filter === 'all' && !search;
    grid.classList.toggle('reorderable', canReorder);
    $('emptyState').hidden = state.clips.length > 0;
    if (state.clips.length && !clips.length) {
        const note = document.createElement('p');
        note.className = 'grid-note';
        note.textContent = search ? `No sounds match “${$('search').value.trim()}”.` : 'No looping sounds yet. Turn on “Loop until stopped” in a sound’s settings.';
        grid.append(note);
    }
    for (const clip of clips) {
        const pad = document.createElement('article');
        pad.className = `sound-pad ${clip.color}`;
        pad.dataset.id = clip.id;

        const play = document.createElement('button');
        play.className = 'pad-main';
        play.title = `Play or stop ${clip.name}${clip.hotkey ? ` (${prettyKey(clip.hotkey)})` : ''}`;
        const symbol = document.createElement('span'); symbol.className = 'pad-symbol'; symbol.textContent = '▶';
        const body = document.createElement('span'); body.className = 'pad-body';
        const name = document.createElement('span'); name.className = 'pad-name'; name.textContent = clip.name;
        const meta = document.createElement('span'); meta.className = 'pad-meta';
        const time = document.createElement('span'); time.className = 'pad-time'; time.textContent = duration(clip.duration);
        const key = document.createElement('span'); key.className = 'pad-key'; key.textContent = clip.hotkey ? prettyKey(clip.hotkey).replaceAll(' ', '') : '';
        meta.append(time);
        if (clip.loop) { const loop = document.createElement('span'); loop.className = 'pad-loop'; loop.textContent = '↻'; loop.title = 'Loops until stopped'; meta.append(loop); }
        if (clip.hotkey) meta.append(key);
        body.append(name, meta);
        play.append(symbol, body);
        play.addEventListener('click', () => run(() => engine.play(clip)));

        const edit = document.createElement('button');
        edit.className = 'pad-edit'; edit.textContent = '⋯'; edit.title = `Edit ${clip.name}`;
        edit.setAttribute('aria-label', `Edit ${clip.name}`);
        edit.onclick = () => editSound(clip);

        const progress = document.createElement('div'); progress.className = 'pad-progress'; progress.append(document.createElement('div'));
        pad.append(play, edit, progress);
        pad.addEventListener('contextmenu', event => { event.preventDefault(); editSound(clip); });
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
        const entry = engine.playing.get(pad.dataset.id);
        pad.classList.toggle('playing', Boolean(entry));
        pad.classList.toggle('loading', Boolean(entry?.loading));
        pad.querySelector('.pad-symbol').textContent = entry ? '■' : '▶';
        if (!entry) pad.querySelector('.pad-progress > div').style.transform = 'scaleX(0)';
    });
    const count = engine.playing.size;
    $('libraryHint').textContent = count ? `${count} sound${count === 1 ? '' : 's'} playing · click a pad to stop it.` : 'Click a pad to play, click again to stop.';
    pushOverlay();
}

/* ─── Overlay mirror ───────────────────────────────────────── */
let overlayTimer;
function pushOverlay(immediate = true) {
    clearTimeout(overlayTimer);
    const send = () => {
        const progress = {};
        for (const id of engine.playing.keys()) { const value = engine.progress(id); if (value !== null) progress[id] = value; }
        window.deck.overlayState({
            clips: state.clips.map(c => ({ id: c.id, name: c.name, color: c.color, hotkey: c.hotkey, loop: c.loop })),
            playing: [...engine.playing.keys()], muted: engine.muted, live: engine.connected,
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
    if (engine.playing.size) {
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
        ? `Pad ${position + 1} always uses ${prettyKey(clip.hotkey)}. Drag pads on the soundboard to change the order — the first ten get Ctrl+Alt+1…9 and 0.`
        : 'Ctrl+Shift or Alt+Shift plus a letter, number, or F-key (Ctrl+Alt+0–9 are taken by the first ten pads). Works while a game has focus.';
    $('editVolume').value = clip.volume;
    $('editVolumeValue').textContent = clip.volume + '%';
    const loudness = engine.loudness.get(clip.id) ?? clip.loudness;
    const gainDb = levelGainDb(loudness);
    $('editLevelInfo').textContent = Number.isFinite(loudness)
        ? `Measured level ${loudness.toFixed(0)} dB. ${state.settings.autoLevel === false ? 'Auto-level is off.' : gainDb >= 0 ? `Auto-level adds +${gainDb.toFixed(0)} dB.` : `Auto-level trims ${gainDb.toFixed(0)} dB.`}`
        : 'Level not measured yet — play the sound once.';
    const swatch = document.querySelector(`#editColor input[value="${clip.color}"]`) || document.querySelector('#editColor input');
    swatch.checked = true;
    $('editLoop').checked = clip.loop;
    $('deleteSound').textContent = 'Remove sound';
    $('editDialog').showModal();
}

$('editForm').onsubmit = event => {
    event.preventDefault();
    run(async () => {
        const color = document.querySelector('#editColor input:checked')?.value;
        const patch = { name: $('editName').value, volume: Number($('editVolume').value), color, loop: $('editLoop').checked };
        if (!$('editHotkey').disabled) patch.hotkey = $('editHotkey').dataset.key;
        const result = await window.deck.editSound(editing, patch);
        acceptLibrary(result);
        engine.updateClip(state.clips.find(c => c.id === editing));
        $('editDialog').close();
    });
};

$('editHotkey').addEventListener('keydown', event => {
    if (event.key === 'Tab') return;
    event.preventDefault();
    if (['Backspace', 'Delete'].includes(event.key)) { event.target.value = ''; event.target.dataset.key = ''; return; }
    const mods = [event.ctrlKey ? 'Control' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : ''].filter(Boolean);
    const key = event.key.toUpperCase();
    if (mods.length !== 2 || !/^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4]))$/.test(key)) return;
    const value = [...mods, key].join('+');
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
        try { const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); stream.getTracks().forEach(track => track.stop()); }
        catch { toast('Microphone access was unavailable. You can still select Sounds only. Check Windows microphone privacy settings if you want live voice.', true); }
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
}

function routeHelp() {
    const output = devices.find(d => d.deviceId === state.settings.outputId && d.kind === 'audiooutput');
    const cable = isCable(output?.label);
    $('outputHelp').textContent = cable
        ? 'In Discord, OBS, games, or calls, choose CABLE Output as the microphone.'
        : output ? 'For other apps to hear this mix, choose a virtual cable here. A physical speaker output only plays locally.'
        : 'Choose CABLE Input here. Choose CABLE Output as the microphone in your other apps.';
}

function checklist() {
    const micId = state.settings.micId, output = devices.find(d => d.deviceId === state.settings.outputId && d.kind === 'audiooutput');
    const micOk = micId === 'none' || devices.some(d => d.deviceId === micId && d.kind === 'audioinput');
    const hasCableDevice = devices.some(d => d.kind === 'audiooutput' && isCable(d.label));
    const set = (id, status, text) => { $(id).className = status; $(id + 'Text').textContent = text; };
    set('checkMic', micOk ? 'done' : '', micId === 'none' ? 'Sounds only, no live voice' : micOk ? deviceLabel(micId) : 'Scan devices to choose one');
    set('checkCable', output && isCable(output.label) ? 'done' : output ? 'warn' : hasCableDevice ? 'warn' : '',
        output && isCable(output.label) ? output.label : output ? `${output.label} · not a virtual cable` : hasCableDevice ? 'CABLE Input found · select it below' : 'Install VB-CABLE, then pick CABLE Input');
    set('checkLive', engine.connected ? 'done' : '', engine.connected ? 'Live · choose CABLE Output as the mic in your apps' : 'Connect to go live in your apps');
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
    run(() => window.deck.setAudioActive(live || engine.monitoring || engine.previewing));
}

/* ─── Mixer controls ───────────────────────────────────────── */
$('connectBtn').onclick = () => run(async () => {
    if (busy) return;
    if (engine.connected) { engine.disconnect(); return; }
    const mic = deviceLabel(state.settings.micId), output = deviceLabel(state.settings.outputId);
    if (/cable output/i.test(mic) && isCable(output)) throw new Error('Select your physical microphone. Using CABLE Output here would feed the mix back into itself.');
    if (engine.monitoring && state.settings.monitorId === state.settings.outputId) throw new Error('Choose separate outputs for broadcast and headphones.');
    busy = true; $('connectBtn').disabled = true; connectionUI();
    try {
        await engine.connect(state.settings);
        await window.deck.saveSettings(state.settings);
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
let editorCapture = null, editorSamples = null, editorRate = 48000, previewAudio = null, previewTimer = null, previewUrl = null;

function replayUI(detail) {
    const armed = Boolean(engine.replay);
    $('replayToggle').checked = armed;
    $('replayArm').classList.toggle('armed', armed);
    const seconds = Number($('replaySeconds').value) || 60;
    $('replayTitle').textContent = armed ? `Keeping the last ${seconds} seconds` : 'Replay buffer is off';
    $('replayHint').textContent = armed
        ? 'Listening to everything you hear. Press Ctrl+Alt+R any time — even in a game — to save it.'
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
    stopPreview();
    await engine.init();
    const bytes = await window.deck.readCapture(id);
    const buffer = await engine.context.decodeAudioData(new Uint8Array(bytes).buffer);
    editorCapture = capture; editorRate = buffer.sampleRate; editorSamples = buffer.getChannelData(0);
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

function closeEditor() { stopPreview(); editorCapture = null; editorSamples = null; $('editor').hidden = true; }

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

function stopPreview() {
    clearTimeout(previewTimer);
    if (previewAudio) { previewAudio.pause(); previewAudio.src = ''; previewAudio = null; }
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    $('playhead').hidden = true;
    $('previewBtn').querySelector('span:last-child').textContent = 'Play selection';
    $('previewBtn').querySelector('.btn-icon').textContent = '▶';
}

async function previewSelection() {
    if (!editorSamples) return;
    if (previewAudio) { stopPreview(); return; }
    const [start, end] = selectionRange();
    const slice = editorSamples.subarray(Math.floor(start * editorRate), Math.floor(end * editorRate));
    previewUrl = URL.createObjectURL(new Blob([encodeWav(slice, editorRate)], { type: 'audio/wav' }));
    previewAudio = new Audio(previewUrl);
    const phones = state.settings.monitorId;
    if (phones && !isVirtual(deviceLabel(phones)) && previewAudio.setSinkId) { try { await previewAudio.setSinkId(phones); } catch { /* default output */ } }
    $('previewBtn').querySelector('span:last-child').textContent = 'Stop';
    $('previewBtn').querySelector('.btn-icon').textContent = '■';
    previewAudio.onended = stopPreview;
    const total = editorSamples.length / editorRate, playhead = $('playhead');
    playhead.hidden = false;
    const tick = () => {
        if (!previewAudio) return;
        playhead.style.left = `${((start + previewAudio.currentTime) / total) * 100}%`;
        previewTimer = setTimeout(tick, 40);
    };
    await previewAudio.play(); tick();
}

async function addCaptureToBoard() {
    if (!editorSamples) return;
    const [start, end] = selectionRange();
    const slice = editorSamples.subarray(Math.floor(start * editorRate), Math.floor(end * editorRate));
    const name = $('captureName').value.trim() || editorCapture.name;
    const result = await window.deck.importCapture(name, encodeWav(slice, editorRate));
    acceptLibrary(result);
    toast(`“${name}” is on your soundboard (${clock(end - start)}).`);
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
$('captureName').onchange = () => run(async () => { if (editorCapture) acceptLibrary(await window.deck.renameCapture(editorCapture.id, $('captureName').value)); });
$('deleteCapture').onclick = () => run(async () => {
    if ($('deleteCapture').textContent !== 'Confirm delete') { $('deleteCapture').textContent = 'Confirm delete'; setTimeout(() => { $('deleteCapture').textContent = 'Delete'; }, 3000); return; }
    $('deleteCapture').textContent = 'Delete';
    const id = editorCapture.id; closeEditor(); acceptLibrary(await window.deck.removeCapture(id));
});
$('replayNav').onclick = () => showView('replay');
window.addEventListener('resize', drawWaveform);
engine.addEventListener('replay', event => replayUI(event.detail));

/* ─── Updates ──────────────────────────────────────────────── */
let appVersion = '';
function updateUI(state) {
    const button = $('updateBtn'), version = $('versionBtn');
    button.hidden = state.status !== 'ready';
    if (state.status === 'ready') $('updateBtnText').textContent = `Restart to update to v${state.version}`;
    version.classList.toggle('busy', ['checking', 'downloading'].includes(state.status));
    version.textContent = {
        checking: `PulseDeck · v${appVersion} · checking for updates…`,
        downloading: `PulseDeck · v${appVersion} · downloading v${state.version || ''}${state.percent ? ` ${state.percent}%` : ''}`,
        ready: `PulseDeck · v${appVersion} · v${state.version} ready`,
        latest: `PulseDeck · v${appVersion} · up to date`,
        error: `PulseDeck · v${appVersion} · update check failed`
    }[state.status] || `PulseDeck · v${appVersion}`;
    version.title = state.status === 'error' ? `${state.message || 'Could not reach the update server.'} Click to try again.` : 'Check for updates';
}
$('updateBtn').onclick = () => run(async () => {
    if (engine.connected) {
        const seconds = 5;
        toast(`Updating in ${seconds} seconds — your broadcast will stop. Press Ctrl+Alt+Space to cancel.`);
        await new Promise(resolve => setTimeout(resolve, seconds * 1000));
    }
    await window.deck.installUpdate();
});
$('versionBtn').onclick = () => run(async () => {
    const state = await window.deck.checkForUpdates();
    if (state.status === 'idle') { toast('This portable copy does not update itself — opening the download page so you can grab the latest version.'); await window.deck.openReleases(); }
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
for (const [id, value] of [['allTab', 'all'], ['loopTab', 'loops']]) {
    $(id).onclick = () => {
        filter = value;
        $('allTab').classList.toggle('active', value === 'all');
        $('loopTab').classList.toggle('active', value === 'loops');
        renderPads();
    };
}
$('boardNav').onclick = () => showView('board');
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
    $('muteBtn').title = event.detail ? 'Unmute microphone (Ctrl+Alt+M)' : 'Mute microphone (Ctrl+Alt+M)';
    pushOverlay();
});
engine.addEventListener('analysis', event => run(async () => {
    const clip = state.clips.find(c => c.id === event.detail.id);
    if (!clip) return;
    const changed = Math.abs(clip.duration - event.detail.duration) > 0.01 || !Number.isFinite(clip.loudness) || Math.abs(clip.loudness - event.detail.loudness) > 0.5;
    if (changed) acceptLibrary(await window.deck.editSound(clip.id, { duration: event.detail.duration, loudness: event.detail.loudness }));
}));

window.deck.onShortcut(action => {
    if (action.type === 'stop') engine.stopAll();
    else if (action.type === 'capture') run(() => saveCapture());
    else if (!$('editDialog').open && !$('guideDialog').open) {
        if (action.type === 'mute') engine.toggleMute();
        else { const clip = state.clips.find(c => c.id === action.id); if (clip) run(() => engine.play(clip)); }
    }
});

document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$('editDialog').open && !$('guideDialog').open && engine.playing.size) engine.stopAll();
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
    if (engine.playing.size) pushOverlay(false);
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
    if (state.settings.replayAuto) run(() => armReplay(true));
});
