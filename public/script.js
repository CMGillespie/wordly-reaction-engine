// Wordly Secure Viewer Script (v19 - Reaction Engine + Background Persistence)
// v18: Silent audio loop, Media Session API, Page Visibility reconnect
// v19: Reaction engine ported - 5 emojis, anonymous ID, message listener
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

  // --- Reaction Engine DOM Elements ---
  const reactionDialog = document.getElementById('reaction-dialog');
  const dialogOverlay = document.getElementById('dialog-overlay');

  let screenWakeLock = null;
  let activeUtteranceData = null;
  let messageListenerUnsubscribe = null;

  // --- Application State ---
  const state = {
    sessionId: null, passcode: '', websocket: null, audioEnabled: false,
    isPlayingAudio: false, audioQueue: [], reconnectInterval: null,
    isDeliberateDisconnect: false, scrollDirection: 'down',
    headerCollapsed: false, headerCollapseTimeout: null, contentHidden: false,
    userScrolledUp: false, newMessagesWhileScrolled: 0, fontSize: 'normal',
    fontBold: false, darkMode: false,
  };

  const languageMap = { 'af': 'Afrikaans', 'sq': 'Albanian', 'ar': 'Arabic', 'hy': 'Armenian', 'bn': 'Bengali', 'bg': 'Bulgarian', 'zh-HK': 'Cantonese', 'ca': 'Catalan', 'zh-CN': 'Chinese (Simplified)', 'zh-TW': 'Chinese (Traditional)', 'hr': 'Croatian', 'cs': 'Czech', 'da': 'Danish', 'nl': 'Dutch', 'en': 'English (US)', 'en-AU': 'English (AU)', 'en-GB': 'English (UK)', 'et': 'Estonian', 'fi': 'Finnish', 'fr': 'French (FR)', 'fr-CA': 'French (CA)', 'ka': 'Georgian', 'de': 'German', 'el': 'Greek', 'gu': 'Gujarati', 'he': 'Hebrew', 'hi': 'Hindi', 'hu': 'Hungarian', 'is': 'Icelandic', 'id': 'Indonesian', 'ga': 'Irish', 'it': 'Italian', 'ja': 'Japanese', 'kn': 'Kannada', 'ko': 'Korean', 'lv': 'Latvian', 'lt': 'Lithuanian', 'mk': 'Macedonian', 'ms': 'Malay', 'mt': 'Maltese', 'no': 'Norwegian', 'fa': 'Persian', 'pl': 'Polish', 'pt': 'Portuguese (PT)', 'pt-BR': 'Portuguese (BR)', 'ro': 'Romanian', 'ru': 'Russian', 'sr': 'Serbian', 'sk': 'Slovak', 'sl': 'Slovenian', 'es': 'Spanish (ES)', 'es-MX': 'Spanish (MX)', 'sv': 'Swedish', 'tl': 'Tagalog', 'th': 'Thai', 'tr': 'Turkish', 'uk': 'Ukrainian', 'vi': 'Vietnamese', 'cy': 'Welsh', 'pa': 'Punjabi', 'sw': 'Swahili', 'ta': 'Tamil', 'ur': 'Urdu', 'zh': 'Chinese' };
  const rtlLanguages = ['ar', 'he', 'fa', 'ur', 'dv', 'ps', 'yi'];
  const HEADER_AUTO_COLLAPSE_DELAY = 10000;
  const ADD_REACTION_URL = 'https://addreaction-kkcretsy3a-uc.a.run.app';

  // --- v18: BACKGROUND PERSISTENCE ---
  const silentAudio = new Audio();
  silentAudio.src = 'silent.mp3';
  silentAudio.loop = true;
  silentAudio.volume = 0.001;

  function startSilentAudio() {
    if (silentAudio.paused) {
      silentAudio.play().catch(() => {});
    }
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
      console.log('App foregrounded — checking connection.');
      if (wakeLockBtn.classList.contains('active') && !screenWakeLock) {
        requestWakeLock();
      }
      if (state.sessionId && !state.isDeliberateDisconnect) {
        if (!state.websocket || state.websocket.readyState === WebSocket.CLOSED) {
          console.log('WebSocket dead after background — reconnecting.');
          if (state.reconnectInterval) clearInterval(state.reconnectInterval);
          connectWebSocket();
        }
      }
    }
  });
  // --- END v18 ---

  // --- Initialization ---
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

    if (sessionDisplayHeader) {
      sessionDisplayHeader.textContent = `Session: ${maskSessionId(state.sessionId)}`;
    }
    populateLanguageSelect(languageSelect, 'en');

    startSilentAudio();
    setupMediaSession();
    setupMessageListener();
    resetHeaderCollapseTimer();
    connectWebSocket();
  }

  function disconnect() {
    state.isDeliberateDisconnect = true;
    if (state.reconnectInterval) clearInterval(state.reconnectInterval);
    if (state.websocket) state.websocket.close(1000, "User disconnected");
    stopAndClearAudio();
    stopSilentAudio();
    if (messageListenerUnsubscribe) {
      messageListenerUnsubscribe();
      messageListenerUnsubscribe = null;
    }
    appPage.style.display = 'none';
    configInputArea.style.display = 'block';
    updateStatus('disconnected');
  }

  function handleAudioToggle() {
    state.audioEnabled = audioToggle.checked;
    resetHeaderCollapseTimer();
    if (state.audioEnabled) {
      sendVoiceRequest(true);
      processAudioQueue();
    } else {
      sendVoiceRequest(false);
      stopAndClearAudio();
    }
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
          if (message.success) {
            updateStatus('connected');
            if (state.audioEnabled) sendVoiceRequest(true);
          } else { updateStatus('error'); }
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

      if (rtlLanguages.includes(languageSelect.value)) {
        phraseElement.classList.add('rtl');
      }

      phraseElement.innerHTML = `
        <div class="phrase-header">
          <span class="speaker-name">${message.name || `Speaker ${message.speakerId.slice(-4)}`}</span>
        </div>
        <div class="phrase-text"></div>
        <span class="reaction-hint" style="position:absolute; bottom:4px; right:8px; font-size:0.75em; opacity:0.30; pointer-events:none; filter:grayscale(100%);">🙂 •••</span>`;

      // Tap any utterance to react
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
    }
  }

  // --- v19: REACTION ENGINE ---

  function getOrCreateAnonymousId() {
    let id = localStorage.getItem('wordlyAnonymousId');
    if (!id) {
      id = 'user-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
      localStorage.setItem('wordlyAnonymousId', id);
    }
    return id;
  }

  function setupReactionListeners() {
    if (!reactionDialog || !dialogOverlay) return;
    reactionDialog.querySelector('#react-thumbs-up').addEventListener('click',   () => handleReactionClick('👍'));
    reactionDialog.querySelector('#react-thumbs-down').addEventListener('click', () => handleReactionClick('👎'));
    reactionDialog.querySelector('#react-heart').addEventListener('click',       () => handleReactionClick('❤️'));
    reactionDialog.querySelector('#react-thinking').addEventListener('click',    () => handleReactionClick('🤔'));
    reactionDialog.querySelector('#react-question').addEventListener('click',    () => handleReactionClick('❓'));
    dialogOverlay.addEventListener('click', hideReactionDialog);
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
    sendReactionToFirebase(reactionType);
    hideReactionDialog();
  }

  async function sendReactionToFirebase(reactionType) {
    if (!activeUtteranceData || !state.sessionId) return;
    const anonymousId = getOrCreateAnonymousId();
    const payload = {
      session_id:     state.sessionId,
      utterance_guid: activeUtteranceData.phraseId,
      reaction_type:  reactionType,
      text:           activeUtteranceData.translatedText || '',
      language:       activeUtteranceData.translatedLanguageCode || languageSelect.value || 'en',
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
    // Firebase loads async — poll until ready
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
              showNotification(data.message, 'info', 8000);
            }
          });
        }, (error) => {
          console.error('Message listener error:', error);
        });
        console.log(`Message listener active: ${anonymousId} / ${state.sessionId}`);
      }
    }, 200);
    setTimeout(() => clearInterval(waitForFirebase), 10000);
  }

  // --- END v19 ---

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
});
