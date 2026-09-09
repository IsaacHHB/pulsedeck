const { app, BrowserWindow, ipcMain, dialog, globalShortcut, shell, session, powerSaveBlocker, screen, desktopCapturer } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { Library } = require('./library.cjs');
const pkg = require('./package.json');
const RELEASES_URL = `${(pkg.repository?.url || 'https://github.com/IsaacHHB/pulsedeck').replace(/\.git$/, '')}/releases/latest`;

/**
 * Where sounds and settings live:
 *  - PULSEDECK_DATA env var (tests / power users)
 *  - "PulseDeck Data" next to the executable when that folder already exists or the folder is writable (portable zip)
 *  - otherwise %APPDATA%\PulseDeck\PulseDeck Data (installed builds; survives updates and uninstall/reinstall)
 */
function resolveDataRoot() {
    if (process.env.PULSEDECK_DATA) return process.env.PULSEDECK_DATA;
    if (!app.isPackaged) return path.join(__dirname, 'PulseDeck Data');
    const portable = path.join(path.dirname(app.getPath('exe')), 'PulseDeck Data');
    try {
        if (fs.existsSync(portable)) { fs.accessSync(portable, fs.constants.W_OK); return portable; }
        if (process.env.PORTABLE_EXECUTABLE_DIR) return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'PulseDeck Data');
    } catch { /* not writable: fall through */ }
    return path.join(app.getPath('appData'), 'PulseDeck', 'PulseDeck Data');
}
const dataRoot = resolveDataRoot();
fs.mkdirSync(dataRoot, { recursive: true });
app.setPath('userData', path.join(dataRoot, 'browser'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (process.env.PULSEDECK_TEST === '1') {
    app.commandLine.appendSwitch('use-fake-device-for-media-stream');
    app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}

const hidden = process.env.PULSEDECK_TEST === '1' || process.env.PULSEDECK_HEADLESS === '1';
let win, overlay, library, sleepBlocker, overlayState = null, overlayShown = false, quitting = false, overlaySaveTimer;
const appURL = pathToFileURL(path.join(__dirname, 'index.html')).href;
const overlayURL = pathToFileURL(path.join(__dirname, 'overlay.html')).href;
const isLocal = url => url === appURL || url === overlayURL;
const isMain = frame => frame?.url === appURL;

function hotkeys() {
    globalShortcut.unregisterAll();
    const failed = [];
    const register = (key, action) => {
        try { if (!globalShortcut.register(key, action)) failed.push(key); }
        catch { failed.push(key); }
    };
    const send = action => () => win?.webContents.send('shortcut', action);
    register('Control+Alt+Space', send({ type: 'stop' }));
    register('Control+Alt+M', send({ type: 'mute' }));
    register('Control+Alt+O', () => toggleOverlay());
    register('Control+Alt+R', send({ type: 'capture' }));
    for (const clip of library.state.clips) if (clip.hotkey) register(clip.hotkey, send({ type: 'play', id: clip.id }));
    return failed;
}

function handle(name, fn, { mainOnly = false } = {}) {
    ipcMain.handle(name, async (event, ...args) => {
        if (!isLocal(event.senderFrame.url)) throw new Error('Unauthorized request.');
        if (mainOnly && !isMain(event.senderFrame)) throw new Error('Unauthorized request.');
        return fn(...args);
    });
}

/* ─── Overlay: a small always-on-top deck for use over games ─── */
function overlayBounds() {
    const saved = library.state.settings.overlay;
    const display = screen.getPrimaryDisplay().workArea;
    const width = saved?.width || 380, height = saved?.height || 400;
    let x = saved?.x ?? display.x + display.width - width - 24;
    let y = saved?.y ?? display.y + display.height - height - 24;
    // Keep the overlay on a visible display even if monitors changed since it was saved.
    const onScreen = screen.getAllDisplays().some(d => x + 40 < d.bounds.x + d.bounds.width && x + width - 40 > d.bounds.x && y + 20 < d.bounds.y + d.bounds.height && y + 20 > d.bounds.y);
    if (!onScreen) { x = display.x + display.width - width - 24; y = display.y + display.height - height - 24; }
    return { x, y, width, height };
}

function saveOverlayBounds() {
    clearTimeout(overlaySaveTimer);
    overlaySaveTimer = setTimeout(() => {
        if (!overlay || overlay.isDestroyed()) return;
        const bounds = overlay.getBounds();
        library.updateSettings({ overlay: { ...bounds, opacity: overlay.getOpacity() } });
        library.commit().catch(() => {});
    }, 300);
}

function createOverlay() {
    overlay = new BrowserWindow({
        ...overlayBounds(),
        minWidth: 200, minHeight: 120,
        frame: false, transparent: false, backgroundColor: '#14171b',
        alwaysOnTop: true, skipTaskbar: true, resizable: true, minimizable: false, maximizable: false, fullscreenable: false,
        show: false, title: 'PulseDeck overlay', icon: path.join(__dirname, 'icon.ico'),
        webPreferences: { preload: path.join(__dirname, 'overlay-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
    });
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.setOpacity(library.state.settings.overlay?.opacity ?? 0.92);
    overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    overlay.webContents.on('will-navigate', event => event.preventDefault());
    overlay.on('move', saveOverlayBounds);
    overlay.on('resize', saveOverlayBounds);
    overlay.on('close', event => { if (!quitting) { event.preventDefault(); toggleOverlay(false); } });
    overlay.on('show', () => win?.webContents.send('overlay-visible', true));
    overlay.on('hide', () => { overlayShown = false; win?.webContents.send('overlay-visible', false); });
    overlay.loadURL(overlayURL);
}

function toggleOverlay(show) {
    if (!overlay || overlay.isDestroyed()) createOverlay();
    if (show === undefined) show = !overlayShown;
    overlayShown = show;
    if (show) {
        // Automated runs keep every window hidden; the state still flows so the UI can be checked.
        if (!hidden) { overlay.show(); overlay.setAlwaysOnTop(true, 'screen-saver'); }
        else win?.webContents.send('overlay-visible', true);
    } else {
        overlay.hide();
        if (hidden) win?.webContents.send('overlay-visible', false);
    }
    return show;
}

/* ─── Auto-updates (installed builds only; releases are published on GitHub) ─── */
let updater = null, updateState = { status: 'idle' };
function setUpdateState(next) {
    updateState = { ...updateState, ...next };
    win?.webContents.send('update', updateState);
}
function setupUpdater() {
    if (!app.isPackaged || process.env.PULSEDECK_NO_UPDATES === '1') return;
    try { ({ autoUpdater: updater } = require('electron-updater')); }
    catch { return; } // portable build without the updater module
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.on('checking-for-update', () => setUpdateState({ status: 'checking' }));
    updater.on('update-available', info => setUpdateState({ status: 'downloading', version: info.version }));
    updater.on('update-not-available', () => setUpdateState({ status: 'latest', checkedAt: Date.now() }));
    updater.on('download-progress', progress => setUpdateState({ status: 'downloading', percent: Math.round(progress.percent) }));
    updater.on('update-downloaded', info => setUpdateState({ status: 'ready', version: info.version, notes: typeof info.releaseNotes === 'string' ? info.releaseNotes.slice(0, 2000) : '' }));
    updater.on('error', error => setUpdateState({ status: 'error', message: String(error?.message || error).slice(0, 200) }));
    const check = () => updater.checkForUpdates().catch(() => {});
    setTimeout(check, 8000);                 // shortly after launch
    setInterval(check, 4 * 60 * 60 * 1000); // and every four hours while running
}

async function start() {
    library = new Library(dataRoot);
    await library.init();
    // Only the main window may use audio devices. Desktop (loopback) capture requests report a video type, so
    // "media" is allowed as a whole; no camera is ever requested by the app's own code.
    const permissionAllowed = permission => ['media', 'speaker-selection', 'display-capture'].includes(permission);
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(Boolean(contents && contents.getURL() === appURL && permissionAllowed(permission))));
    session.defaultSession.setPermissionCheckHandler((contents, permission) => Boolean(contents && contents.getURL() === appURL && permissionAllowed(permission)));
    // Fallback path for the replay buffer: getDisplayMedia with Windows system-audio loopback.
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
        if (request.frame?.url !== appURL) { callback({}); return; }
        desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
            .then(sources => callback(sources.length ? { video: sources[0], audio: 'loopback' } : {}))
            .catch(() => callback({}));
    }, { useSystemPicker: false });

    handle('library:get', () => ({ ...library.snapshot(), failedHotkeys: hotkeys() }), { mainOnly: true });
    handle('library:import', async () => {
        const result = await dialog.showOpenDialog(win, { title: 'Add sounds to PulseDeck', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'webm'] }] });
        if (result.canceled) return null;
        const state = await library.importFiles(result.filePaths);
        return { ...state, failedHotkeys: hotkeys() };
    }, { mainOnly: true });
    handle('library:drop', async paths => ({ ...await library.importFiles(paths), failedHotkeys: hotkeys() }), { mainOnly: true });
    handle('library:read', id => library.read(id), { mainOnly: true });
    handle('library:edit', async (id, patch) => ({ ...await library.edit(id, patch), failedHotkeys: hotkeys() }), { mainOnly: true });
    handle('library:reorder', async ids => ({ ...await library.reorder(ids), failedHotkeys: hotkeys() }), { mainOnly: true });
    handle('library:remove', async id => ({ ...await library.remove(id), failedHotkeys: hotkeys() }), { mainOnly: true });
    handle('capture:save', async (bytes, duration, name) => library.addCapture(bytes, duration, name), { mainOnly: true });
    handle('capture:read', id => library.readCapture(id), { mainOnly: true });
    handle('capture:rename', (id, name) => library.renameCapture(id, name), { mainOnly: true });
    handle('capture:remove', id => library.removeCapture(id), { mainOnly: true });
    handle('capture:import', async (name, bytes) => ({ ...await library.importBuffer(name, bytes, '.wav'), failedHotkeys: hotkeys() }), { mainOnly: true });
    handle('settings:save', async patch => { library.updateSettings(patch); await library.commit(); return library.snapshot(); }, { mainOnly: true });
    handle('guide:driver', () => shell.openExternal('https://vb-audio.com/Cable/'), { mainOnly: true });
    handle('data:open', () => shell.openPath(dataRoot), { mainOnly: true });
    handle('audio:active', active => {
        if (active && sleepBlocker === undefined) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
        if (!active && sleepBlocker !== undefined) { powerSaveBlocker.stop(sleepBlocker); sleepBlocker = undefined; }
    }, { mainOnly: true });

    // Overlay plumbing. The main window owns the audio engine; the overlay only sends commands and mirrors state.
    handle('overlay:toggle', show => toggleOverlay(show), { mainOnly: true });
    handle('overlay:visible', () => overlayShown, { mainOnly: true });
    handle('overlay:state', state => { overlayState = state; if (overlay && !overlay.isDestroyed()) overlay.webContents.send('state', state); }, { mainOnly: true });
    handle('overlay:get', () => overlayState);
    handle('overlay:play', id => { if (typeof id === 'string') win?.webContents.send('shortcut', { type: 'play', id }); });
    handle('overlay:stop', () => win?.webContents.send('shortcut', { type: 'stop' }));
    handle('overlay:mute', () => win?.webContents.send('shortcut', { type: 'mute' }));
    handle('overlay:capture', () => win?.webContents.send('shortcut', { type: 'capture' }));
    handle('overlay:hide', () => toggleOverlay(false));
    handle('overlay:opacity', value => {
        const opacity = Math.max(0.3, Math.min(1, Number(value) || 0.92));
        overlay?.setOpacity(opacity); saveOverlayBounds();
        return opacity;
    });
    handle('app:version', () => app.getVersion(), { mainOnly: true });
    handle('update:state', () => updateState, { mainOnly: true });
    handle('update:check', async () => { if (!updater) return updateState; await updater.checkForUpdates().catch(() => {}); return updateState; }, { mainOnly: true });
    handle('update:install', () => { if (updater && updateState.status === 'ready') { quitting = true; updater.quitAndInstall(false, true); } }, { mainOnly: true });
    handle('update:releases', () => shell.openExternal(RELEASES_URL), { mainOnly: true });
    handle('overlay:focusMain', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

    win = new BrowserWindow({
        width: 1280, height: 860, minWidth: 980, minHeight: 680, backgroundColor: '#0e1013', title: 'PulseDeck',
        icon: path.join(__dirname, 'icon.ico'), show: !hidden, autoHideMenuBar: true,
        webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    win.on('closed', () => { win = null; if (overlay && !overlay.isDestroyed()) overlay.destroy(); });
    await win.loadURL(appURL);
    setupUpdater();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
    app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
    app.whenReady().then(start).catch(error => { dialog.showErrorBox('PulseDeck could not start', error.message); app.quit(); });
    app.on('window-all-closed', () => app.quit());
    app.on('before-quit', () => { quitting = true; });
    app.on('will-quit', () => { globalShortcut.unregisterAll(); if (sleepBlocker !== undefined) powerSaveBlocker.stop(sleepBlocker); });
}
