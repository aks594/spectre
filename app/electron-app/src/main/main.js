const { app, BrowserWindow, ipcMain, screen, net, desktopCapturer } = require('electron');
const koffi = require('koffi');

// --- CRITICAL FIXES FOR TEAMS/SCREEN SHARE CRASH ---
// 1. Disable GPU to prevent DWM composition conflicts during screen share.
app.disableHardwareAcceleration();

// 2. Disable Native Window Occlusion.
// This prevents Windows from hiding the window because it thinks it's "invisible"
// to the capture engine, effectively making it invisible to YOU too.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// ---------------------------------------------------

if (require('electron-squirrel-startup')) {
  app.quit();
}

let hudWindow;
let brainWindow;
const HUD_BASE_WIDTH = 800;
// Give the HUD ample height so all rows and dropdowns fit without clipping.
const HUD_BASE_HEIGHT = 220;
const GAP_BETWEEN_WINDOWS = 3;
const ASK_WS_URL = 'ws://localhost:8000/ws/ask';
const VISION_WS_URL = 'ws://localhost:8000/ws/analyze';
const STT_WS_URL = process.env.INTERVIEWAI_STT_WS || 'ws://localhost:8000/ws/stt';
let hudScale = 1;
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
let isResizing = false;
let currentHudHeight = 150;
let brainIntendedState = false;

const sendToWindow = (targetWindow, channel, payload) => {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }
  targetWindow.webContents.send(channel, payload);
};

const capturePrimaryDisplayBase64 = async () => {
  const primary = screen.getPrimaryDisplay();
  const targetWidth = 1080;
  const targetHeight = Math.max(1, Math.round((primary.size.height / primary.size.width) * targetWidth));

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: targetWidth, height: targetHeight },
  });

  const matched = sources.find((source) => String(source.display_id) === String(primary.id)) || sources[0];
  if (!matched) {
    throw new Error('Unable to locate primary display.');
  }

  const { thumbnail } = matched;
  if (!thumbnail || thumbnail.isEmpty()) {
    throw new Error('Failed to capture screen thumbnail.');
  }

  const jpegBuffer = thumbnail.toJPEG(80);
  return jpegBuffer.toString('base64');
};

// --- GLOBAL NATIVE SETUP (Optimized) ---
let SetWindowDisplayAffinity = null;

try {
  const user32 = koffi.load('user32.dll');
  // 0x11 = WDA_EXCLUDEFROMCAPTURE
  SetWindowDisplayAffinity = user32.func('bool __stdcall SetWindowDisplayAffinity(intptr_t hWnd, uint32_t dwAffinity)');
} catch (e) {
  console.error('[FATAL] Failed to load user32.dll:', e);
}

const setWindowHiddenFromCapture = (browserWindow) => {
  if (!SetWindowDisplayAffinity || !browserWindow || browserWindow.isDestroyed()) return;

  try {
    const handle = browserWindow.getNativeWindowHandle();
    // Validate handle
    if (!handle || (Buffer.isBuffer(handle) && handle.length === 0)) return;

    // Robust pointer extraction for x64 vs x86
    let hWnd;
    if (Buffer.isBuffer(handle)) {
        hWnd = process.arch === 'x64' 
        ? handle.readBigInt64LE(0) 
        : handle.readInt32LE(0);
    } else {
        hWnd = handle;
    }

    const result = SetWindowDisplayAffinity(hWnd, 0x00000011);
    if (!result) {
      console.warn(`[STEALTH] Failed to set affinity for window ID ${browserWindow.id}`);
    }
  } catch (e) {
    console.error('[STEALTH] Critical error applying affinity:', e);
  }
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
  if (!hudWindow || hudWindow.isDestroyed()) {
    return;
  }
  if (!brainWindow || brainWindow.isDestroyed()) {
    return;
  }
  const hudBounds = hudWindow.getBounds();
  const brainBounds = brainWindow.getBounds();
  const brainY = Math.round(hudBounds.y + currentHudHeight + GAP_BETWEEN_WINDOWS);
  brainWindow.setBounds({
    x: hudBounds.x,
    y: brainY,
    width: hudBounds.width,
    height: brainBounds.height,
  });
};

const createHudWindow = () => {
  const { width: screenWidth } = screen.getPrimaryDisplay().workAreaSize;
  // Use the base height for full HUD visibility
  const height = HUD_BASE_HEIGHT;
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
    resizable: true,
    movable: true,
    skipTaskbar: true,
    hasShadow: false, // Turn off default shadow, we use CSS shadow
    webPreferences: {
      preload: HUD_WINDOW_PRELOAD_WEBPACK_ENTRY,
    },
  });

  hudWindow.setMenuBarVisibility(false);
  hudWindow.loadURL(HUD_WINDOW_WEBPACK_ENTRY);

  // --- CRITICAL FIX: Force Highest Z-Level ---
  // 'screen-saver' level sits above normal 'always-on-top' windows (like Teams borders)
  hudWindow.setAlwaysOnTop(true, 'screen-saver'); 
  hudWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  setWindowHiddenFromCapture(hudWindow);

  // --- MAGIC SAUCE: Click-through Transparency ---
  // This lets you click on the screen BEHIND the empty parts of the HUD
  hudWindow.webContents.on('did-finish-load', () => {
    hudWindow.setIgnoreMouseEvents(false);
  });

  // Listen for mouse events from Renderer to enable/disable clicking
  ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win.setIgnoreMouseEvents(ignore, options);
  });
  // -----------------------------------------------

  hudWindow.on('move', updateBrainPosition);
  hudWindow.on('resize', () => {
    if (!brainWindow || brainWindow.isDestroyed()) {
      return;
    }
    if (isResizing) {
      updateBrainPosition();
      return;
    }
    isResizing = true;
    try {
      const { width } = hudWindow.getBounds();
      const brainBounds = brainWindow.getBounds();
      brainWindow.setBounds({
        x: brainBounds.x,
        y: brainBounds.y,
        width,
        height: brainBounds.height,
      });
      updateBrainPosition();
    } finally {
      isResizing = false;
    }
  });
  hudWindow.on('closed', () => {
    hudWindow = null;
  });
};

// ADD THIS TO registerIpcHandlers():
ipcMain.handle('exit-app', () => {
  app.quit();
});

const createBrainWindow = () => {
  const { height } = screen.getPrimaryDisplay().workAreaSize;
  const brainWidth = Math.round(HUD_BASE_WIDTH * hudScale);
  const brainHeight = Math.floor(height * 0.5);

  brainWindow = new BrowserWindow({
    width: brainWidth,
    height: brainHeight,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    hasShadow: false,
    skipTaskbar: true,
    webPreferences: {
      preload: BRAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
    },
  });

  brainWindow.setMenuBarVisibility(false);
  // Update this line to include 'screen-saver'
  brainWindow.setAlwaysOnTop(true, 'screen-saver'); 
  brainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  brainWindow.loadURL(BRAIN_WINDOW_WEBPACK_ENTRY);

  // --- STEALTH FIX: Apply immediately and on every show event ---
  setWindowHiddenFromCapture(brainWindow);

  brainWindow.once('ready-to-show', () => {
    setWindowHiddenFromCapture(brainWindow);
  });

  brainWindow.on('show', () => {
    setWindowHiddenFromCapture(brainWindow);
  });
  // -------------------------------------------------------------

  brainWindow.on('closed', () => {
    brainWindow = null;
  });
  brainWindow.on('resize', () => {
    if (!hudWindow || hudWindow.isDestroyed()) {
      return;
    }
    if (isResizing) {
      updateBrainPosition();
      return;
    }
    isResizing = true;
    try {
      const { width } = brainWindow.getBounds();
      const hudBounds = hudWindow.getBounds();
      hudWindow.setBounds({
        x: hudBounds.x,
        y: hudBounds.y,
        width,
        height: hudBounds.height,
      });
      updateBrainPosition();
    } finally {
      isResizing = false;
    }
  });
  updateBrainPosition();
};

const ensureBrainWindowVisible = () => {
  if (!brainWindow || brainWindow.isDestroyed()) {
    createBrainWindow();
  }
  if (brainWindow) {
    setWindowHiddenFromCapture(brainWindow);
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
    console.log('[MAIN] WebSocket message interpreted:', interpreted);
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

const startVisionStream = (imageBase64, WebSocketImpl, sessionId) => {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(VISION_WS_URL);
    let finished = false;
    let summarySent = false;

    const complete = (status, error) => {
      if (finished) return;
      finished = true;
      sendToWindow(brainWindow, 'answer-complete', { status, error, sessionId });
      try {
        if (typeof socket.close === 'function') {
          socket.close();
        }
      } catch (closeError) {
        console.error('[VISION] close error', closeError);
      }
      if (status === 'done') {
        resolve();
      } else {
        reject(new Error(error || 'Vision stream failed'));
      }
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
        socket.send(JSON.stringify({ image_base64: imageBase64 }));
      } catch (error) {
        complete('error', error?.message || 'Failed to send image');
      }
    });

    wire('message', (eventOrData) => {
      const raw = typeof eventOrData === 'string'
        ? eventOrData
        : typeof eventOrData?.data !== 'undefined'
          ? eventOrData.data
          : Buffer.isBuffer(eventOrData)
            ? eventOrData.toString('utf8')
            : '';
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        parsed = { type: 'answer', chunk: raw };
      }
      const kind = parsed.type || parsed.channel || parsed.role || 'answer';
      const chunk = parsed.chunk || parsed.text || parsed.summary || parsed.answer || '';

      if (kind === 'error') {
        complete('error', parsed.error || chunk || 'Vision backend error');
        return;
      }
      if (kind === 'summary') {
        summarySent = true;
        sendToWindow(brainWindow, 'question-stream', { chunk, sessionId });
        sendToWindow(brainWindow, 'question-complete', { sessionId });
        return;
      }
      if (kind === 'answer') {
        sendToWindow(brainWindow, 'answer-stream', { chunk, sessionId });
        return;
      }
      if (kind === 'end') {
        complete('done');
        return;
      }

      // Fallback: if no kind recognized, treat as answer
      if (chunk) {
        sendToWindow(brainWindow, 'answer-stream', { chunk, sessionId });
      }
    });

    wire('error', (error) => {
      complete('error', error?.message || 'Vision connection error');
    });

    wire('close', () => {
      if (!finished) {
        complete('error', 'Vision connection closed unexpectedly');
      }
    });
  });
};

const registerIpcHandlers = () => {
  ipcMain.on('start-resize', () => {
    // Placeholder hook to align with renderer handshake; actual sizing is handled in perform-resize.
  });

  ipcMain.on('hud-height-change', (_event, height) => {
    const normalized = Number(height);
    if (!Number.isFinite(normalized) || normalized <= 0) {
      return;
    }
    currentHudHeight = normalized;
    updateBrainPosition();
  });

  ipcMain.handle('perform-resize', (event, payload = {}) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow || senderWindow.isDestroyed()) {
      return;
    }
    const direction = payload.direction === 'left' ? 'left' : 'right';
    const deltaX = Number(payload.deltaX) || 0;
    if (!deltaX) {
      return;
    }

    const bounds = senderWindow.getBounds();
    const minWidth = 320;

    let nextWidth = bounds.width;
    let nextX = bounds.x;

    if (direction === 'left') {
      nextWidth = Math.max(minWidth, bounds.width - deltaX);
      nextX = bounds.x + (bounds.width - nextWidth);
    } else {
      nextWidth = Math.max(minWidth, bounds.width + deltaX);
    }

    isResizing = true;
    try {
      senderWindow.setBounds({
        x: nextX,
        y: bounds.y,
        width: nextWidth,
        height: bounds.height,
      });
      updateBrainPosition();
    } finally {
      isResizing = false;
    }
  });

  ipcMain.on('brain-height-change', (_event, height) => {
    if (!brainWindow || brainWindow.isDestroyed()) return;
    const bounds = brainWindow.getBounds();
    // Only update if height is different to avoid loops
    if (bounds.height !== height) {
      brainWindow.setBounds({ 
        x: bounds.x, 
        y: bounds.y, 
        width: bounds.width, 
        height: height 
      });
    }
  });

  ipcMain.handle('open-brain', () => {
    if (!brainWindow) return;
    brainIntendedState = true;
    updateBrainPosition();
    brainWindow.show();
    brainWindow.focus();
  });

  ipcMain.handle('close-brain', () => {
    if (!brainWindow) return;
    brainIntendedState = false;
    brainWindow.hide();
  });

  ipcMain.handle('hide-brain-only', () => {
    if (!brainWindow) return;
    brainWindow.hide();
  });

  ipcMain.handle('show-brain-only', () => {
    if (!brainWindow || brainWindow.isDestroyed()) return;
    setWindowHiddenFromCapture(brainWindow);
    if (brainIntendedState) {
       brainWindow.show();
    }
  });

  ipcMain.handle('toggle-hud', () => {
    if (!hudWindow) return;
    if (hudWindow.isVisible()) {
      hudWindow.hide();
      if (brainWindow && !brainWindow.isDestroyed()) {
        brainWindow.hide();
      }
    } else {
      hudWindow.show();
      if (brainWindow && !brainWindow.isDestroyed()) {
        brainWindow.show();
      }
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

  ipcMain.handle('analyze-screen', async () => {
    const hudWasVisible = Boolean(hudWindow && !hudWindow.isDestroyed() && hudWindow.isVisible());
    const brainWasVisible = Boolean(brainWindow && !brainWindow.isDestroyed() && brainWindow.isVisible());
    const WebSocketImpl = resolveWebSocketImpl();
    if (!WebSocketImpl) {
      return { status: 'error', message: 'WebSocket support unavailable in Electron main process.' };
    }
    let sessionId = answerSessionId + 1;

    const restoreWindows = () => {
      if (hudWasVisible && hudWindow && !hudWindow.isDestroyed() && !hudWindow.isVisible()) {
        hudWindow.show();
      }
      if (brainWasVisible && brainWindow && !brainWindow.isDestroyed() && !brainWindow.isVisible()) {
        brainWindow.show();
      }
    };

    try {
      if (hudWindow && !hudWindow.isDestroyed()) {
        hudWindow.hide();
      }
      if (brainWindow && !brainWindow.isDestroyed()) {
        brainWindow.hide();
      }

      const imageBase64 = await capturePrimaryDisplayBase64();

      restoreWindows();

      brainIntendedState = true;
      ensureBrainWindowVisible();

      answerSessionId = sessionId;
      resetBrainStreams(sessionId, 'Screen analysis', 'Screen analysis');
      sendToWindow(brainWindow, 'answer-stream', { chunk: 'Analyzing screenshot...', sessionId });

      await startVisionStream(imageBase64, WebSocketImpl, sessionId);
      return { status: 'started', sessionId };
    } catch (error) {
      const message = error?.message || 'Failed to analyze screen.';
      sendToWindow(brainWindow, 'answer-stream', { chunk: message, sessionId });
      sendToWindow(brainWindow, 'answer-complete', { status: 'error', error: message, sessionId });
      return { status: 'error', message };
    } finally {
      restoreWindows();
    }
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

// --- Z-ORDER WATCHDOG ---
const startZOrderEnforcer = () => {
  setInterval(() => {
    // Force HUD to top
    if (hudWindow && !hudWindow.isDestroyed() && hudWindow.isVisible()) {
      hudWindow.setAlwaysOnTop(true, 'screen-saver');
      hudWindow.moveTop(); // Native OS call to bring to front
    }
    // Force Brain to top (if meant to be visible)
    if (brainWindow && !brainWindow.isDestroyed() && brainWindow.isVisible()) {
      brainWindow.setAlwaysOnTop(true, 'screen-saver');
      brainWindow.moveTop();
    }
  }, 2000); // Run every 2 seconds
};

const bootstrap = () => {
  createHudWindow();
  createBrainWindow();
  initBackendSession();
  registerIpcHandlers();
  connectSttStream();
  startZOrderEnforcer();

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

