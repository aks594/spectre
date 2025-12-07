const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel, callback) => {
  if (typeof callback !== 'function') {
    return () => {};
  }
  const handler = (_event, payload) => {
    callback(payload);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
};

contextBridge.exposeInMainWorld('electronAPI', {
  openBrain: () => ipcRenderer.invoke('open-brain'),
  closeBrain: () => ipcRenderer.invoke('close-brain'),
  toggleHud: () => ipcRenderer.invoke('toggle-hud'),
  scaleUp: () => ipcRenderer.invoke('scale-up'),
  scaleDown: () => ipcRenderer.invoke('scale-down'),
  moveLeft: () => ipcRenderer.invoke('move-left'),
  moveRight: () => ipcRenderer.invoke('move-right'),
  syncBrainPosition: () => ipcRenderer.invoke('sync-brain-position'),
  sendToBackend: (message) => ipcRenderer.invoke('send-to-backend', message),
  onTranscriptReceived: (callback) => subscribe('transcript', callback),
  onTranscriptUpdate: (callback) => subscribe('transcript-update', callback),
  onWsConnected: (callback) => subscribe('ws-connected', callback),
  onWsDisconnected: (callback) => subscribe('ws-disconnected', callback),
  toggleListening: (value) => ipcRenderer.invoke('toggle-listening', Boolean(value)),
  startAnswer: (payload) => ipcRenderer.invoke('start-answer', payload),
  requestSttStatus: () => ipcRenderer.invoke('stt-status-request'),
  onSttStatus: (callback) => subscribe('stt-status', callback),
  onQuestionStream: (callback) => subscribe('question-stream', callback),
  onQuestionComplete: (callback) => subscribe('question-complete', callback),
  onAnswerStream: (callback) => subscribe('answer-stream', callback),
  onAnswerComplete: (callback) => subscribe('answer-complete', callback),
  exitApp: () => ipcRenderer.invoke('exit-app'),
  setIgnoreMouseEvents: (ignore, options) => ipcRenderer.send('set-ignore-mouse-events', ignore, options),
});
