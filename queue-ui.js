import { PlaybackQueue } from './queue.js';
import { playedDuration } from './playback-region.js';

const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const time = seconds => seconds ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` : '—';

/** Queue panel on the board: add, reorder (drag or buttons), remove, clear, play/pause, next, stop. */
export function createQueueUI({ engine, getState, toast, reportError }) {
    const $ = id => document.getElementById(id);
    let saveTimer = 0, dragEntry = null;
    const queue = new PlaybackQueue({
        engine,
        getClip: id => getState().clips.find(c => c.id === id),
        save: entries => { clearTimeout(saveTimer); saveTimer = setTimeout(() => window.deck.saveQueue(entries).catch(reportError), 150); }
    });
    const run = async action => { try { await action(); } catch (error) { reportError(error); } };

    function render() {
        const list = $('queueList');
        list.replaceChildren();
        const clips = new Map(getState().clips.map(c => [c.id, c]));
        queue.entries.forEach((entry, index) => {
            const clip = clips.get(entry.clipId);
            const item = el('li', `queue-item${index === 0 && queue.state !== 'stopped' ? ` current ${queue.state}` : ''}${clip ? '' : ' missing'}`);
            item.dataset.id = entry.id; item.draggable = true;
            item.append(el('span', 'queue-index', index === 0 && queue.state === 'playing' ? '▶' : index === 0 && queue.state === 'paused' ? '❚❚' : String(index + 1)));
            item.append(el('span', 'queue-name', clip ? clip.name : 'Missing sound (deleted)'), el('span', 'queue-time', clip ? time(playedDuration(clip)) : ''));
            const up = el('button', 'text-button', '↑'), down = el('button', 'text-button', '↓'), remove = el('button', 'text-button danger', '×');
            up.title = 'Move up'; down.title = 'Move down'; remove.title = 'Remove from queue';
            up.setAttribute('aria-label', `Move ${clip?.name || 'sound'} up`); down.setAttribute('aria-label', `Move ${clip?.name || 'sound'} down`); remove.setAttribute('aria-label', `Remove ${clip?.name || 'sound'} from the queue`);
            up.disabled = index === 0 || (queue.state !== 'stopped' && index === 1); down.disabled = index === queue.entries.length - 1 || (queue.state !== 'stopped' && index === 0);
            up.onclick = () => run(() => queue.move(entry.id, index - 1));
            down.onclick = () => run(() => queue.move(entry.id, index + 1));
            remove.onclick = () => run(() => queue.remove(entry.id));
            item.append(up, down, remove);
            item.addEventListener('dragstart', event => { dragEntry = entry.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-pulsedeck-queue', entry.id); });
            item.addEventListener('dragover', event => { if (dragEntry && dragEntry !== entry.id) { event.preventDefault(); event.stopPropagation(); } });
            item.addEventListener('drop', event => { if (!dragEntry || dragEntry === entry.id) return; event.preventDefault(); event.stopPropagation(); const id = dragEntry; dragEntry = null; run(() => queue.move(id, index)); });
            item.addEventListener('dragend', () => { dragEntry = null; });
            list.append(item);
        });
        const count = queue.entries.length;
        $('queueTotal').textContent = count; $('queueCount').textContent = count;
        $('queueEmpty').hidden = count > 0;
        $('queuePlay').textContent = queue.state === 'playing' ? '❚❚ Pause' : queue.state === 'paused' ? '▶ Resume' : '▶ Play';
        $('queuePlay').disabled = !count;
        $('queueNext').disabled = !count;
        $('queueStop').disabled = queue.state === 'stopped';
        $('queueClear').disabled = !count;
        $('queueMessage').textContent = queue.message;
        $('queueMessage').hidden = !queue.message;
        $('queueBtn').classList.toggle('active-soft', queue.state === 'playing');
    }

    queue.addEventListener('change', render);
    engine.addEventListener('stopall', () => { if (queue.state !== 'stopped') queue.stop('Stopped by Stop all. The remaining sounds are still queued.'); });

    $('queuePlay').onclick = () => run(() => (queue.state === 'playing' ? queue.pause() : queue.play()));
    $('queueNext').onclick = () => run(() => queue.next());
    $('queueStop').onclick = () => run(() => queue.stop());
    $('queueClear').onclick = () => run(() => queue.clear());
    $('queueBtn').onclick = () => showPanel($('queuePanel').hidden);

    function showPanel(show) {
        $('queuePanel').hidden = !show;
        $('queueBtn').setAttribute('aria-pressed', String(show));
    }

    return {
        queue,
        load: entries => { queue.load(entries); render(); },
        add(clipIds) {
            const ids = Array.isArray(clipIds) ? clipIds : [clipIds];
            for (const id of ids) queue.add(id);
            showPanel(true); render();
            const first = getState().clips.find(c => c.id === ids[0]);
            toast(ids.length === 1 ? `Added “${first?.name || 'sound'}” to the queue.` : `Added ${ids.length} sounds to the queue.`);
        },
        render,
        showPanel
    };
}
