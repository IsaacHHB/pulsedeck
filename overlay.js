/* Overlay renderer: mirrors the main window's state and sends commands back. No audio runs here. */
const $ = id => document.getElementById(id);
let state = { clips: [], playing: [], muted: false, live: false, progress: {} };
const prettyKey = key => key ? key.replaceAll('Control', window.overlay.platform === 'darwin' ? 'Cmd' : 'Ctrl').replaceAll('Alt', window.overlay.platform === 'darwin' ? 'Option' : 'Alt') : '';
if (window.overlay.platform === 'darwin') for (const element of document.querySelectorAll('[title]')) {
    element.title = element.title.replaceAll('Ctrl', 'Cmd').replaceAll('Alt', 'Option');
}

function render() {
    const grid = $('grid');
    grid.replaceChildren();
    if (!state.clips.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.append('No sounds yet. ');
        const open = document.createElement('button'); open.textContent = 'Open PulseDeck'; open.onclick = () => window.overlay.focusMain();
        empty.append(open, ' to add some.');
        grid.append(empty);
    }
    for (const clip of state.clips) {
        const pad = document.createElement('button');
        pad.className = `pad ${clip.color}`;
        pad.dataset.id = clip.id;
        pad.title = clip.hotkey ? `${clip.name} · ${prettyKey(clip.hotkey)}` : clip.name;
        const name = document.createElement('span'); name.className = 'name'; name.textContent = clip.favorite ? `★ ${clip.name}` : clip.name;
        const key = document.createElement('span'); key.className = 'key'; key.textContent = clip.hotkey ? prettyKey(clip.hotkey) : (clip.loop ? 'Loop' : ' ');
        const progress = document.createElement('span'); progress.className = 'bar-progress';
        pad.append(name, key, progress);
        pad.onclick = () => window.overlay.play(clip.id);
        grid.append(pad);
    }
    update();
}

function update() {
    const playing = new Set(state.playing);
    for (const pad of document.querySelectorAll('.pad')) {
        const active = playing.has(pad.dataset.id);
        pad.classList.toggle('playing', active);
        pad.querySelector('.bar-progress').style.transform = `scaleX(${active ? state.progress?.[pad.dataset.id] ?? 0 : 0})`;
        const count = state.counts?.[pad.dataset.id] || 0;
        pad.dataset.count = count > 1 ? `×${count}` : '';
    }
    $('muteBtn').classList.toggle('muted', state.muted);
    $('muteBtn').textContent = state.muted ? 'Muted' : 'Mic';
    $('liveDot').classList.toggle('live', state.live);
    $('clipBtn').hidden = !state.replay;
    $('clipBtn').textContent = state.replay ? `● Clip ${state.replay}s` : '● Clip';
    $('status').textContent = state.live
        ? `Live${state.voice && state.voice !== 'Natural' ? ` · ${state.voice} voice` : ''}${playing.size ? ` · ${playing.size} playing` : ''}`
        : 'Offline · connect audio in PulseDeck';
}

window.overlay.onState(next => {
    const clipsChanged = JSON.stringify(next.clips) !== JSON.stringify(state.clips);
    state = { ...state, ...next };
    if (clipsChanged) render(); else update();
});
$('stopBtn').onclick = () => window.overlay.stopAll();
$('muteBtn').onclick = () => window.overlay.toggleMute();
$('hideBtn').onclick = () => window.overlay.hide();
$('clipBtn').onclick = () => { window.overlay.capture(); $('clipBtn').classList.add('saving'); setTimeout(() => $('clipBtn').classList.remove('saving'), 600); };
$('opacity').oninput = () => window.overlay.setOpacity(Number($('opacity').value) / 100);
document.addEventListener('keydown', event => { if (event.key === 'Escape') window.overlay.hide(); });

window.overlay.getState().then(saved => {
    if (saved) { state = { ...state, ...saved }; if (saved.opacity) $('opacity').value = Math.round(saved.opacity * 100); }
    render();
});
