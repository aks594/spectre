const { app, BrowserWindow, ipcMain, screen, net } = require('electron');

if (require('electron-squirrel-startup')) {
  app.quit();
}

let hudWindow;
let brainWindow;
const HUD_BASE_WIDTH = 650;
const HUD_BASE_HEIGHT = 65;
const BRAIN_GAP = 4;
const ASK_WS_URL = 'ws://localhost:8000/ws/ask';
const STT_WS_URL = process.env.INTERVIEWAI_STT_WS || 'ws://localhost:8000/ws/stt';
let hudScale = 1;
let hudSyncTimer;
let hudListeningState = true;
let answerInProgress = false;
let activeAnswerSocket = null;
let answerSessionId = 0;
let sttSocket = null;
let sttReconnectTimer = null;
let sttKeepaliveTimer = null;
let currentSttState = 'disconnected';
let sttSequence = 0;
let CachedWebSocketImpl;

const sendToWindow = (targetWindow, channel, payload) => {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }
  targetWindow.webContents.send(channel, payload);
};

const resolveWebSocketImpl = () => {
  if (CachedWebSocketImpl) {
    return CachedWebSocketImpl;
  }
  if (typeof globalThis.WebSocket === 'function') {
    CachedWebSocketImpl = globalThis.WebSocket;
    return CachedWebSocketImpl;
  }
  try {
    // eslint-disable-next-line global-require
    CachedWebSocketImpl = require('ws');
  } catch (error) {
    CachedWebSocketImpl = null;
  }
  return CachedWebSocketImpl;
};

const notifySttStatus = (state) => {
  currentSttState = state;
  sendToWindow(hudWindow, 'stt-status', { state });
};

const forwardSttChunk = (text) => {
  if (!text || !hudWindow || hudWindow.isDestroyed()) {
    return;
  }
  sttSequence += 1;
  try {
    hudWindow.webContents.send('transcript-update', text);
  } catch (error) {
    console.error('[STT] Failed to forward chunk', error);
  }
};

const stopSttKeepalive = () => {
  if (sttKeepaliveTimer) {
    clearInterval(sttKeepaliveTimer);
    sttKeepaliveTimer = null;
  }
};

const cleanupSttSocket = () => {
  stopSttKeepalive();
  if (sttSocket && typeof sttSocket.close === 'function') {
    try {
      sttSocket.close();
    } catch (error) {
      console.error('[STT] Failed to close socket', error);
    }
  }
  sttSocket = null;
};

const scheduleSttReconnect = () => {
  clearTimeout(sttReconnectTimer);
  sttReconnectTimer = setTimeout(() => {
    connectSttStream();
  }, 1800);
};

const connectSttStream = () => {
  const WebSocketImpl = resolveWebSocketImpl();
  if (!WebSocketImpl) {
    notifySttStatus('error');
    return;
  }

  cleanupSttSocket();
  notifySttStatus('connecting');
  sttSequence = 0;

  const socket = new WebSocketImpl(STT_WS_URL);
  sttSocket = socket;

  const startKeepalive = () => {
    stopSttKeepalive();
    sttKeepaliveTimer = setInterval(() => {
      try {
        socket.send('ping');
      } catch (error) {
        stopSttKeepalive();
      }
    }, 25000);
  };

  const wire = (eventName, handler) => {
    if (typeof socket.on === 'function') {
      socket.on(eventName, handler);
    } else if (typeof socket.addEventListener === 'function') {
      socket.addEventListener(eventName, handler);
    } else {
      socket[`on${eventName}`] = handler;
    }
  };

  const handleFailure = (state) => {
    if (sttSocket === socket) {
      sttSocket = null;
    }
    stopSttKeepalive();
    notifySttStatus(state);
    scheduleSttReconnect();
  };

  wire('open', () => {
    notifySttStatus('connected');
    startKeepalive();
  });

  wire('message', (eventOrData) => {
    const raw = typeof eventOrData === 'string'
      ? eventOrData
      : typeof eventOrData?.data !== 'undefined'
        ? eventOrData.data
        : Buffer.isBuffer(eventOrData)
          ? eventOrData.toString('utf8')
          : '';

    let text = '';
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        text = typeof parsed?.text === 'string' ? parsed.text : '';
      } catch (error) {
        text = raw.trim();
      }
    }

    if (!text) {
      return;
    }
    forwardSttChunk(text);
  });

  wire('close', () => handleFailure('disconnected'));
  wire('error', () => handleFailure('error'));
};

const updateBrainPosition = () => {
  if (!hudWindow || !brainWindow) return;
  const [hudX, hudY] = hudWindow.getPosition();
  const VISUAL_OFFSET = 70; // 60px visible pill + 10px gap
  brainWindow.setPosition(Math.round(hudX), Math.round(hudY + VISUAL_OFFSET));
};

const scheduleBrainPositionUpdate = () => {
  if (!hudWindow || !brainWindow) return;
  clearTimeout(hudSyncTimer);
  hudSyncTimer = setTimeout(updateBrainPosition, 30);
};

// const createHudWindow = () => {
//   const { width: screenWidth } = screen.getPrimaryDisplay().workAreaSize;
//   const targetWidth = Math.round(HUD_BASE_WIDTH * hudScale);
//   const x = Math.max(0, Math.floor((screenWidth - targetWidth) / 2));

//   hudWindow = new BrowserWindow({
//     width: targetWidth,
//     height: Math.round(HUD_BASE_HEIGHT * hudScale),
//     x,
//     y: 20,
//     frame: false,
//     transparent: true,
//     alwaysOnTop: true,
//     resizable: false,
//     skipTaskbar: true,
//     webPreferences: {
//       preload: HUD_WINDOW_PRELOAD_WEBPACK_ENTRY,
//     },
//   });

//   hudWindow.setMenuBarVisibility(false);
//   hudWindow.loadURL(HUD_WINDOW_WEBPACK_ENTRY);
//   hudWindow.on('move', scheduleBrainPositionUpdate);
//   hudWindow.on('resize', scheduleBrainPositionUpdate);
//   hudWindow.on('closed', () => {
//     hudWindow = null;
//   });
// };

const createHudWindow = () => {
  const { width: screenWidth } = screen.getPrimaryDisplay().workAreaSize;
  // Make height LARGE (400px) so menus can drop down without clipping
  const height = 400; 
  const targetWidth = Math.round(HUD_BASE_WIDTH * hudScale);
  const x = Math.max(0, Math.floor((screenWidth - targetWidth) / 2));

  hudWindow = new BrowserWindow({
    width: targetWidth,
    height: height, // Changed from 65 to 400
    x,
    y: 20,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false, // Turn off default shadow, we use CSS shadow
    webPreferences: {
      preload: HUD_WINDOW_PRELOAD_WEBPACK_ENTRY,
    },
  });

  hudWindow.setMenuBarVisibility(false);
  hudWindow.loadURL(HUD_WINDOW_WEBPACK_ENTRY);

  // --- MAGIC SAUCE: Click-through Transparency ---
  // This lets you click on the screen BEHIND the empty parts of the HUD
  hudWindow.webContents.on('did-finish-load', () => {
    hudWindow.setIgnoreMouseEvents(true, { forward: true });
  });

  // Listen for mouse events from Renderer to enable/disable clicking
  ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win.setIgnoreMouseEvents(ignore, options);
  });
  // -----------------------------------------------

  hudWindow.on('move', scheduleBrainPositionUpdate);
  hudWindow.on('resize', scheduleBrainPositionUpdate);
  hudWindow.on('closed', () => {
    hudWindow = null;
  });
};

// ADD THIS TO registerIpcHandlers():
ipcMain.handle('exit-app', () => {
  app.quit();
});

const createBrainWindow = () => {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const brainWidth = Math.floor(width * 0.7);
  const brainHeight = Math.floor(height * 0.7);

  brainWindow = new BrowserWindow({
    width: brainWidth,
    height: brainHeight,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: '#1a1a1aE6',
    resizable: true,
    webPreferences: {
      preload: BRAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
    },
  });

  brainWindow.setMenuBarVisibility(false);
  brainWindow.loadURL(BRAIN_WINDOW_WEBPACK_ENTRY);
  brainWindow.on('closed', () => {
    brainWindow = null;
  });
  updateBrainPosition();
};

const ensureBrainWindowVisible = () => {
  if (!brainWindow || brainWindow.isDestroyed()) {
    createBrainWindow();
  }
  if (brainWindow) {
    brainWindow.show();
    brainWindow.focus();
  }
};

const applyHudScale = () => {
  if (!hudWindow) return;
  const width = Math.round(HUD_BASE_WIDTH * hudScale);
  const height = Math.round(HUD_BASE_HEIGHT * hudScale);
  const [x, y] = hudWindow.getPosition();
  hudWindow.setBounds({ x, y, width, height });
  updateBrainPosition();
};

const moveHud = (deltaX) => {
  if (!hudWindow) return;
  const [currentX, currentY] = hudWindow.getPosition();
  hudWindow.setPosition(currentX + deltaX, currentY);
  updateBrainPosition();
};

const resetBrainStreams = (sessionId, transcript, cleanedQuestion) => {
  sendToWindow(brainWindow, 'question-stream', {
    reset: true,
    sessionId,
    transcript,
    cleanedQuestion,
  });
  sendToWindow(brainWindow, 'question-complete', {
    reset: true,
    sessionId,
  });
};

const interpretAskMessage = (raw) => {
  if (raw == null) {
    return { type: 'noop' };
  }
  const text = typeof raw === 'string'
    ? raw
    : raw?.toString?.('utf8') ?? '';
  if (!text) {
    return { type: 'noop' };
  }
  if (text === '[END]') {
    return { type: 'end' };
  }
  if (text.startsWith('[ERROR]')) {
    return { type: 'error', error: text.replace('[ERROR]', '').trim() };
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const channel = parsed.type || parsed.channel || parsed.role || parsed.kind;
      const chunk = parsed.chunk || parsed.text || parsed.summary || parsed.answer || parsed.data || '';
      if (channel === 'summary' || channel === 'question') {
        return { type: 'summary', chunk };
      }
      if (channel === 'summary_done' || channel === 'question_done' || channel === 'question_complete') {
        return { type: 'summary_done' };
      }
      if (channel === 'answer' || channel === 'response') {
        return { type: 'answer', chunk };
      }
      if (channel === 'end' || channel === 'complete' || parsed.status === 'done') {
        return { type: 'end' };
      }
      if (channel === 'error' || parsed.error) {
        return { type: 'error', error: parsed.error || chunk || 'Backend error' };
      }
      if (chunk) {
        return { type: 'answer', chunk };
      }
    }
  } catch (error) {
    // Non-JSON payloads fall through to heuristic handling
  }
  if (text.trim().endsWith('?')) {
    return { type: 'summary', chunk: text };
  }
  return { type: 'answer', chunk: text };
};

const finalizeAnswerSession = (status, error, sessionId) => {
  if (sessionId !== answerSessionId) {
    return;
  }
  if (activeAnswerSocket) {
    try {
      if (typeof activeAnswerSocket.close === 'function') {
        activeAnswerSocket.close();
      }
    } catch (closeError) {
      console.error('[ASK] Failed closing socket', closeError);
    }
    activeAnswerSocket = null;
  }
  answerInProgress = false;
  hudListeningState = true;
  sendToWindow(brainWindow, 'answer-complete', { status, error, sessionId });
  sendToWindow(hudWindow, 'answer-complete', { status, error, sessionId });
};

const startAnswerStream = ({ transcript, cleanedQuestion, metadata }, WebSocketImpl) => {
  answerInProgress = true;
  hudListeningState = false;
  answerSessionId += 1;
  const sessionId = answerSessionId;

  ensureBrainWindowVisible();
  resetBrainStreams(sessionId, transcript, cleanedQuestion);

  const socket = new WebSocketImpl(ASK_WS_URL);
  activeAnswerSocket = socket;
  let sessionFinished = false;

  const complete = (status, error) => {
    if (sessionFinished) return;
    sessionFinished = true;
    finalizeAnswerSession(status, error, sessionId);
  };

  const wire = (eventName, handler) => {
    if (typeof socket.on === 'function') {
      socket.on(eventName, handler);
    } else if (typeof socket.addEventListener === 'function') {
      socket.addEventListener(eventName, handler);
    } else {
      socket[`on${eventName}`] = handler;
    }
  };

  wire('open', () => {
    try {
      const metadataPayload = metadata && typeof metadata === 'object' ? { ...metadata } : {};
      if (!metadataPayload.timestamp) {
        metadataPayload.timestamp = Date.now();
      }
      socket.send(JSON.stringify({
        question_raw: transcript,
        question_clean: cleanedQuestion || transcript,
        metadata: metadataPayload,
      }));
    } catch (error) {
      complete('error', error?.message || 'Failed sending transcript');
    }
  });

  wire('message', (eventOrData) => {
    const data = typeof eventOrData === 'string'
      ? eventOrData
      : typeof eventOrData?.data !== 'undefined'
        ? eventOrData.data
        : Buffer.isBuffer(eventOrData)
          ? eventOrData.toString('utf8')
          : '';
    const interpreted = interpretAskMessage(data);
    if (interpreted.type === 'summary' && interpreted.chunk) {
      sendToWindow(brainWindow, 'question-stream', { chunk: interpreted.chunk, sessionId });
      return;
    }
    if (interpreted.type === 'summary_done') {
      sendToWindow(brainWindow, 'question-complete', { sessionId });
      return;
    }
    if (interpreted.type === 'answer' && interpreted.chunk) {
      sendToWindow(brainWindow, 'answer-stream', { chunk: interpreted.chunk, sessionId });
      return;
    }
    if (interpreted.type === 'end') {
      complete('done');
      return;
    }
    if (interpreted.type === 'error') {
      complete('error', interpreted.error || 'Backend error');
    }
  });

  wire('error', (error) => {
    complete('error', error?.message || 'Connection error');
  });

  wire('close', () => {
    if (!sessionFinished) {
      complete('error', 'Connection closed unexpectedly');
    }
  });

  return sessionId;
};

const registerIpcHandlers = () => {
  ipcMain.handle('open-brain', () => {
    if (!brainWindow) return;
    updateBrainPosition();
    brainWindow.show();
    brainWindow.focus();
  });

  ipcMain.handle('close-brain', () => {
    if (!brainWindow) return;
    brainWindow.hide();
  });

  ipcMain.handle('toggle-hud', () => {
    if (!hudWindow) return;
    if (hudWindow.isVisible()) {
      hudWindow.hide();
    } else {
      hudWindow.show();
    }
  });

  ipcMain.handle('scale-up', () => {
    hudScale = Math.min(2, hudScale + 0.1);
    applyHudScale();
  });

  ipcMain.handle('scale-down', () => {
    hudScale = Math.max(0.5, hudScale - 0.1);
    applyHudScale();
  });

  ipcMain.handle('move-left', () => moveHud(-20));
  ipcMain.handle('move-right', () => moveHud(20));
  ipcMain.handle('sync-brain-position', () => updateBrainPosition());

  ipcMain.handle('send-to-backend', (_event, payload) => {
    console.log('[IPC] send-to-backend placeholder', payload);
  });

  ipcMain.handle('on-transcript-received', (_event, payload) => {
    console.log('[IPC] on-transcript-received placeholder', payload);
  });

  ipcMain.handle('stt-status-request', () => currentSttState);

  ipcMain.handle('toggle-listening', (_event, value) => {
    hudListeningState = Boolean(value);
    console.log('[IPC] HUD listening set to', hudListeningState);
    return hudListeningState;
  });

  ipcMain.handle('start-answer', async (_event, payload = {}) => {
    const transcript = (payload?.transcript || '').trim();
    const cleanedQuestion = (payload?.cleanedQuestion || '').trim();
      const metadata = payload && typeof payload.metadata === 'object' && payload.metadata !== null
      ? { ...payload.metadata }
      : {};
    if (!metadata.session_id) {
      metadata.session_id = `session-${Date.now()}`;
    }
    if (!metadata.timestamp) {
      metadata.timestamp = Date.now();
    }
    if (!transcript) {
      return { status: 'empty', message: 'Transcript is empty.' };
    }
    if (!cleanedQuestion) {
      return { status: 'invalid-question', message: 'Unable to detect interviewer question.' };
    }
    if (cleanedQuestion.length < 5) {
      return { status: 'invalid-question', message: 'Interviewer question is too short.' };
    }
    if (answerInProgress) {
      return { status: 'busy', message: 'Answer already in progress.' };
    }
    const WebSocketImpl = resolveWebSocketImpl();
    if (!WebSocketImpl) {
      return { status: 'error', message: 'WebSocket support unavailable in Electron main process.' };
    }
    try {
      const sessionId = startAnswerStream({ transcript, cleanedQuestion, metadata }, WebSocketImpl);
      return { status: 'started', sessionId };
    } catch (error) {
      console.error('[ASK] Failed to start answer stream', error);
      answerInProgress = false;
      activeAnswerSocket = null;
      return { status: 'error', message: error?.message || 'Unable to reach backend.' };
    }
  });
};

const initBackendSession = () => {
  try {
    const request = net.request({
      method: 'POST',
      url: 'http://localhost:8000/session/init',
    });
    request.setHeader('Content-Type', 'application/json');
    request.on('response', (response) => {
      if (response.statusCode >= 400) {
        console.error('[SESSION] init responded with', response.statusCode);
      }
    });
    request.on('error', (error) => {
      console.error('[SESSION] init failed', error.message || error);
    });
    const payload = {
      resume_text: 'Auto',
      jd_text: 'Auto',
      company: 'General',
      role: 'General',
      extra_instructions: '',
    };
    request.end(JSON.stringify(payload));
  } catch (error) {
    console.error('[SESSION] init threw', error.message || error);
  }
};

const bootstrap = () => {
  createHudWindow();
  createBrainWindow();
  initBackendSession();
  registerIpcHandlers();
  connectSttStream();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createHudWindow();
      createBrainWindow();
    }
  });
};

app.whenReady().then(bootstrap);

app.on('before-quit', () => {
  clearTimeout(sttReconnectTimer);
  cleanupSttSocket();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
