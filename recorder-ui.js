import { Recorder, TAKE_LIMIT_SECONDS } from './recorder.js';
import { encodeWav } from './wav.js';
import { samplesToAsset } from './studio-audio.js';
import { formatTime } from './waveform.js';
import { isVirtual, microphoneHelp } from './platform.js';

/**
 * The recorder dialog, shared by the board (“Record a sound”) and Studio (“Record mic”).
 * Recording needs no broadcast connection and no replay buffer.
 */
export function createRecorderUI({ engine, getState, getDevices, previewDevice, toast, reportError, acceptLibrary, studio, presetName }) {
    const $ = id => document.getElementById(id);
    const dialog = $('recordDialog');
    const recorder = new Recorder(engine);
    let origin = 'board', ticker = 0, previewing = null;

    const run = async action => { try { return await action(); } catch (error) { showError(error); return undefined; } };
    function showError(error) {
        if (error?.code === 'CANCELLED') return;
        $('recError').textContent = error?.message || String(error);
        $('recError').hidden = false;
        if (error?.code === 'NO_PREVIEW_DEVICE') reportError(error);
    }
    const clearError = () => { $('recError').hidden = true; $('recError').textContent = ''; };

    function microphones() {
        return getDevices().filter(d => d.kind === 'audioinput' && d.deviceId && !['default', 'communications'].includes(d.deviceId) && !isVirtual(d.label));
    }

    function fillDevices() {
        const select = $('recMic'), mics = microphones(), saved = getState().settings.micId;
        select.replaceChildren();
        if (!mics.length) select.add(new Option('No microphone found', ''));
        mics.forEach((d, i) => select.add(new Option(d.label || `Microphone ${i + 1}`, d.deviceId)));
        select.value = mics.some(d => d.deviceId === select.dataset.last) ? select.dataset.last : mics.some(d => d.deviceId === saved) ? saved : mics[0]?.deviceId || '';
    }

    function sync() {
        const recording = recorder.state === 'recording', busy = recorder.state === 'acquiring', take = recorder.take;
        $('recRecord').disabled = recording || busy;
        $('recRecord').textContent = busy ? 'Waiting for microphone…' : take ? '● Record again' : '● Record';
        $('recStop').disabled = !recording && !busy;
        $('recStop').textContent = busy ? 'Cancel' : '■ Stop';
        $('recMic').disabled = recording || busy;
        for (const input of document.querySelectorAll('input[name=recMode]')) input.disabled = recording || busy;
        $('recMonitor').disabled = recording || busy;
        for (const id of ['recPreview', 'recDiscard', 'recSave', 'recAppend', 'recInsert']) $(id).disabled = !take || recording || busy;
        $('recInsert').hidden = origin !== 'studio';
        $('recAppend').textContent = origin === 'studio' ? 'Append to project' : 'Add to Studio project';
        $('recTime').textContent = formatTime(recorder.elapsed());
        $('recEffectName').textContent = presetName();
        if (!recording) $('recLevel').style.transform = 'scaleX(0)';
    }

    recorder.addEventListener('state', sync);
    recorder.addEventListener('warning', event => { $('recStatus').textContent = event.detail; });
    recorder.addEventListener('ended', event => {
        clearInterval(ticker);
        const { take, message } = event.detail;
        if (message && !take) showError(new Error(message));
        $('recStatus').textContent = take ? `${message ? `${message} ` : ''}Take: ${formatTime(take.seconds)} · ${take.processed ? 'with voice effect' : 'dry microphone'}.` : '';
        sync();
    });

    async function record() {
        clearError(); stopTakePreview();
        const deviceId = $('recMic').value;
        if (!deviceId) throw new Error(`No microphone is available. Connect one, then click Scan devices in the mixer. ${microphoneHelp}`);
        $('recMic').dataset.last = deviceId;
        const processed = document.querySelector('input[name=recMode]:checked')?.value === 'processed';
        const settings = getState().settings;
        const monitorDevice = $('recMonitor').checked ? previewDevice() : null;
        $('recStatus').textContent = processed ? `Recording with the ${presetName()} voice effect.` : 'Recording the dry microphone.';
        const started = recorder.start({ deviceId, processed, effect: settings.effect, pitch: settings.voicePitch || 0, mix: (settings.effectMix ?? 100) / 100, monitorDevice });
        sync();
        await started;
        if (recorder.state !== 'recording') return;
        clearInterval(ticker);
        ticker = setInterval(() => {
            $('recTime').textContent = formatTime(recorder.elapsed());
            $('recLevel').style.transform = `scaleX(${recorder.level()})`;
            if (recorder.elapsed() > TAKE_LIMIT_SECONDS + 2) clearInterval(ticker);
        }, 80);
    }

    async function stop() { clearInterval(ticker); await recorder.stop('stopped'); sync(); }

    function takeBuffer() {
        const take = recorder.take;
        const buffer = new AudioBuffer({ length: take.samples.length, numberOfChannels: 1, sampleRate: take.sampleRate });
        buffer.copyToChannel(take.samples, 0);
        return buffer;
    }

    function stopTakePreview() {
        if (previewing && engine.auditionSession === previewing) engine.stopAudition();
        previewing = null; $('recPreview').textContent = '▶ Preview';
    }
    engine.addEventListener('audition', event => { if (!event.detail && previewing && engine.auditionSession !== previewing) { previewing = null; $('recPreview').textContent = '▶ Preview'; } });

    async function preview() {
        if (previewing) { stopTakePreview(); return; }
        previewing = await engine.auditionBuffer(takeBuffer(), { deviceId: previewDevice() });
        previewing.owner = 'recorder-take';
        $('recPreview').textContent = '■ Stop preview';
    }

    const takeName = () => $('recName').value.trim() || $('recName').placeholder;

    async function saveAsPad() {
        const take = recorder.take;
        const result = await window.deck.saveRecording(takeName(), encodeWav(take.samples, take.sampleRate));
        acceptLibrary(result);
        toast(`“${takeName()}” is on your soundboard (${formatTime(take.seconds)}). Use Playback region to choose the part it plays.`);
        recorder.discard();
        dialog.close();
    }

    async function addToProject(mode) {
        const take = recorder.take;
        const asset = await studio.addGenerated(samplesToAsset(take.samples, take.sampleRate), { name: takeName(), origin: { kind: 'recording', label: take.processed ? 'Voice effect take' : 'Dry take' } }, mode);
        if (!asset) return;
        toast(`Added “${takeName()}” to the project.`);
        recorder.discard();
        dialog.close();
    }

    const wire = (id, action) => { $(id).onclick = () => run(action); };
    wire('recRecord', record);
    wire('recStop', () => (recorder.state === 'acquiring' ? (recorder.cancel(), sync()) : stop()));
    wire('recPreview', preview);
    wire('recDiscard', async () => { stopTakePreview(); recorder.discard(); $('recStatus').textContent = 'Take discarded.'; $('recTime').textContent = formatTime(0); });
    wire('recSave', saveAsPad);
    wire('recAppend', () => addToProject('append'));
    wire('recInsert', () => addToProject('insert'));
    $('closeRecord').onclick = () => dialog.close();
    dialog.addEventListener('close', () => {
        clearInterval(ticker); stopTakePreview();
        // Closing abandons the take in progress; it never stops the live microphone or replay.
        if (recorder.state !== 'idle') { recorder.cancel(); toast('Recording discarded.'); }
        recorder.discard();
    });

    return {
        open(where = 'board') {
            origin = where;
            clearError();
            $('recStatus').textContent = '';
            $('recName').value = '';
            $('recName').placeholder = `Recording ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
            fillDevices(); sync();
            dialog.showModal();
        },
        refreshDevices: () => { if (dialog.open && recorder.state === 'idle') fillDevices(); },
        recorder
    };
}
