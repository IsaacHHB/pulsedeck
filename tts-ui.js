import { canonicalAsset } from './studio-audio.js';
import { formatTime } from './waveform.js';
import { isMac } from './platform.js';

const uuid = () => crypto.randomUUID();
const visible = text => text.replace(/\s/g, '').length;

/**
 * Text to speech panel. Speech comes from installed system voices as real audio: Preview plays it in
 * headphones, Speak now sends it through the soundboard bus (only while connected), and it can be saved
 * as a pad or inserted into a Studio project. Unsaved text is never persisted.
 */
export function createTtsUI({ engine, getState, saveSettings, previewDevice, toast, reportError, acceptLibrary, studio, connectAudio }) {
    const $ = id => document.getElementById(id);
    let info = null, voices = [], result = null, generating = null, generation = 0, speakToken = 0, speaking = null, previewing = null, status = 'idle';

    const settings = () => getState().settings;
    const request = () => ({ text: $('ttsText').value, voiceId: $('ttsVoice').value, speed: Number($('ttsSpeed').value) });
    const keyOf = r => JSON.stringify([r.text, r.voiceId, r.speed]);
    const voiceOf = id => voices.find(v => v.id === id);

    function setStatus(next, message = '') {
        status = next;
        const labels = { idle: 'Type text, choose a voice, then preview or speak.', generating: 'Generating speech…', ready: result ? `Ready · ${formatTime(result.duration)}` : 'Ready', speaking: 'Speaking through your broadcast…', previewing: 'Previewing in your headphones…', cancelled: 'Stopped.', error: 'Something went wrong.' };
        $('ttsStatus').textContent = message || labels[next];
        $('ttsStatus').dataset.state = next;
        sync();
    }

    function sync() {
        const r = request(), count = visible(r.text), busy = Boolean(generating);
        $('ttsCount').textContent = `${count} / 2000`;
        $('ttsCount').classList.toggle('over', count > 2000);
        const usable = info?.available && voices.some(v => v.id === r.voiceId && v.available) && count > 0 && count <= 2000;
        for (const id of ['ttsPreview', 'ttsSpeak', 'ttsSave', 'ttsInsert']) $(id).disabled = !usable || busy;
        $('ttsStop').disabled = !busy && !speaking && !previewing;
        $('ttsSpeedValue').textContent = r.speed === 0 ? 'Normal' : r.speed < 0 ? `Slower (${r.speed})` : `Faster (+${r.speed})`;
        $('ttsVolumeValue').textContent = `${$('ttsVolume').value}%`;
        for (const button of document.querySelectorAll('[data-tts-speed]')) button.classList.toggle('active', Number(button.dataset.ttsSpeed) === r.speed);
        languageNote();
    }

    /** Honest language guidance: voices read text in their own language. */
    function languageNote() {
        const voice = voiceOf($('ttsVoice').value), text = $('ttsText').value;
        let note = '';
        if (voice && /^en/i.test(voice.language) && /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(text)) {
            note = `“${voice.name}” is a ${voice.language} voice. Text in other scripts may be skipped or read incorrectly; choose a voice for that language if one is installed.`;
        }
        $('ttsLanguageNote').textContent = note;
        $('ttsLanguageNote').hidden = !note;
    }

    /** Any edit invalidates the previous result for later actions. */
    function edited() {
        if (result && result.key !== keyOf(request())) result = null;
        if (status === 'ready' && !result) setStatus('idle'); else sync();
    }

    async function loadVoices(refresh = false) {
        info = await window.deck.ttsInfo();
        $('ttsProvider').textContent = info.available ? `${info.label}. These are the voices installed on this computer, not cloud voices.` : info.label;
        voices = info.available ? await window.deck.ttsVoices(refresh) : [];
        const select = $('ttsVoice'), saved = settings().ttsVoice;
        select.replaceChildren();
        for (const voice of voices) {
            const option = new Option(`${voice.name} — ${voice.language || 'unknown language'}${voice.available ? '' : ' (turned off)'}`, voice.id);
            option.disabled = !voice.available;
            select.add(option);
        }
        const fallback = voices.find(v => v.available && /^en/i.test(v.language)) || voices.find(v => v.available);
        if (saved && voices.some(v => v.id === saved && v.available)) select.value = saved;
        else if (fallback) select.value = fallback.id;
        if (saved && !voices.some(v => v.id === saved && v.available)) setStatus('error', `Your saved voice “${saved}” is not available anymore. Choose another voice.`);
        else if (!info.available) setStatus('error', info.label);
        else if (!voices.some(v => v.available)) setStatus('error', isMac ? 'No voices are installed. Add one in System Settings → Accessibility → Spoken Content → System voice → Manage Voices.' : 'No voices are installed. Add one in Windows Settings → Time & language → Speech → Add voices.');
        else setStatus('idle');
    }

    /** Synthesizes (or reuses the current result). Only one generation runs at a time. */
    async function ensureResult() {
        const r = request();
        if (result && result.key === keyOf(r)) return result;
        if (generating) { window.deck.ttsCancel(generating.requestId).catch(() => {}); }
        const token = ++generation, requestId = uuid();
        generating = { requestId, token };
        setStatus('generating');
        try {
            const reply = await window.deck.ttsSynthesize({ requestId, text: r.text, voiceId: r.voiceId, speed: r.speed });
            if (token !== generation) throw Object.assign(new Error('Speech generation was cancelled.'), { code: 'CANCELLED' });
            await engine.init();
            let buffer;
            try { buffer = await engine.context.decodeAudioData(new Uint8Array(reply.bytes).buffer); }
            catch { throw new Error('The voice produced audio that could not be decoded. Try another voice.'); }
            if (token !== generation) throw Object.assign(new Error('Speech generation was cancelled.'), { code: 'CANCELLED' });
            result = { key: keyOf(r), resultId: reply.resultId, buffer, duration: buffer.duration, voice: reply.voice, provider: reply.provider, text: r.text, cached: reply.cached };
            settings().ttsVoice = r.voiceId; settings().ttsSpeed = r.speed; saveSettings();
            setStatus('ready');
            return result;
        } catch (error) {
            if (error.code === 'CANCELLED' || /cancelled/i.test(error.message)) { if (token === generation) setStatus('cancelled'); throw Object.assign(error, { code: 'CANCELLED' }); }
            if (token === generation) setStatus('error', error.message);
            throw error;
        } finally {
            if (generating?.token === token) generating = null;
            sync();
        }
    }

    const gain = () => Number($('ttsVolume').value) / 100;

    async function preview() {
        const device = previewDevice();
        const r = await ensureResult();
        if (speaking) return;
        previewing = await engine.auditionBuffer(r.buffer, { deviceId: device, gain: gain() });
        previewing.owner = 'tts';
        setStatus('previewing');
    }

    async function speakNow() {
        if (!engine.connected) {
            throw Object.assign(new Error('Connect audio to speak through your broadcast. Your text is kept; speech never plays through your speakers.'), { action: { label: 'Connect audio', run: connectAudio } });
        }
        const token = ++speakToken;
        const r = await ensureResult();
        if (token !== speakToken) return;          // Stop or Stop all came first
        if (!engine.connected) throw Object.assign(new Error('The broadcast disconnected while the speech was generating. Connect audio and try again.'), { action: { label: 'Connect audio', run: connectAudio } });
        engine.stop('tts', 'restart');
        const handle = await engine.playBuffer(r.buffer, { id: 'tts', name: 'Speech', volume: Number($('ttsVolume').value) });
        speaking = handle;
        setStatus('speaking');
        handle.done.then(() => { if (speaking === handle) { speaking = null; setStatus(result ? 'ready' : 'idle'); } });
    }

    /** Stop cancels generation, pending auto-play, speech, and preview. */
    function stop(message) {
        speakToken++;
        if (generating) { const id = generating.requestId; generation++; generating = null; window.deck.ttsCancel(id).catch(() => {}); }
        if (speaking) { engine.stop('tts', 'stop'); speaking = null; }
        if (previewing && engine.auditionSession === previewing) engine.stopAudition();
        previewing = null;
        setStatus('cancelled', message);
    }

    const phraseName = () => $('ttsName').value.trim() || $('ttsText').value.trim().replace(/\s+/g, ' ').slice(0, 40) || 'Speech';

    async function saveAsSound() {
        const r = await ensureResult();
        const library = await window.deck.ttsSave(r.resultId, phraseName(), Number($('ttsVolume').value));
        acceptLibrary(library);
        toast(`“${phraseName()}” is on your soundboard (${formatTime(r.duration)}). It plays its saved audio even if the voice is removed later.`);
    }

    async function insertInStudio() {
        const r = await ensureResult();
        const asset = await studio.addGenerated(canonicalAsset(r.buffer), { name: phraseName(), origin: { kind: 'tts', label: `${r.voice.name} (${r.voice.language})` } }, 'insert');
        if (asset) toast(`Inserted “${phraseName()}” at the Studio playhead.`);
    }

    engine.addEventListener('audition', event => { if (!event.detail && previewing && engine.auditionSession !== previewing) { previewing = null; if (status === 'previewing') setStatus(result ? 'ready' : 'idle'); } });
    engine.addEventListener('stopall', () => { if (generating || speaking || previewing || status === 'generating') stop('Stopped by Stop all.'); else speakToken++; });

    const wire = (id, action) => { $(id).onclick = async () => { try { await action(); } catch (error) { if (error.code !== 'CANCELLED') reportError(error); } }; };
    wire('ttsPreview', preview);
    wire('ttsSpeak', speakNow);
    wire('ttsSave', saveAsSound);
    wire('ttsInsert', insertInStudio);
    wire('ttsRefresh', () => loadVoices(true));
    $('ttsStop').onclick = () => stop();
    $('ttsText').addEventListener('input', edited);
    $('ttsVoice').addEventListener('change', edited);
    $('ttsSpeed').addEventListener('input', edited);
    $('ttsSpeed').addEventListener('change', () => { settings().ttsSpeed = Number($('ttsSpeed').value); saveSettings(); });
    $('ttsVolume').addEventListener('input', () => { settings().ttsVolume = Number($('ttsVolume').value); sync(); saveSettings(); });
    for (const button of document.querySelectorAll('[data-tts-speed]')) button.onclick = () => { $('ttsSpeed').value = button.dataset.ttsSpeed; edited(); settings().ttsSpeed = Number(button.dataset.ttsSpeed); saveSettings(); };

    return {
        async init() {
            $('ttsSpeed').value = String(settings().ttsSpeed ?? 0);
            $('ttsVolume').value = String(settings().ttsVolume ?? 100);
            try { await loadVoices(); } catch (error) { setStatus('error', `Voices could not be listed: ${error.message}`); }
        },
        stop,
        get status() { return status; },
        get result() { return result; }
    };
}
