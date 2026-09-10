const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('overlay', {
    platform: process.platform,
    getState: () => ipcRenderer.invoke('overlay:get'),
    onState: callback => ipcRenderer.on('state', (_event, state) => callback(state)),
    play: id => ipcRenderer.invoke('overlay:play', id),
    stopAll: () => ipcRenderer.invoke('overlay:stop'),
    toggleMute: () => ipcRenderer.invoke('overlay:mute'),
    capture: () => ipcRenderer.invoke('overlay:capture'),
    hide: () => ipcRenderer.invoke('overlay:hide'),
    setOpacity: value => ipcRenderer.invoke('overlay:opacity', value),
    focusMain: () => ipcRenderer.invoke('overlay:focusMain')
});
