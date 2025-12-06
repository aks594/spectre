const TRANSCRIPT_MAX_LENGTH = 700;
const FILLER_PHRASES = ['uh', 'um', 'you know', 'like', 'i mean', 'okay so'];
const QUESTION_HINTS = [
  'what',
  'how',
  'why',
  'when',
  'where',
  'which',
  'who',
  'can you',
  'could you',
  'would you',
  'do you',
  'have you',
  'tell me',
  'describe',
  'is there',
];
const FILLER_REGEX = new RegExp(
  `\\b(?:${FILLER_PHRASES.map((phrase) => phrase.replace(/\s+/g, '\\s+')).join('|')})\\b`,
  'gi'
);

let hudStylesPromise;
let brainStylesPromise;

const ensureHudStyles = () => {
  if (!hudStylesPromise) {
    hudStylesPromise = import('../../public/hud.css');
  }
  return hudStylesPromise;
};

const ensureBrainStyles = () => {
  if (!brainStylesPromise) {
    brainStylesPromise = import('../../public/brain.css');
  }
  return brainStylesPromise;
};

let isListening = true;
let answerInProgress = false;

const logHud = (message) => console.log(`[HUD] ${message}`);
const logBrain = (message) => console.log(`[BRAIN] ${message}`);

const normalizeText = (value) => value.replace(/\s+/g, ' ').trim();

const findOverlap = (existing, incoming) => {
  const max = Math.min(existing.length, incoming.length);
  for (let len = max; len > 0; len -= 1) {
    if (existing.slice(-len) === incoming.slice(0, len)) {
      return len;
    }
  }
  return 0;
};

const stripFillers = (text) => text.replace(FILLER_REGEX, ' ');

const collapseWordRepeats = (text) => text.replace(/\b(\w+)(\s+\1\b)+/gi, '$1');

const collapsePhraseRepeats = (text) => {
  let next = text;
  for (let iteration = 0; iteration < 2; iteration += 1) {
    next = next.replace(/(\b[\w']+\b(?:\s+\b[\w']+\b){3,})\s+\1/gi, '$1');
  }
  return next;
};

const removeOverlappingSegments = (text) => {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 12) {
    return text;
  }
  const maxWindow = Math.min(18, Math.floor(words.length / 2));
  for (let window = maxWindow; window >= 6; window -= 1) {
    const tailStart = words.length - window;
    const tail = words.slice(tailStart).join(' ').toLowerCase();
    for (let idx = 0; idx <= tailStart - window; idx += 1) {
      const candidate = words.slice(idx, idx + window).join(' ').toLowerCase();
      if (candidate === tail) {
        return normalizeText(words.slice(0, words.length - window).join(' '));
      }
    }
  }
  return text;
};

const collapseRepeatedClauses = (text) => {
  const segments = text.match(/[^.?!]+[.?!]?/g) || [text];
  const seen = new Set();
  const result = [];
  segments.forEach((segment) => {
    const trimmed = normalizeText(segment);
    if (!trimmed) {
      return;
    }
    const fingerprint = trimmed.toLowerCase();
    if (seen.has(fingerprint)) {
      return;
    }
    seen.add(fingerprint);
    result.push(segment.trim());
  });
  return normalizeText(result.join(' '));
};

const extractLikelyQuestion = (text) => {
  if (!text) {
    return '';
  }
  const questionMarkIndex = text.lastIndexOf('?');
  if (questionMarkIndex !== -1) {
    const priorSentenceBreak = Math.max(text.lastIndexOf('.', questionMarkIndex - 1), text.lastIndexOf('!', questionMarkIndex - 1));
    return normalizeText(text.slice(Math.max(0, priorSentenceBreak + 1), questionMarkIndex + 1));
  }
  const segments = text.match(/[^.?!]+[.?!]?/g) || [text];
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i].trim();
    if (!segment) {
      continue;
    }
    const lower = segment.toLowerCase();
    if (QUESTION_HINTS.some((hint) => lower.startsWith(hint) || lower.includes(` ${hint}`))) {
      return normalizeText(segment);
    }
  }
  const fallback = segments[segments.length - 1]?.trim() || text;
  return normalizeText(fallback);
};

const buildCleanedQuestion = (rawTranscript) => {
  if (!rawTranscript) {
    return '';
  }
  let working = normalizeText(rawTranscript);
  if (!working) {
    return '';
  }
  working = stripFillers(working);
  working = collapseWordRepeats(working);
  working = collapsePhraseRepeats(working);
  working = removeOverlappingSegments(working);
  working = collapseRepeatedClauses(working);
  working = normalizeText(working);
  working = extractLikelyQuestion(working);
  if (working.length > 320) {
    working = working.slice(-320);
  }
  return working;
};

const initHud = () => {
  const transcriptEl = document.getElementById('transcript');
  const statusDot = document.getElementById('ws-status-dot');
  const statusLabel = document.getElementById('ws-status-label');
  const answerButton = document.getElementById('answer-btn');
  const stopButton = document.getElementById('stop-btn');
  const hideButton = document.getElementById('hide-btn');
  const scaleUpButton = document.getElementById('scale-up-btn');
  const scaleDownButton = document.getElementById('scale-down-btn');
  const moveLeftButton = document.getElementById('move-left-btn');
  const moveRightButton = document.getElementById('move-right-btn');
  const toastEl = document.getElementById('hud-toast');

  let transcriptBuffer = transcriptEl?.textContent?.trim() || '';
  let hudWasListeningBeforeAnswer = true;
  let toastTimer;

  const stateLabels = {
    connecting: 'Connecting...',
    connected: 'Connected',
    disconnected: 'Disconnected',
    error: 'Connection Error',
  };

  const showToast = (message, variant = 'info') => {
    if (!toastEl || !message) {
      return;
    }
    clearTimeout(toastTimer);
    toastEl.textContent = message;
    toastEl.dataset.variant = variant;
    toastEl.classList.add('is-visible');
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('is-visible');
    }, 2600);
  };

  const setTranscriptLive = () => {
    if (!transcriptEl) return;
    transcriptEl.setAttribute('aria-live', isListening ? 'polite' : 'off');
    transcriptEl.classList.toggle('is-locked', answerInProgress);
  };

  const setWsState = (state) => {
    if (statusDot) {
      statusDot.classList.remove('status-connected', 'status-connecting', 'status-disconnected', 'status-error');
      statusDot.classList.add(`status-${state}`);
    }
    if (statusLabel) {
      statusLabel.textContent = stateLabels[state] || stateLabels.disconnected;
    }
  };

  const appendTranscript = (buffer, addition) => {
    const normalizedAddition = normalizeText(addition);
    if (!normalizedAddition) {
      return buffer;
    }
    if (!buffer) {
      return normalizedAddition;
    }
    const overlap = findOverlap(buffer, normalizedAddition);
    const delta = normalizedAddition.slice(overlap);
    if (!delta) {
      return buffer;
    }
    const needsSpace = buffer && !buffer.endsWith(' ') && !delta.startsWith(' ');
    const nextBuffer = `${buffer}${needsSpace ? ' ' : ''}${delta}`;
    return nextBuffer.slice(-TRANSCRIPT_MAX_LENGTH);
  };

  const updateTranscript = (incoming) => {
    if (!transcriptEl || !incoming) {
      return;
    }
    transcriptBuffer = appendTranscript(transcriptBuffer, incoming);
    transcriptEl.textContent = transcriptBuffer;
  };

  const extractChunkText = (payload) => {
    if (typeof payload === 'string') {
      return payload;
    }
    if (!payload) {
      return '';
    }
    return payload.text || payload.chunk || payload.data || '';
  };

  const handleIncomingChunk = (payload) => {
    if (!isListening) {
      return;
    }
    const text = normalizeText(extractChunkText(payload));
    if (!text) {
      return;
    }
    updateTranscript(text);
  };

  const applyStatus = (state) => {
    const normalized = state && stateLabels[state] ? state : 'disconnected';
    setWsState(normalized);
  };

  setWsState('connecting');

  window.electronAPI?.onSttStatus?.((payload = {}) => {
    applyStatus(payload.state || 'disconnected');
  });

  window.electronAPI?.onTranscriptUpdate?.((text) => {
    handleIncomingChunk(text);
  });

  const statusPromise = window.electronAPI?.requestSttStatus?.();
  if (statusPromise?.then) {
    statusPromise
      .then((state) => {
        if (state) {
          applyStatus(state);
        } else {
          setWsState('connecting');
        }
      })
      .catch(() => setWsState('connecting'));
  }

  const updateStopButton = () => {
    if (!stopButton) return;
    stopButton.textContent = isListening ? 'Stop Listening' : 'Resume Listening';
    stopButton.classList.toggle('is-paused', !isListening);
    setTranscriptLive();
  };

  const lockHudTranscript = () => {
    answerInProgress = true;
    hudWasListeningBeforeAnswer = isListening;
    isListening = false;
    updateStopButton();
    window.electronAPI?.toggleListening?.(false);
    transcriptEl?.setAttribute('data-locked', 'true');
    transcriptEl?.setAttribute('aria-live', 'off');
    if (answerButton) {
      answerButton.disabled = true;
      answerButton.classList.add('is-busy');
    }
  };

  const unlockHudTranscript = () => {
    answerInProgress = false;
    isListening = hudWasListeningBeforeAnswer;
    updateStopButton();
    window.electronAPI?.toggleListening?.(isListening);
    transcriptEl?.removeAttribute('data-locked');
    transcriptEl?.setAttribute('aria-live', isListening ? 'polite' : 'off');
    if (answerButton) {
      answerButton.disabled = false;
      answerButton.classList.remove('is-busy');
    }
  };

  const handleAnswerStartFailure = (details = {}, variant = 'error') => {
    const reason = details?.message || 'Unable to start answer stream.';
    logHud(reason);
    showToast(reason, variant);
    unlockHudTranscript();
  };

  window.electronAPI?.onAnswerComplete?.((payload = {}) => {
    unlockHudTranscript();
    if (payload.status !== 'done') {
      const reason = payload.error || 'Answer failed.';
      logHud(`Answer failed: ${reason}`);
      showToast(`Answer failed: ${reason}`, 'error');
      return;
    }
    logHud('Answer complete');
    showToast('Answer ready.', 'success');
  });

  answerButton?.addEventListener('click', async () => {
    if (answerInProgress) {
      logHud('Answer already in progress.');
      showToast('Answer already in progress.', 'warning');
      return;
    }
    const frozenTranscript = transcriptBuffer.trim();
    if (!frozenTranscript) {
      logHud('No transcript captured yet.');
      showToast('No transcript captured yet.', 'warning');
      return;
    }

    const cleanedQuestion = buildCleanedQuestion(frozenTranscript);
    if (!cleanedQuestion || cleanedQuestion.length < 5) {
      logHud('Need a clearer interviewer question before answering.');
      showToast('Need a clearer interviewer question before answering.', 'warning');
      return;
    }

    window.electronAPI?.openBrain?.();
    lockHudTranscript();

    const metadata = { timestamp: Date.now() };

    try {
      const response = await window.electronAPI?.startAnswer?.({
        transcript: frozenTranscript,
        cleanedQuestion,
        metadata,
      });
      if (!response || response.status !== 'started') {
        const warningStatuses = new Set(['busy', 'invalid-question']);
        const variant = warningStatuses.has(response?.status) ? 'warning' : 'error';
        handleAnswerStartFailure(response, variant);
      } else {
        logHud('Answer streaming started.');
        showToast('Answer streaming started.', 'info');
      }
    } catch (error) {
      handleAnswerStartFailure({ message: error?.message || 'Failed to reach backend.' });
    }
  });

  stopButton?.addEventListener('click', () => {
    if (answerInProgress) {
      logHud('Listening is locked while answer streams.');
      return;
    }
    isListening = !isListening;
    updateStopButton();
    window.electronAPI?.toggleListening?.(isListening);
    logHud(isListening ? 'Listening resumed' : 'Listening paused');
  });

  hideButton?.addEventListener('click', () => {
    window.electronAPI?.toggleHud?.();
    logHud('Hide HUD clicked');
  });

  scaleUpButton?.addEventListener('click', () => {
    window.electronAPI?.scaleUp?.();
    window.electronAPI?.syncBrainPosition?.();
    logHud('Scale up');
  });

  scaleDownButton?.addEventListener('click', () => {
    window.electronAPI?.scaleDown?.();
    window.electronAPI?.syncBrainPosition?.();
    logHud('Scale down');
  });

  moveLeftButton?.addEventListener('click', () => {
    window.electronAPI?.moveLeft?.();
    window.electronAPI?.syncBrainPosition?.();
    logHud('Move left');
  });

  moveRightButton?.addEventListener('click', () => {
    window.electronAPI?.moveRight?.();
    window.electronAPI?.syncBrainPosition?.();
    logHud('Move right');
  });

  updateStopButton();
};

const initBrain = () => {
  const closeButton = document.getElementById('close-brain-btn');
  const statusEl = document.getElementById('brain-status');
  const questionEl = document.getElementById('question-stream');
  const answerEl = document.getElementById('answer-stream');
  const questionStateEl = document.getElementById('question-section-state');
  const answerStateEl = document.getElementById('answer-section-state');

  const state = {
    sessionId: 0,
    questionBuffer: '',
    answerBuffer: '',
  };

  const setStatus = (text, variant = 'idle') => {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.dataset.variant = variant;
  };

  const setSectionState = (target, text, variant = 'idle') => {
    if (!target) return;
    target.textContent = text;
    target.dataset.variant = variant;
  };

  const shouldStickToBottom = (container) => {
    if (!container) return false;
    return container.scrollHeight - container.clientHeight - container.scrollTop < 28;
  };

  const updateStream = (container, bufferKey, chunk) => {
    if (!container || !chunk) return;
    const stick = shouldStickToBottom(container);
    state[bufferKey] = `${state[bufferKey]}${chunk}`;
    container.textContent = state[bufferKey];
    if (stick) {
      container.scrollTop = container.scrollHeight;
    }
  };

  const resetStreams = (payload = {}) => {
    const { sessionId = 0 } = payload;
    if (sessionId < state.sessionId) {
      return;
    }
    state.sessionId = sessionId;
    state.questionBuffer = '';
    state.answerBuffer = '';
    if (questionEl) {
      questionEl.textContent = '';
      questionEl.scrollTop = 0;
      questionEl.classList.remove('brain-stream--complete');
    }
    if (answerEl) {
      answerEl.textContent = '';
      answerEl.scrollTop = 0;
      answerEl.classList.remove('brain-stream--complete', 'brain-stream--error');
    }
    setStatus('Summarising interviewer question...', 'active');
    setSectionState(questionStateEl, 'Summarising interviewer question...', 'active');
    setSectionState(answerStateEl, 'Awaiting model answer...', 'idle');
  };

  window.electronAPI?.onQuestionStream?.((payload = {}) => {
    if (payload.reset) {
      resetStreams(payload);
      return;
    }
    const sessionId = payload.sessionId || 0;
    if (sessionId && sessionId < state.sessionId) {
      return;
    }
    const chunk = typeof payload === 'string' ? payload : payload.chunk || payload.text || '';
    if (!chunk) {
      return;
    }
    updateStream(questionEl, 'questionBuffer', chunk);
    setSectionState(questionStateEl, 'Summarising interviewer question...', 'active');
  });

  window.electronAPI?.onQuestionComplete?.((payload = {}) => {
    const { sessionId = 0, reset } = payload;
    if (sessionId && sessionId < state.sessionId) {
      return;
    }
    if (reset) {
      questionEl?.classList.remove('brain-stream--complete');
      setSectionState(questionStateEl, 'Summarising interviewer question...', 'active');
      setSectionState(answerStateEl, 'Awaiting model answer...', 'idle');
      return;
    }
    questionEl?.classList.add('brain-stream--complete');
    setSectionState(questionStateEl, 'Summary locked', 'complete');
    setSectionState(answerStateEl, 'Answer streaming...', 'active');
    setStatus('Answer streaming...', 'active');
  });

  window.electronAPI?.onAnswerStream?.((payload = {}) => {
    const sessionId = payload.sessionId || 0;
    if (sessionId && sessionId < state.sessionId) {
      return;
    }
    const chunk = typeof payload === 'string' ? payload : payload.chunk || payload.text || '';
    if (!chunk) {
      return;
    }
    setStatus('Model answer streaming...', 'active');
    updateStream(answerEl, 'answerBuffer', chunk);
    setSectionState(answerStateEl, 'Answer streaming...', 'active');
  });

  window.electronAPI?.onAnswerComplete?.((payload = {}) => {
    const { status = 'done', error, sessionId = 0 } = payload;
    if (sessionId && sessionId < state.sessionId) {
      return;
    }
    if (status === 'done') {
      setStatus('Answer ready.', 'complete');
      setSectionState(answerStateEl, 'Answer ready', 'complete');
    } else {
      const failureText = error ? `Answer failed: ${error}` : 'Answer failed.';
      setStatus(failureText, 'error');
      setSectionState(answerStateEl, 'Answer failed', 'error');
      answerEl?.classList.add('brain-stream--error');
    }
    questionEl?.classList.add('brain-stream--complete');
    answerEl?.classList.add('brain-stream--complete');
  });

  closeButton?.addEventListener('click', () => {
    window.electronAPI?.closeBrain?.();
    logBrain('Close clicked');
  });
};

window.addEventListener('DOMContentLoaded', async () => {
  if (document.getElementById('transcript')) {
    await ensureHudStyles();
    initHud();
    return;
  }
  if (document.getElementById('close-brain-btn')) {
    await ensureBrainStyles();
    initBrain();
  }
});
