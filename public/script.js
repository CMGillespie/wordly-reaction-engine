// Wordly Secure Viewer Script (v20 - Local reaction tracking + dedup)
// v18: Silent audio loop, Media Session API, Page Visibility reconnect
// v19: Reaction engine - 5 emojis, anonymous ID, message listener
// v20: Local reaction memory per bubble, dedup display, multi-emoji support
document.addEventListener('DOMContentLoaded', () => {

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('Service Worker registered.'))
      .catch(err => console.error('Service Worker registration failed:', err));
  }

  // --- DOM Elements ---
  const configInputArea = document.getElementById('config-input-area');
  const tempSessionIdInput = document.getElementById('temp-session-id');
  const tempPasscodeInput = document.getElementById('temp-passcode');
  const tempConnectBtn = document.getElementById('temp-connect-btn');
  const tempStatus = document.getElementById('temp-status');
  const appPage = document.getElementById('app-page');
  const sessionDisplayHeader = document.getElementById('session-display-header');
  const languageSelect = document.getElementById('language-select');
  const audioToggle = document.getElementById('audio-toggle');
  const disconnectBtn = document.getElementById('disconnect-btn');
  const transcriptArea = document.getElementById('transcript-area');
  const connectionStatusLight = document.getElementById('connection-status');
  const wakeLockBtn = document.getElementById('wake-lock-btn');
  const mainAudioPlayer = document.getElementById('main-audio-player');
  const scrollDirectionBtn = document.getElementById('scroll-direction-btn');
  const appHeader = document.getElementById('app-header');
  const headerToggleButton = document.getElementById('header-toggle-btn');
  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  const loginThemeToggleBtn = document.getElementById('login-theme-toggle-btn');
  const collapseBtn = document.getElementById('collapse-btn');
  const mainContent = document.getElementById('main-content');
  const scrollToBottomBtn = document.getElementById('scroll-to-bottom-btn');
  const newMessageCountSpan = document.getElementById('new-message-count');
  const fontSizeToggleBtn = document.getElementById('font-size-toggle-btn');
  const fontBoldToggleBtn = document.getElementById('font-bold-toggle-btn');
  const reactionDialog = document.getElementById('reaction-dialog');
  const dialogOverlay = document.getElementById('dialog-overlay');

  let screenWakeLock = null;
  let activeUtteranceData = null;
  let messageListenerUnsubscribe = null;
  // v21: track last speaker for >> change indicator
  let lastSpeakerId = null;
  let lastSpeakerTag = null;
  // v24: live reaction listeners
  let showLiveReactions = false;
  let sessionFlagListener = null;
  const utteranceListeners = {};
  const MAX_UTTERANCE_LISTENERS = 20;

  // --- Application State ---
  const state = {
    sessionId: null, passcode: '', websocket: null, audioEnabled: false,
    isPlayingAudio: false, audioQueue: [], reconnectInterval: null,
    isDeliberateDisconnect: false, scrollDirection: 'down',
    headerCollapsed: false, headerCollapseTimeout: null, contentHidden: false,
    userScrolledUp: false, newMessagesWhileScrolled: 0, fontSize: 'normal',
    fontBold: false, darkMode: false,
    // v20: local reaction memory { utteranceId: Set of reaction types }
    myReactions: {},
  };

  const languageMap = { 'af': 'Afrikaans', 'sq': 'Albanian', 'ar': 'Arabic', 'hy': 'Armenian', 'bn': 'Bengali', 'bg': 'Bulgarian', 'zh-HK': 'Cantonese', 'ca': 'Catalan', 'zh-CN': 'Chinese (Simplified)', 'zh-TW': 'Chinese (Traditional)', 'hr': 'Croatian', 'cs': 'Czech', 'da': 'Danish', 'nl': 'Dutch', 'en': 'English (US)', 'en-AU': 'English (AU)', 'en-GB': 'English (UK)', 'et': 'Estonian', 'fi': 'Finnish', 'fr': 'French (FR)', 'fr-CA': 'French (CA)', 'ka': 'Georgian', 'de': 'German', 'el': 'Greek', 'gu': 'Gujarati', 'he': 'Hebrew', 'hi': 'Hindi', 'hu': 'Hungarian', 'is': 'Icelandic', 'id': 'Indonesian', 'ga': 'Irish', 'it': 'Italian', 'ja': 'Japanese', 'kn': 'Kannada', 'ko': 'Korean', 'lv': 'Latvian', 'lt': 'Lithuanian', 'mk': 'Macedonian', 'ms': 'Malay', 'mt': 'Maltese', 'no': 'Norwegian', 'fa': 'Persian', 'pl': 'Polish', 'pt': 'Portuguese (PT)', 'pt-BR': 'Portuguese (BR)', 'ro': 'Romanian', 'ru': 'Russian', 'sr': 'Serbian', 'sk': 'Slovak', 'sl': 'Slovenian', 'es': 'Spanish (ES)', 'es-MX': 'Spanish (MX)', 'sv': 'Swedish', 'tl': 'Tagalog', 'th': 'Thai', 'tr': 'Turkish', 'uk': 'Ukrainian', 'vi': 'Vietnamese', 'cy': 'Welsh', 'pa': 'Punjabi', 'sw': 'Swahili', 'ta': 'Tamil', 'ur': 'Urdu', 'zh': 'Chinese' };
  const rtlLanguages = ['ar', 'he', 'fa', 'ur', 'dv', 'ps', 'yi'];
  const HEADER_AUTO_COLLAPSE_DELAY = 10000;
  const ADD_REACTION_URL = 'https://addreaction-kkcretsy3a-uc.a.run.app';
  const REGISTER_ATTENDEE_URL = 'https://registerattendee-kkcretsy3a-uc.a.run.app';

  // --- v18: BACKGROUND PERSISTENCE ---
  const silentAudio = new Audio();
  silentAudio.src = 'silent.mp3';
  silentAudio.loop = true;
  silentAudio.volume = 0.001;

  function startSilentAudio() {
    if (silentAudio.paused) silentAudio.play().catch(() => {});
  }

  function stopSilentAudio() {
    silentAudio.pause();
    silentAudio.currentTime = 0;
  }

  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'Wordly Live Session',
      artist: 'Wordly AI Translation',
      album: state.sessionId || 'Live Event',
    });
    navigator.mediaSession.setActionHandler('play', () => silentAudio.play());
    navigator.mediaSession.setActionHandler('pause', () => {});
    navigator.mediaSession.setActionHandler('stop', () => {});
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (wakeLockBtn.classList.contains('active') && !screenWakeLock) requestWakeLock();
      if (state.sessionId && !state.isDeliberateDisconnect) {
        if (!state.websocket || state.websocket.readyState === WebSocket.CLOSED) {
          if (state.reconnectInterval) clearInterval(state.reconnectInterval);
          connectWebSocket();
        }
      }
    }
  });
  // --- END v18 ---

  init();

  function init() {
    loadFontSettings();
    loadThemeSettings();
    applyTheme();
    tempConnectBtn.addEventListener('click', connect);
    tempSessionIdInput.addEventListener('input', formatSessionIdInput);
    tempSessionIdInput.addEventListener('keydown', handleTempInputKeydown);
    tempPasscodeInput.addEventListener('keydown', handleTempInputKeydown);
    setupAppControls();
  }

  function setupAppControls() {
    disconnectBtn.addEventListener('click', disconnect);
    audioToggle.addEventListener('change', handleAudioToggle);
    languageSelect.addEventListener('change', handleLanguageChange);
    mainAudioPlayer.addEventListener('ended', onAudioEnded);
    mainAudioPlayer.addEventListener('error', handleAudioError);
    scrollDirectionBtn.addEventListener('click', handleScrollDirectionToggle);
    wakeLockBtn.addEventListener('click', handleWakeLockButtonClick);
    collapseBtn.addEventListener('click', toggleContentVisibility);
    headerToggleButton.addEventListener('click', toggleHeaderCollapseManual);
    themeToggleBtn.addEventListener('click', toggleTheme);
    loginThemeToggleBtn.addEventListener('click', toggleTheme);
    transcriptArea.addEventListener('scroll', handleTranscriptScroll);
    scrollToBottomBtn.addEventListener('click', handleScrollToTranscriptBottomClick);
    fontSizeToggleBtn.addEventListener('click', handleFontSizeToggle);
    fontBoldToggleBtn.addEventListener('click', handleFontBoldToggle);
    setupReactionListeners();
  }

  function connect() {
    state.sessionId = tempSessionIdInput.value;
    state.passcode = tempPasscodeInput.value;
    if (!isValidSessionId(state.sessionId)) {
      tempStatus.textContent = "Invalid Session ID format (XXXX-0000).";
      return;
    }
    configInputArea.style.display = 'none';
    appPage.style.display = 'flex';
    state.isDeliberateDisconnect = false;
    state.myReactions = {}; // reset local reaction memory for new session

    if (sessionDisplayHeader) {
      sessionDisplayHeader.textContent = `Session: ${maskSessionId(state.sessionId)}`;
    }
    populateLanguageSelect(languageSelect, 'en');
    startSilentAudio();
    setupMediaSession();
    setupMessageListener();
    setupLiveReactionsListener();
    setupEmojiListener();
    resetHeaderCollapseTimer();
    connectWebSocket();
  }

  function disconnect() {
    state.isDeliberateDisconnect = true;
    if (state.reconnectInterval) clearInterval(state.reconnectInterval);
    if (state.websocket) state.websocket.close(1000, "User disconnected");
    stopAndClearAudio();
    stopSilentAudio();
    lastSpeakerId = null;
    lastSpeakerTag = null;
    if (messageListenerUnsubscribe) {
      messageListenerUnsubscribe();
      messageListenerUnsubscribe = null;
    }
    if (sessionFlagListener) {
      sessionFlagListener();
      sessionFlagListener = null;
    }
    teardownAllUtteranceListeners();
    showLiveReactions = false;
    appPage.style.display = 'none';
    configInputArea.style.display = 'block';
    updateStatus('disconnected');
  }

  function handleAudioToggle() {
    state.audioEnabled = audioToggle.checked;
    resetHeaderCollapseTimer();
    if (state.audioEnabled) { sendVoiceRequest(true); processAudioQueue(); }
    else { sendVoiceRequest(false); stopAndClearAudio(); }
  }

  function handleLanguageChange() {
    resetHeaderCollapseTimer();
    const newLanguage = languageSelect.value;
    if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
      const wasAudioEnabled = state.audioEnabled;
      if (wasAudioEnabled) sendVoiceRequest(false);
      stopAndClearAudio();
      state.websocket.send(JSON.stringify({ type: 'change', languageCode: newLanguage }));
      if (wasAudioEnabled) setTimeout(() => sendVoiceRequest(true), 500);
    }
  }

  function connectWebSocket() {
    if (state.websocket) return;
    updateStatus('connecting');
    state.websocket = new WebSocket('wss://endpoint.wordly.ai/attend');

    state.websocket.onopen = () => {
      if (state.reconnectInterval) clearInterval(state.reconnectInterval);
      const connectRequest = {
        type: 'connect', presentationCode: state.sessionId,
        languageCode: languageSelect.value || 'en',
        identifier: `stable-viewer-${Date.now()}`
      };
      if (state.passcode) connectRequest.accessKey = state.passcode;
      state.websocket.send(JSON.stringify(connectRequest));
    };

    state.websocket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      switch (message.type) {
        case 'status':
          if (message.success) { updateStatus('connected'); if (state.audioEnabled) sendVoiceRequest(true); registerAttendee(); }
          else { updateStatus('error'); }
          break;
        case 'phrase': handlePhrase(message); break;
        case 'speech':
          if (message.synthesizedSpeech && message.synthesizedSpeech.data) {
            state.audioQueue.push({ data: message.synthesizedSpeech.data, phraseId: message.phraseId });
            processAudioQueue();
          }
          break;
        case 'end': disconnect(); break;
      }
    };

    state.websocket.onclose = () => {
      state.websocket = null;
      if (state.isDeliberateDisconnect) return;
      updateStatus('error');
      if (state.reconnectInterval) clearInterval(state.reconnectInterval);
      state.reconnectInterval = setInterval(connectWebSocket, 3000);
    };
    state.websocket.onerror = () => updateStatus('error');
  }

  function handlePhrase(message) {
    const isUserNearBottom = isScrolledToTranscriptBottom();
    let phraseElement = document.getElementById(`phrase-${message.phraseId}`);

    if (!phraseElement) {
      phraseElement = document.createElement('div');
      phraseElement.id = `phrase-${message.phraseId}`;
      phraseElement.className = 'phrase';

      if (rtlLanguages.includes(languageSelect.value)) phraseElement.classList.add('rtl');

      // v21: >> speaker change indicator per Jim's note
      // Show >> when speakerId or speakerTag changes from the previous phrase
      const speakerChanged = (message.speakerId !== lastSpeakerId) || (message.speakerTag !== lastSpeakerTag);
      const speakerIndicator = speakerChanged && (lastSpeakerId !== null)
        ? `<span class="speaker-change-indicator">&gt;&gt;</span>` : '';
      lastSpeakerId = message.speakerId;
      lastSpeakerTag = message.speakerTag || null;

      phraseElement.innerHTML = `
        ${speakerIndicator}
        <div class="phrase-text"></div>
        <span class="reaction-hint" style="position:absolute; bottom:4px; right:8px; font-size:0.75em; opacity:0.35; pointer-events:none; filter:grayscale(100%);">🙂 •••</span>`;

      phraseElement.addEventListener('click', () => showReactionDialog(message));

      if (state.scrollDirection === 'down') {
        transcriptArea.appendChild(phraseElement);
      } else {
        transcriptArea.insertBefore(phraseElement, transcriptArea.firstChild);
      }
    }

    phraseElement.querySelector('.phrase-text').textContent = message.translatedText;

    if (message.isFinal) {
      if (state.scrollDirection === 'up') {
        scrollToTranscriptTop();
      } else if (isUserNearBottom) {
        scrollToTranscriptBottom();
      } else {
        state.newMessagesWhileScrolled++;
        newMessageCountSpan.textContent = `(${state.newMessagesWhileScrolled})`;
        scrollToBottomBtn.style.display = 'flex';
      }
      // v24: attach live reaction listener for this utterance if enabled
      attachUtteranceListener(message.phraseId, phraseElement);
    }
  }

  // --- v20: Update the reaction hint on a bubble to show what the user picked ---
  function updateBubbleReactionDisplay(phraseId) {
    const phraseElement = document.getElementById(`phrase-${phraseId}`);
    if (!phraseElement) return;

    // If live reactions are on, renderReactionBar handles the display
    // Just ensure the mine chips are styled correctly next render
    if (showLiveReactions) {
      const bar = phraseElement.querySelector('.phrase-reaction-bar');
      if (bar) {
        // Re-render will happen via Firestore listener — nothing to do here
        return;
      }
    }

    const hint = phraseElement.querySelector('.reaction-hint');
    if (!hint) return;

    const myReactionsForThis = state.myReactions[phraseId];
    if (myReactionsForThis && myReactionsForThis.size > 0) {
      hint.textContent = Array.from(myReactionsForThis).join(' ');
      hint.style.opacity = '1';
      hint.style.filter = 'none';
      hint.style.fontSize = '0.85em';
    }
  }

  // --- v22: ATTENDEE REGISTRATION ---
  // Called on successful WebSocket connect — registers presence regardless of reactions
  async function registerAttendee() {
    if (!state.sessionId) return;
    const anonymousId = getOrCreateAnonymousId();
    try {
      await fetch(REGISTER_ATTENDEE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: state.sessionId, anonymous_id: anonymousId })
      });
    } catch (e) {
      console.warn('Attendee registration failed (non-critical):', e);
    }
  }

  // --- REACTION ENGINE ---

  function getOrCreateAnonymousId() {
    let id = localStorage.getItem('wordlyAnonymousId');
    if (!id) {
      id = 'user-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
      localStorage.setItem('wordlyAnonymousId', id);
    }
    return id;
  }

  // Default emoji set — overridden by session config if set
  const DEFAULT_EMOJIS = ['👍', '👎', '❤️', '🤔', '❓'];
  let activeEmojis = [...DEFAULT_EMOJIS];

  function buildReactionDialog(emojis) {
    if (!reactionDialog) return;
    reactionDialog.innerHTML = '';
    emojis.forEach(emoji => {
      const btn = document.createElement('button');
      btn.textContent = emoji;
      btn.dataset.emoji = emoji;
      btn.addEventListener('click', () => handleReactionClick(emoji));
      reactionDialog.appendChild(btn);
    });
    if (dialogOverlay) dialogOverlay.addEventListener('click', hideReactionDialog);
  }

  function setupReactionListeners() {
    buildReactionDialog(activeEmojis);
  }

  // Watch session doc for emoji config changes
  function setupEmojiListener() {
    if (!window.appDb || !window.firestore || !window.firestore.doc || !state.sessionId) return;
    const sessionRef = window.firestore.doc(window.appDb, 'sessions', state.sessionId);
    window.firestore.onSnapshot(sessionRef, (snap) => {
      if (!snap.exists()) return;
      const data = snap.data();
      const emojis = Array.isArray(data.reaction_emojis) && data.reaction_emojis.length > 0
        ? data.reaction_emojis
        : DEFAULT_EMOJIS;
      if (JSON.stringify(emojis) !== JSON.stringify(activeEmojis)) {
        activeEmojis = emojis;
        buildReactionDialog(activeEmojis);
      }
    });
  }

  function showReactionDialog(utteranceData) {
    activeUtteranceData = utteranceData;
    reactionDialog.style.display = 'flex';
    dialogOverlay.style.display = 'block';
  }

  function hideReactionDialog() {
    reactionDialog.style.display = 'none';
    dialogOverlay.style.display = 'none';
    activeUtteranceData = null;
  }

  function handleReactionClick(reactionType) {
    if (!activeUtteranceData) return;
    const phraseId = activeUtteranceData.phraseId;
    // Capture before hideReactionDialog nulls it
    const capturedUtteranceData = activeUtteranceData;

    // v20: track locally regardless of whether backend accepts it
    if (!state.myReactions[phraseId]) {
      state.myReactions[phraseId] = new Set();
    }
    const alreadyReacted = state.myReactions[phraseId].has(reactionType);
    state.myReactions[phraseId].add(reactionType);

    updateBubbleReactionDisplay(phraseId);
    hideReactionDialog();

    if (alreadyReacted) {
      showNotification(`You already reacted with ${reactionType}`, 'info');
      return;
    }

    sendReactionToFirebase(reactionType, capturedUtteranceData);
  }

  async function sendReactionToFirebase(reactionType, utteranceData) {
    if (!utteranceData || !state.sessionId) return;
    const anonymousId = getOrCreateAnonymousId();
    const payload = {
      session_id:     state.sessionId,
      utterance_guid: utteranceData.phraseId,
      reaction_type:  reactionType,
      text:           utteranceData.translatedText || '',
      language:       utteranceData.translatedLanguageCode || languageSelect.value || 'en',
      anonymous_id:   anonymousId
    };
    try {
      const response = await fetch(ADD_REACTION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (response.ok) {
        showNotification(`${reactionType} sent!`, 'success');
      } else {
        const errorText = await response.text();
        console.error('Reaction error:', errorText);
        showNotification('Could not send reaction.', 'error');
      }
    } catch (error) {
      console.error('Network error sending reaction:', error);
      showNotification('Network error. Reaction not sent.', 'error');
    }
  }

  function setupMessageListener() {
    if (messageListenerUnsubscribe) {
      messageListenerUnsubscribe();
      messageListenerUnsubscribe = null;
    }
    const waitForFirebase = setInterval(() => {
      if (window.appDb && window.firestore) {
        clearInterval(waitForFirebase);
        const anonymousId = getOrCreateAnonymousId();
        const messagesPath = `sessions/${state.sessionId}/participants/${anonymousId}/messages`;
        const messagesRef = window.firestore.collection(window.appDb, messagesPath);
        messageListenerUnsubscribe = window.firestore.onSnapshot(messagesRef, (snapshot) => {
          snapshot.docChanges().forEach((change) => {
            if (change.type === 'added') {
              const data = change.doc.data();
              if (data.persistent) {
                showPersistentNotification(data.message, data.link || null);
              } else {
                showNotification(data.message, 'info', 8000);
              }
            }
          });
        }, (error) => {
          console.error('Message listener error:', error);
        });
      }
    }, 200);
    setTimeout(() => clearInterval(waitForFirebase), 10000);
  }

  // --- v24: LIVE REACTIONS ---

  function setupLiveReactionsListener() {
    // Watch the session doc for the show_reactions flag
    const waitForFirebase = setInterval(() => {
      if (window.appDb && window.firestore && window.firestore.doc) {
        clearInterval(waitForFirebase);
        const sessionRef = window.firestore.doc(window.appDb, 'sessions', state.sessionId);
        sessionFlagListener = window.firestore.onSnapshot(sessionRef, (snap) => {
          if (!snap.exists()) return;
          const newVal = snap.data().show_reactions === true;
          if (newVal !== showLiveReactions) {
            showLiveReactions = newVal;
            if (!showLiveReactions) {
              // Turned off — remove all reaction bars
              teardownAllUtteranceListeners();
              document.querySelectorAll('.phrase-reaction-bar').forEach(el => el.remove());
              document.querySelectorAll('.reaction-hint').forEach(el => { el.style.display = ''; });
            } else {
              // Turned on — attach listeners to existing phrases
              document.querySelectorAll('.phrase[id^="phrase-"]').forEach(el => {
                const phraseId = el.id.replace('phrase-', '');
                attachUtteranceListener(phraseId, el);
              });
            }
          }
        });
      }
    }, 200);
    setTimeout(() => clearInterval(waitForFirebase), 10000);
  }

  function attachUtteranceListener(phraseId, phraseEl) {
    if (!showLiveReactions) return;
    if (utteranceListeners[phraseId]) return; // already listening
    if (!window.appDb || !window.firestore || !window.firestore.doc) return;

    const utteranceRef = window.firestore.doc(
      window.appDb, 'sessions', state.sessionId, 'utterances', phraseId
    );

    const unsub = window.firestore.onSnapshot(utteranceRef, (snap) => {
      if (!snap.exists()) return;
      renderReactionBar(phraseId, snap.data());
    });

    utteranceListeners[phraseId] = unsub;

    // Enforce max listeners — remove oldest if over limit
    const ids = Object.keys(utteranceListeners);
    if (ids.length > MAX_UTTERANCE_LISTENERS) {
      const oldest = ids[0];
      utteranceListeners[oldest]();
      delete utteranceListeners[oldest];
    }
  }

  function teardownAllUtteranceListeners() {
    Object.values(utteranceListeners).forEach(unsub => unsub());
    Object.keys(utteranceListeners).forEach(k => delete utteranceListeners[k]);
  }

  function renderReactionBar(phraseId, data) {
    const phraseEl = document.getElementById(`phrase-${phraseId}`);
    if (!phraseEl) return;

    const myReactionsForThis = state.myReactions[phraseId] || new Set();
    const hint = phraseEl.querySelector('.reaction-hint');

    // Map each active emoji to its Firestore field key
    const EMOJI_KEY_MAP = {
      '👍': 'reaction_thumbs_up',
      '👎': 'reaction_thumbs_down',
      '❤️': 'reaction_heart',
      '🤔': 'reaction_thinking',
      '❓': 'reaction_question',
    };
    const EMOJIS = activeEmojis.map(emoji => ({
      key: EMOJI_KEY_MAP[emoji] || `reaction_${emoji.codePointAt(0)}`,
      emoji
    }));

    const hasAnyReactions = EMOJIS.some(e => (data[e.key] || 0) > 0);

    // Remove old bar
    const existingBar = phraseEl.querySelector('.phrase-reaction-bar');
    if (existingBar) existingBar.remove();

    if (!hasAnyReactions) {
      // No reactions — show hint
      if (hint) hint.style.display = '';
      return;
    }

    // Has reactions — hide hint, show chips
    if (hint) hint.style.display = 'none';

    const bar = document.createElement('div');
    bar.className = 'phrase-reaction-bar';

    EMOJIS.forEach(({ key, emoji }) => {
      const count = data[key] || 0;
      if (count === 0) return;
      const isMine = myReactionsForThis.has(emoji);
      const chip = document.createElement('span');
      chip.className = `reaction-live-chip${isMine ? ' mine' : ''}`;
      chip.innerHTML = `${emoji}<span class="chip-count">${count}</span>`;
      bar.appendChild(chip);
    });

    phraseEl.appendChild(bar);
  }

  // END v24
  function processAudioQueue() {
    if (state.isPlayingAudio || !state.audioEnabled || state.audioQueue.length === 0) return;
    state.isPlayingAudio = true;
    const audioItem = state.audioQueue.shift();
    const blob = new Blob([new Uint8Array(audioItem.data)], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const phraseElement = document.getElementById(`phrase-${audioItem.phraseId}`);
    if (phraseElement) {
      const playing = transcriptArea.querySelector('.phrase-playing');
      if (playing) playing.classList.remove('phrase-playing');
      phraseElement.classList.add('phrase-playing');
    }
    mainAudioPlayer.src = url;
    mainAudioPlayer.play().catch(handleAudioError);
  }

  function onAudioEnded() {
    state.isPlayingAudio = false;
    const playingElement = transcriptArea.querySelector('.phrase-playing');
    if (playingElement) playingElement.classList.remove('phrase-playing');
    if (mainAudioPlayer.src.startsWith('blob:')) URL.revokeObjectURL(mainAudioPlayer.src);
    processAudioQueue();
  }

  function handleAudioError(e) { console.error("Audio playback error:", e); onAudioEnded(); }

  function stopAndClearAudio() {
    mainAudioPlayer.pause();
    mainAudioPlayer.src = "";
    state.audioQueue = [];
    state.isPlayingAudio = false;
    const playingElement = transcriptArea.querySelector('.phrase-playing');
    if (playingElement) playingElement.classList.remove('phrase-playing');
  }

  function sendVoiceRequest(enabled) {
    if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
      state.websocket.send(JSON.stringify({ type: 'voice', enabled }));
    }
  }

  // --- UI UTILITIES ---
  function updateStatus(status) { connectionStatusLight.className = `status-light ${status}`; }

  function handleScrollDirectionToggle() {
    resetHeaderCollapseTimer();
    state.scrollDirection = state.scrollDirection === 'down' ? 'up' : 'down';
    const icon = scrollDirectionBtn.querySelector('.text-flow-icon');
    icon.innerHTML = state.scrollDirection === 'down' ? 'T&darr;' : 'T&uarr;';
    const children = Array.from(transcriptArea.children);
    children.reverse().forEach(child => transcriptArea.appendChild(child));
    if (state.scrollDirection === 'down') { scrollToTranscriptBottom(); } else { scrollToTranscriptTop(); }
  }

  function populateLanguageSelect(selectElement, selectedLanguage) { if (!selectElement) return; selectElement.innerHTML = ''; Object.entries(languageMap).forEach(([code, name]) => { const option = document.createElement('option'); option.value = code; option.textContent = name; selectElement.appendChild(option); }); selectElement.value = selectedLanguage; }
  async function handleWakeLockButtonClick() { resetHeaderCollapseTimer(); if (screenWakeLock) { await releaseWakeLock(); } else { await requestWakeLock(); } }
  async function requestWakeLock() { try { screenWakeLock = await navigator.wakeLock.request('screen'); wakeLockBtn.classList.add('active'); showNotification('Screen will stay on.', 'info'); screenWakeLock.addEventListener('release', () => { wakeLockBtn.classList.remove('active'); screenWakeLock = null; }); } catch (err) { showNotification('Could not activate screen lock.', 'error'); } }
  async function releaseWakeLock() { if (screenWakeLock) { await screenWakeLock.release(); screenWakeLock = null; showNotification('Screen lock released.', 'info'); } }
  function toggleContentVisibility() { resetHeaderCollapseTimer(); state.contentHidden = !state.contentHidden; mainContent.classList.toggle('transcript-hidden', state.contentHidden); collapseBtn.textContent = state.contentHidden ? 'View Text' : 'Hide Text'; }
  function toggleHeaderCollapseManual() { clearTimeout(state.headerCollapseTimeout); state.headerCollapsed = !state.headerCollapsed; appHeader.classList.toggle('collapsed', state.headerCollapsed); if (!state.headerCollapsed) { resetHeaderCollapseTimer(); } }
  function resetHeaderCollapseTimer() { clearTimeout(state.headerCollapseTimeout); if (state.headerCollapsed) { state.headerCollapsed = false; appHeader.classList.remove('collapsed'); } state.headerCollapseTimeout = setTimeout(() => { if (!state.headerCollapsed && document.visibilityState === 'visible') { state.headerCollapsed = true; appHeader.classList.add('collapsed'); } }, HEADER_AUTO_COLLAPSE_DELAY); }
  function isScrolledToTranscriptBottom() { if (!transcriptArea) return true; const { scrollTop, scrollHeight, clientHeight } = transcriptArea; if (clientHeight === 0) return true; return scrollHeight - Math.ceil(scrollTop) - clientHeight < 50; }
  function scrollToTranscriptBottom() { if (transcriptArea) { requestAnimationFrame(() => { transcriptArea.scrollTop = transcriptArea.scrollHeight; }); state.userScrolledUp = false; state.newMessagesWhileScrolled = 0; scrollToBottomBtn.style.display = 'none'; } }
  function scrollToTranscriptTop() { if (transcriptArea) { requestAnimationFrame(() => { transcriptArea.scrollTop = 0; }); } }
  function handleTranscriptScroll() { if (!transcriptArea) return; if (state.scrollDirection === 'down') { const isNearBottom = isScrolledToTranscriptBottom(); if (!isNearBottom) { state.userScrolledUp = true; } else { if (state.userScrolledUp) { state.userScrolledUp = false; state.newMessagesWhileScrolled = 0; scrollToBottomBtn.style.display = 'none'; } } } }
  function handleScrollToTranscriptBottomClick() { scrollToTranscriptBottom(); }
  function isValidSessionId(sessionId) { return /^[A-Z0-9]{4}-\d{4}$/.test(sessionId); }
  function formatSessionIdInput(event) { const input = event.target; let value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); let formattedValue = ""; if (value.length > 4) { formattedValue = value.slice(0, 4) + '-' + value.slice(4, 8); } else { formattedValue = value; } if (input.value !== formattedValue) { const start = input.selectionStart; const end = input.selectionEnd; const delta = formattedValue.length - input.value.length; input.value = formattedValue; try { input.setSelectionRange(start + delta, end + delta); } catch (e) {} } }
  function handleTempInputKeydown(event) { if (event.key === 'Enter') { event.preventDefault(); connect(); } }
  function maskSessionId(sessionId) { if (!sessionId || typeof sessionId !== 'string') { return "Unknown Session"; } const parts = sessionId.split('-'); if (parts.length !== 2 || parts[0].length !== 4 || parts[1].length !== 4) { return sessionId; } return `${parts[0].substring(0, 2)}XX-##${parts[1].substring(2, 4)}`; }
  function loadFontSettings() { try { const settings = localStorage.getItem('wordlyViewerFontSettings'); if (settings) { const parsed = JSON.parse(settings); state.fontSize = parsed.size === 'large' ? 'large' : 'normal'; state.fontBold = !!parsed.bold; } } catch (e) { state.fontSize = 'normal'; state.fontBold = false; } applyFontSettings(); }
  function applyFontSettings() { appPage.classList.remove('font-normal', 'font-large', 'font-bold'); appPage.classList.add(state.fontSize === 'large' ? 'font-large' : 'font-normal'); if (state.fontBold) appPage.classList.add('font-bold'); const sizeIcon = fontSizeToggleBtn.querySelector('.font-size-icon'); sizeIcon.innerHTML = state.fontSize === 'normal' ? 'A+' : 'A-'; fontBoldToggleBtn.style.fontWeight = state.fontBold ? 'normal' : 'bold'; fontBoldToggleBtn.classList.toggle('active', state.fontBold); }
  function saveFontSettings() { localStorage.setItem('wordlyViewerFontSettings', JSON.stringify({ size: state.fontSize, bold: state.fontBold })); }
  function handleFontSizeToggle() { resetHeaderCollapseTimer(); state.fontSize = state.fontSize === 'normal' ? 'large' : 'normal'; applyFontSettings(); saveFontSettings(); }
  function handleFontBoldToggle() { resetHeaderCollapseTimer(); state.fontBold = !state.fontBold; applyFontSettings(); saveFontSettings(); }
  function loadThemeSettings() { try { const themeSetting = localStorage.getItem('wordlyViewerTheme'); if (themeSetting) state.darkMode = themeSetting === 'dark'; applyTheme(); } catch (e) {} }
  function applyTheme() { const themeValue = state.darkMode ? 'dark' : 'light'; document.documentElement.setAttribute('data-theme', themeValue); updateThemeIcons(themeToggleBtn); updateThemeIcons(loginThemeToggleBtn); }
  function updateThemeIcons(button) { if (!button) return; const moonIcon = button.querySelector('.moon-icon'); const sunIcon = button.querySelector('.sun-icon'); if (moonIcon && sunIcon) { if (state.darkMode) { moonIcon.style.display = 'none'; sunIcon.style.display = 'block'; } else { moonIcon.style.display = 'block'; sunIcon.style.display = 'none'; } } }
  function saveThemeSettings() { localStorage.setItem('wordlyViewerTheme', state.darkMode ? 'dark' : 'light'); }
  function toggleTheme() { state.darkMode = !state.darkMode; applyTheme(); saveThemeSettings(); showNotification(`${state.darkMode ? 'Dark' : 'Light'} mode enabled`, 'info'); }

  function showNotification(message, type = 'info', duration = 3000) {
    const existing = document.querySelector('.notification');
    if (existing) existing.remove();
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    document.body.appendChild(notification);
    requestAnimationFrame(() => { notification.classList.add('visible'); });
    setTimeout(() => {
      notification.classList.remove('visible');
      setTimeout(() => notification.remove(), 500);
    }, duration - 500);
  }

  // Persistent notification — stays until user taps to dismiss
  function showPersistentNotification(message, link) {
    const existing = document.querySelector('.notification-persistent');
    if (existing) existing.remove();
    const notification = document.createElement('div');
    notification.className = 'notification-persistent info';
    notification.style.cssText = `
      position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
      background: #1a1a2e; color: white; padding: 14px 20px 14px 16px;
      border-radius: 10px; z-index: 9999; max-width: 88vw;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3); font-size: 0.95em;
      display: flex; flex-direction: column; gap: 8px; cursor: pointer;
    `;
    const topRow = document.createElement('div');
    topRow.style.cssText = 'display:flex; align-items:flex-start; gap:12px;';
    topRow.innerHTML = `
      <span style="flex:1; line-height:1.4;">${message}</span>
      <span style="opacity:0.6; font-size:1.2em; flex-shrink:0; margin-top:-1px;">✕</span>
    `;
    notification.appendChild(topRow);

    if (link) {
      const linkEl = document.createElement('a');
      linkEl.href = link;
      linkEl.target = '_blank';
      linkEl.rel = 'noopener noreferrer';
      linkEl.textContent = link.length > 40 ? link.substring(0, 40) + '…' : link;
      linkEl.style.cssText = `
        color: #7ec8e3; font-size: 0.85em; word-break: break-all;
        text-decoration: underline; padding: 6px 10px;
        background: rgba(255,255,255,0.1); border-radius: 6px; display: block;
      `;
      linkEl.addEventListener('click', (e) => e.stopPropagation());
      notification.appendChild(linkEl);
    }

    notification.addEventListener('click', () => notification.remove());
    document.body.appendChild(notification);
  }
});
