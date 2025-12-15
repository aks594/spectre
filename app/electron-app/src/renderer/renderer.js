if (window.SPECTRE_RENDERER_RUNNING) {
  console.warn('Renderer already running, skipping re-init.');
  throw new Error('Renderer guard: prevent double-init');
}
window.SPECTRE_RENDERER_RUNNING = true;

const { marked } = require('marked'); // Add this at the very top
const hljs = require('highlight.js');

const DEFAULT_CODE_LANGUAGE = 'plaintext';

marked.setOptions({
  breaks: true,
  highlight(code, lang) {
    const language = lang && hljs.getLanguage(lang) ? lang : DEFAULT_CODE_LANGUAGE;
    try {
      return hljs.highlight(code, { language }).value;
    } catch (error) {
      console.warn('Code highlight failed, falling back to plaintext.', error);
      return hljs.highlight(code, { language: DEFAULT_CODE_LANGUAGE }).value;
    }
  },
});

// Ensure the HUD is always interactive/draggable.
const setupMouseEvents = () => {
  if (window?.electronAPI?.setIgnoreMouseEvents) {
    window.electronAPI.setIgnoreMouseEvents(false);
  }
};

// Wire custom resize handles to send delta updates to main.
const setupResizeHandles = () => {
  const leftHandle = document.getElementById('resize-left');
  const rightHandle = document.getElementById('resize-right');

  const wire = (direction, element) => {
    if (!element) return;
    let lastX = 0;

    const onMouseMove = (event) => {
      const deltaX = event.clientX - lastX;
      lastX = event.clientX;
      window.electronAPI?.performResize?.({ direction, deltaX });
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    element.addEventListener('mousedown', (event) => {
      event.preventDefault();
      lastX = event.clientX;
      window.electronAPI?.startResize?.(direction);
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  };

  wire('left', leftHandle);
  wire('right', rightHandle);
};

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

const renderMarkdown = (markdown) => {
  const safe = typeof markdown === 'string' ? markdown : '';
  try {
    // Directly use the imported library
    return marked.parse(safe);
  } catch (e) {
    console.error('Markdown rendering failed', e);
    return safe;
  }
};

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
  const existingLower = existing.toLowerCase();
  const incomingLower = incoming.toLowerCase();
  
  // First try exact case-insensitive character match
  for (let len = max; len > 3; len -= 1) {
    if (existingLower.slice(-len) === incomingLower.slice(0, len)) {
      return len;
    }
  }
  
  // Then try word-level overlap (more aggressive)
  const existingWords = existing.trim().split(/\s+/);
  const incomingWords = incoming.trim().split(/\s+/);
  const maxWords = Math.min(existingWords.length, incomingWords.length);
  
  for (let wordCount = maxWords; wordCount >= 3; wordCount -= 1) {
    const existingTail = existingWords.slice(-wordCount).join(' ').toLowerCase();
    const incomingHead = incomingWords.slice(0, wordCount).join(' ').toLowerCase();
    
    if (existingTail === incomingHead) {
      // Return character length of the overlap
      return incoming.split(/\s+/).slice(0, wordCount).join(' ').length;
    }
  }
  
  return 0;
};

const stripFillers = (text) => text.replace(FILLER_REGEX, ' ');

const collapseWordRepeats = (text) => text.replace(/\b(\w+)(\s+\1\b)+/gi, '$1');

const collapsePhraseRepeats = (text) => {
  let next = text;
  // Run multiple passes to catch nested repetitions
  for (let iteration = 0; iteration < 3; iteration += 1) {
    // Match 4+ word phrases that repeat
    next = next.replace(/(\b[\w']+\b(?:\s+\b[\w']+\b){3,})\s+\1/gi, '$1');
    // Match 3-word phrases that repeat (more aggressive)
    next = next.replace(/(\b[\w']+\b(?:\s+\b[\w']+\b){2})\s+\1/gi, '$1');
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

const dedupeSentences = (text = '') => {
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
    result.push(trimmed);
  });
  return result.join(' ').trim();
};

const ANSWER_SECTION_ORDER = ['Intuition', 'Algorithm', 'Implementation', 'Complexity Analysis'];
const ANSWER_HEADING_LOOKUP = {
  intuition: 'Intuition',
  algorithm: 'Algorithm',
  implementation: 'Implementation',
  complexityanalysis: 'Complexity Analysis',
  complexity: 'Complexity Analysis',
};

const normalizeHeadingToken = (value = '') => value.toLowerCase().replace(/[^a-z]/g, '');

const sanitizeAnswerMarkdown = (markdown = '') => {
  if (!markdown) {
    return '';
  }

  const lines = markdown.split(/\r?\n/);
  const buckets = { preamble: [] };
  let currentSection = 'preamble';
  const seen = new Set();
  let hardStop = false;
  let skipBody = false;

  const pushLine = (section, line) => {
    if (!section || section === 'skip') return;
    if (!buckets[section]) buckets[section] = [];
    buckets[section].push(line);
  };

  for (const rawLine of lines) {
    if (hardStop) break;

    const trimmed = rawLine.trim();
    const headingMatch = trimmed.match(/^#{1,6}\s*(.+)$/);
    if (headingMatch) {
      const headingText = headingMatch[1] || '';
      const firstToken = headingText.split(/\s+/)[0] || headingText;
      let normalized = normalizeHeadingToken(firstToken);
      let canonical = ANSWER_HEADING_LOOKUP[normalized];
      if (!canonical) {
        // Try prefix matching (handles cases like "Complexity Analysis:The" or missing space)
        const fallbackKey = Object.keys(ANSWER_HEADING_LOOKUP).find((key) => normalized.startsWith(key));
        if (fallbackKey) {
          canonical = ANSWER_HEADING_LOOKUP[fallbackKey];
        }
      }

      if (canonical) {
        if (seen.has('Complexity Analysis') && canonical !== 'Complexity Analysis') {
          hardStop = true;
          break;
        }
        if (seen.has(canonical)) {
          // Skip duplicate section content
          skipBody = true;
          currentSection = 'skip';
          continue;
        }

        seen.add(canonical);
        currentSection = canonical;
        skipBody = false;
        if (!buckets[currentSection]) buckets[currentSection] = [];

        // If heading line contains inline body, keep the body text
        const bodyPart = headingText.split(/\s+/, 2)[1];
        if (bodyPart) {
          pushLine(currentSection, bodyPart.trim());
        }
        continue;
      }
    }

    if (skipBody) {
      // Ignore lines until next recognized heading
      continue;
    }

    pushLine(currentSection, rawLine);
  }

  const blocks = [];
  const preamble = (buckets.preamble || []).join('\n').trim();
  if (preamble) {
    blocks.push(preamble);
  }

  ANSWER_SECTION_ORDER.forEach((heading) => {
    const content = (buckets[heading] || []).join('\n').trim();
    if (!content) return;
    blocks.push(`## ${heading}\n${content}`);
    if (heading === 'Complexity Analysis') {
      // Enforce stop after final section
      hardStop = true;
    }
  });

  const sanitized = blocks.join('\n\n').trim();
  return sanitized || markdown.trim();
};

const sanitizeSummaryText = (text = '') => dedupeSentences(text);

const buildCleanedQuestion = (rawTranscript) => {
  if (!rawTranscript) {
    return '';
  }
  let working = normalizeText(rawTranscript);
  if (!working) {
    return '';
  }
  // First pass: remove basic duplicates
  working = stripFillers(working);
  working = collapseWordRepeats(working);
  
  // Second pass: aggressive phrase deduplication
  working = collapsePhraseRepeats(working);
  working = removeOverlappingSegments(working);
  
  // Third pass: remove sentence-level duplicates
  working = collapseRepeatedClauses(working);
  
  // Fourth pass: normalize and extract the actual question
  working = normalizeText(working);
  working = extractLikelyQuestion(working);
  
  // Final cleanup: one more word-level dedup in case fragments remain
  working = collapseWordRepeats(working);
  
  if (working.length > 320) {
    working = working.slice(-320);
  }
  return working;
};

const initHud = () => {
  setupMouseEvents();
  setupResizeHandles();
  const transcriptEl = document.getElementById('transcript');
  const logPanel = document.getElementById('log-content');
  const statusDot = document.getElementById('ws-status-dot');
  const statusLabel = document.getElementById('ws-status-label');
  const answerButton = document.getElementById('answer-btn');
  const analyzeButton = document.getElementById('analyze-btn');
  const stopButton = document.getElementById('stop-btn');
  const hideButton = document.getElementById('hide-btn');
  const hudToggle = document.getElementById('hud-toggle');
  const scaleUpButton = document.getElementById('scale-up-btn');
  const scaleDownButton = document.getElementById('scale-down-btn');
  const moveLeftButton = document.getElementById('move-left-btn');
  const moveRightButton = document.getElementById('move-right-btn');
  const exitButton = document.getElementById('exit-btn');
  const clearButton = document.getElementById('clear-transcript-btn');
  const layoutTrigger = document.querySelector('.layout-trigger');
  const layoutMenu = document.querySelector('.layout-menu');
  const toastEl = document.getElementById('hud-toast');
  const hudShell = document.querySelector('.hud-shell');

  // --- CLICK-THROUGH LOGIC ---
  window.addEventListener('mousemove', (event) => {
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (!element) return; // <--- FIX: Prevents "Cannot read properties of null" error
    
    const isInteractive = element.closest('.brain-shell') || element.closest('.hud-shell') || element.tagName === 'BUTTON';
    window.electronAPI.setIgnoreMouseEvents(!isInteractive, { forward: true });
  });

  if (hudShell && window?.ResizeObserver) {
    const observer = new ResizeObserver((entries) => {
      entries.forEach((entry) => {
        const height = Math.round(entry.contentRect.height + 24);
        if (Number.isFinite(height) && height > 0) {
          window.electronAPI?.sendHudHeight?.(height);
        }
      });
    });
    observer.observe(hudShell);
  }

  const PLACEHOLDER = 'Waiting for transcript...';
  let hudWasListeningBeforeAnswer = true;
  let toastTimer;

  const setTranscriptContent = (text) => {
    const safeText = typeof text === 'string' ? text : '';
    const trimmed = safeText.trim();
    const display = trimmed ? safeText : PLACEHOLDER;
    if (transcriptEl) {
      transcriptEl.innerText = display;
    }
    if (logPanel) {
      logPanel.textContent = display;
    }
  };

  const getTranscriptText = () => {
    if (!transcriptEl) return '';
    const raw = transcriptEl.innerText || '';
    const trimmed = raw.trim();
    if (trimmed === PLACEHOLDER) return '';
    return trimmed;
  };

  const stateLabels = {
    connecting: 'Connecting...',
    connected: 'Connected',
    disconnected: 'Disconnected',
    error: 'Connection Error',
  };

  const updateAnswerButtonState = () => {
    if (!answerButton) return;
    const currentTranscript = getTranscriptText();
    const hasTranscript = Boolean(currentTranscript);
    const shouldDisable = answerInProgress || !hasTranscript;
    answerButton.disabled = shouldDisable;
    answerButton.classList.toggle('is-disabled', shouldDisable);
  };

  // Initialize transcript from DOM and set initial button state
  const initialText = transcriptEl?.innerText?.trim() || '';
  setTranscriptContent(initialText === PLACEHOLDER ? '' : initialText);
  updateAnswerButtonState();

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
    const current = getTranscriptText();
    const next = appendTranscript(current, incoming);
    setTranscriptContent(next);
    transcriptEl.scrollLeft = transcriptEl.scrollWidth;
    updateAnswerButtonState();
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
      answerButton.classList.remove('is-busy');
      updateAnswerButtonState();
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

  // --- VISION UPGRADE LISTENER ---
  analyzeButton?.addEventListener('click', () => {
    logHud('Analyze Screen clicked');
    window.electronAPI.openBrain();
    // No text update here, handled by CSS state in Brain
    window.electronAPI.analyzeScreen();
  });

  transcriptEl?.addEventListener('input', () => {
    updateAnswerButtonState();
  });

  answerButton?.addEventListener('click', async () => {
    if (answerInProgress) {
      logHud('Answer already in progress.');
      showToast('Answer already in progress.', 'warning');
      return;
    }
    const frozenTranscript = getTranscriptText();
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

  analyzeButton?.addEventListener('click', async () => {
    if (analyzeButton.classList.contains('is-busy')) {
      return;
    }
    analyzeButton.classList.add('is-busy');
    analyzeButton.disabled = true;
    try {
      showToast('Capturing screen...', 'info');
      const response = await window.electronAPI?.analyzeScreen?.();
      if (response?.status === 'error') {
        showToast(response.message || 'Screen analysis failed.', 'error');
      } else {
        showToast('Analyzing screenshot...', 'info');
      }
    } catch (error) {
      showToast(error?.message || 'Screen analysis failed.', 'error');
    } finally {
      analyzeButton.disabled = false;
      analyzeButton.classList.remove('is-busy');
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

  hudToggle?.addEventListener('change', () => {
    if (hudToggle.checked) {
      window.electronAPI?.hideBrainOnly?.();
      return;
    }
    window.electronAPI?.showBrainOnly?.();
  });

  if (layoutTrigger && layoutMenu) {
    layoutTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      layoutMenu.classList.toggle('is-open');
    });
    document.addEventListener('click', (e) => {
      if (layoutMenu.contains(e.target) || layoutTrigger.contains(e.target)) return;
      layoutMenu.classList.remove('is-open');
    });
  }

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

  clearButton?.addEventListener('click', () => {
    setTranscriptContent('');
    updateAnswerButtonState();
    logHud('Transcript cleared');
  });

  exitButton?.addEventListener('click', () => {
    window.electronAPI?.exitApp?.();
    logHud('Exit clicked');
  });

  updateStopButton();
  updateAnswerButtonState();
};

const initBrain = () => {
  setupResizeHandles();
  const closeButton = document.getElementById('close-brain-btn');
  const statusEl = document.getElementById('brain-status');
  const questionEl = document.getElementById('question-stream');
  const answerEl = document.getElementById('answer-stream');
  const questionStateEl = document.getElementById('question-section-state');
  const answerStateEl = document.getElementById('answer-section-state');
  const brainShell = document.querySelector('.brain-shell');

  const state = {
    sessionId: 0,
    questionBuffer: '',
    answerBuffer: '',
  };

  // --- CLICK-THROUGH LOGIC ---
  window.addEventListener('mousemove', (event) => {
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (!element) return; // <--- FIX: Prevents "Cannot read properties of null" error

    const isInteractive = element.closest('.brain-shell') || element.closest('.hud-shell') || element.tagName === 'BUTTON';
    window.electronAPI.setIgnoreMouseEvents(!isInteractive, { forward: true });
  });

  const attachCopyButtons = (root) => {
    if (!root) return;
    const blocks = root.querySelectorAll('pre');
    blocks.forEach((pre) => {
      if (pre.querySelector('.code-copy-btn')) {
        return;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'code-copy-btn';
      btn.setAttribute('aria-label', 'Copy code');
      btn.textContent = '⧉';
      btn.addEventListener('click', () => {
        const codeText = pre.querySelector('code')?.innerText
          || Array.from(pre.childNodes)
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent || '')
            .join('')
            .trim();
        if (!codeText) return;
        navigator.clipboard?.writeText(codeText);
      });
      pre.style.position = pre.style.position || 'relative';
      pre.appendChild(btn);
    });
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

  const updateStream = (container, bufferKey, chunk, options = {}) => {
    if (!container || !chunk) return;
    const stick = shouldStickToBottom(container);
    state[bufferKey] = `${state[bufferKey]}${chunk}`;
    const { markdown = false, sanitizer } = options;
    const displayValue = sanitizer ? sanitizer(state[bufferKey]) : state[bufferKey];
    if (markdown) {
      container.innerHTML = renderMarkdown(displayValue);
    } else {
      container.textContent = displayValue;
    }
    attachCopyButtons(container);
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
      answerEl.innerHTML = '';
      answerEl.scrollTop = 0;
      answerEl.classList.remove('brain-stream--complete', 'brain-stream--error');
      answerEl.classList.add('is-thinking');
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
    console.log('[BRAIN] Question chunk received:', chunk);
    updateStream(questionEl, 'questionBuffer', chunk, { sanitizer: sanitizeSummaryText });
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
    if (sessionId && sessionId < state.sessionId) return;
    
    const chunk = typeof payload === 'string' ? payload : payload.chunk || '';
    if (!chunk) return;

    // Remove loading spinner class if present
    answerEl.classList.remove('is-thinking');

    updateStream(answerEl, 'answerBuffer', chunk, {
      markdown: true,
      sanitizer: sanitizeAnswerMarkdown,
    });

    setSectionState(answerStateEl, 'Answer streaming...', 'active');
    // Auto-scroll logic
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

  if (brainShell && window.ResizeObserver) {
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const height = Math.ceil(entry.contentRect.height + 4); // +4 for border/shadow safety
        if (height > 0) {
          window.Electron?.sendBrainHeight?.(height);
        }
      }
    });
    observer.observe(brainShell);
  }

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
