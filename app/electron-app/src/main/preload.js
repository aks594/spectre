const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openBrain: () => ipcRenderer.invoke('open-brain'),
  closeBrain: () => ipcRenderer.invoke('close-brain'),
  toggleHud: () => ipcRenderer.invoke('toggle-hud'),
  scaleUp: () => ipcRenderer.invoke('scale-up'),
  scaleDown: () => ipcRenderer.invoke('scale-down'),
  moveLeft: () => ipcRenderer.invoke('move-left'),
  moveRight: () => ipcRenderer.invoke('move-right'),
  sendToBackend: (payload) => ipcRenderer.invoke('send-to-backend', payload),
  onTranscriptReceived: (payload) => ipcRenderer.invoke('on-transcript-received', payload),
  syncBrainPosition: () => ipcRenderer.invoke('sync-brain-position'),
});
