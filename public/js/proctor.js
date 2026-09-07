/**
 * Anti-Cheat Exam Proctoring Engine
 * Monitors student focus, enforces fullscreen, detects tab switches/minimization,
 * sounds alert alarm on Strike 1, and destroys iframe + locks out student on Strike 2.
 */

class ExamProctor {
  constructor() {
    this.student = null;
    this.config = null;
    this.ws = null;
    this.strikes = 0;
    this.maxStrikes = 3;
    this.isExamActive = false;
    this.audioCtx = null;
    this.heartbeatInterval = null;
    this.lastViolationTime = 0;
    this.violationCooldownMs = 5000; // 5-second cooldown to prevent duplicate rapid-fire event spam
    this.isWarningModalOpen = false; // Pause violation checks while student reads strike warning modal

    // Detect mobile OS & fullscreen capability
    this.isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    this.isAndroid = /Android/.test(navigator.userAgent);
    this.isMobile = this.isIOS || this.isAndroid || (window.innerWidth <= 768);

    this.isFullscreenSupported = !!(
      document.fullscreenEnabled || 
      document.webkitFullscreenEnabled || 
      document.mozFullScreenEnabled || 
      document.msFullscreenEnabled
    );

    // Google Account Switch state
    this.isSwitchAccountModalOpen = false;
    this.switchAccountUses = 0;
    this.switchAccountTimer = null;
    this.currentAccountIdentifier = 0;

    // Initial 45-second setup buffer & cookie grace period
    this.examStartGraceExpiry = 0;
    this.graceInterval = null;

    // Overlay, Circle to Search & Window-in-Window tracking
    this.lastTouchTime = Date.now();
    this.lastIframeInteractionTime = Date.now();
    this.blurTimer = null;
    this.unfocusedSeconds = 0;
    this.monitorInterval = null;

    // Form submission grace mode
    this.isSubmitGraceActive = false;
    this.submitGraceCountdownInterval = null;

    // Security Exemption flag (bypasses all anti-cheat rules when true)
    this.isExempt = false;

    this.initAudio();
  }

  /* ---------------- Google Account Switch Flow ---------------- */

  /* ---------------- Google Account Switch Flow ---------------- */

  buildFormUrlWithAccount(originalUrl, accountIdentifier) {
    let url = originalUrl || '';
    if (!url) return '';

    // Strip existing _t timestamp
    url = url.replace(/[&?]_t=\d+/g, '');

    if (typeof accountIdentifier === 'number') {
      const idx = accountIdentifier;
      // Handle path /u/X/
      if (/\/forms\/u\/\d+\//.test(url)) {
        url = url.replace(/\/forms\/u\/\d+\//, `/forms/u/${idx}/`);
      } else if (url.includes('/forms/d/')) {
        url = url.replace('/forms/d/', `/forms/u/${idx}/d/`);
      }

      // Handle authuser query param
      if (/[?&]authuser=[^&]+/.test(url)) {
        url = url.replace(/([?&])authuser=[^&]+/, `$1authuser=${idx}`);
      } else {
        url += (url.includes('?') ? '&' : '?') + `authuser=${idx}`;
      }
    } else if (typeof accountIdentifier === 'string' && accountIdentifier.trim()) {
      const email = accountIdentifier.trim();
      const encoded = encodeURIComponent(email);
      if (/[?&]authuser=[^&]+/.test(url)) {
        url = url.replace(/([?&])authuser=[^&]+/, `$1authuser=${encoded}`);
      } else {
        url += (url.includes('?') ? '&' : '?') + `authuser=${encoded}`;
      }
    }

    // Ensure embedded=true
    if (!url.includes('embedded=true')) {
      url += (url.includes('?') ? '&' : '?') + 'embedded=true';
    }

    // Add cache buster
    url += (url.includes('?') ? '&' : '?') + '_t=' + Date.now();
    return url;
  }

  openSwitchAccountModal() {
    if (!this.isExamActive) return;

    const maxAttempts = 3;
    if (this.switchAccountUses >= maxAttempts) {
      if (typeof alert !== 'undefined') {
        alert('You have reached the maximum allowed account switch attempts (' + maxAttempts + ') for this exam.');
      }
      return;
    }

    this.switchAccountUses = (this.switchAccountUses || 0) + 1;
    this.isSwitchAccountModalOpen = true;

    const modal = document.getElementById('switch-account-modal');
    if (modal) modal.classList.remove('hidden');

    const attemptsEl = document.getElementById('switch-account-attempts');
    if (attemptsEl) attemptsEl.textContent = (maxAttempts - this.switchAccountUses);

    // 60-second strict countdown timer to prevent indefinite anti-cheat suspension
    let secondsLeft = 60;
    const countdownEl = document.getElementById('switch-account-countdown');
    if (countdownEl) countdownEl.textContent = secondsLeft;

    if (this.switchAccountTimer) clearInterval(this.switchAccountTimer);
    this.switchAccountTimer = setInterval(() => {
      secondsLeft--;
      if (countdownEl) countdownEl.textContent = secondsLeft;
      if (secondsLeft <= 0) {
        clearInterval(this.switchAccountTimer);
        this.switchAccountTimer = null;
        this.closeSwitchAccountModal();
      }
    }, 1000);
  }

  switchGoogleAccountIndex(index) {
    this.currentAccountIdentifier = index;
    const iframe = document.getElementById('google-form-iframe');
    if (iframe) {
      const base = this.config.formUrl || iframe.src;
      const newUrl = this.buildFormUrlWithAccount(base, index);
      iframe.src = newUrl;
    }
    this.closeSwitchAccountModal();
    this.showToast(`🔄 Form switched to Google Account ${index + 1}`);
  }

  switchGoogleAccountByEmail() {
    const input = document.getElementById('switch-account-email-input');
    const email = input ? input.value.trim() : '';
    if (!email) {
      if (typeof alert !== 'undefined') {
        alert('Please enter your Google email address.');
      }
      return;
    }

    this.currentAccountIdentifier = email;
    const iframe = document.getElementById('google-form-iframe');
    if (iframe) {
      const base = this.config.formUrl || iframe.src;
      const newUrl = this.buildFormUrlWithAccount(base, email);
      iframe.src = newUrl;
    }
    this.closeSwitchAccountModal();
    this.showToast(`🔄 Form switched to Google Account: ${email}`);
  }

  openGoogleAccountWindow() {
    // Open Google AddSession in a new window/tab to allow student to sign in on device
    window.open('https://accounts.google.com/AddSession', '_blank');
  }

  reloadFormWithNewAccount() {
    this.switchGoogleAccountIndex(this.currentAccountIdentifier || 0);
  }

  closeSwitchAccountModal() {
    this.isSwitchAccountModalOpen = false;
    if (this.switchAccountTimer) {
      clearInterval(this.switchAccountTimer);
      this.switchAccountTimer = null;
    }
    this.lastViolationTime = Date.now(); // 5s grace cooldown
    const modal = document.getElementById('switch-account-modal');
    if (modal) modal.classList.add('hidden');
  }

  // Backwards compatibility alias
  requestAccountSwitch() {
    this.openSwitchAccountModal();
  }

  /* ---------------- Initial Setup & Cookie Grace Period (45s) ---------------- */

  startGracePeriod() {
    this.examStartGraceExpiry = Date.now() + 45000;

    const banner = document.getElementById('initial-grace-banner');
    if (banner) banner.classList.remove('hidden');

    let secondsLeft = 45;
    const timerEl = document.getElementById('grace-countdown-seconds');
    if (timerEl) timerEl.textContent = secondsLeft;

    if (this.graceInterval) clearInterval(this.graceInterval);
    this.graceInterval = setInterval(() => {
      secondsLeft--;
      if (timerEl) timerEl.textContent = Math.max(0, secondsLeft);
      if (secondsLeft <= 0) {
        this.endGraceEarly();
      }
    }, 1000);
  }

  endGraceEarly() {
    this.examStartGraceExpiry = 0;
    if (this.graceInterval) {
      clearInterval(this.graceInterval);
      this.graceInterval = null;
    }
    const banner = document.getElementById('initial-grace-banner');
    if (banner) banner.classList.add('hidden');
    this.showToast('🛡️ Exam Anti-Cheat Rules are now ACTIVE');
  }

  /* ---------------- Final Submission Grace Period (60s) ---------------- */

  startSubmissionGrace() {
    if (!this.isExamActive) return;
    this.isSubmitGraceActive = true;
    if (this.blurTimer) {
      clearTimeout(this.blurTimer);
      this.blurTimer = null;
    }
    this.unfocusedSeconds = 0;

    const banner = document.getElementById('submission-grace-banner');
    if (banner) banner.classList.remove('hidden');

    let secondsLeft = 60;
    const timerEl = document.getElementById('submission-grace-countdown');
    if (timerEl) timerEl.textContent = secondsLeft;

    if (this.submitGraceCountdownInterval) clearInterval(this.submitGraceCountdownInterval);
    this.submitGraceCountdownInterval = setInterval(() => {
      secondsLeft--;
      if (timerEl) timerEl.textContent = Math.max(0, secondsLeft);
      if (secondsLeft <= 0) {
        this.endSubmissionGrace();
      }
    }, 1000);
    this.showToast('🔓 Submission Grace Active (60s) - Submit Form Safely');
  }

  endSubmissionGrace() {
    const wasActive = this.isSubmitGraceActive;
    this.isSubmitGraceActive = false;
    if (this.submitGraceCountdownInterval) {
      clearInterval(this.submitGraceCountdownInterval);
      this.submitGraceCountdownInterval = null;
    }
    const banner = document.getElementById('submission-grace-banner');
    if (banner) banner.classList.add('hidden');
    if (wasActive) {
      this.lastViolationTime = Date.now(); // 5s cooldown buffer after ending grace
    }
  }

  showToast(message) {
    let container = document.getElementById('proctor-toast-notification');
    if (!container) {
      container = document.createElement('div');
      container.id = 'proctor-toast-notification';
      container.style.cssText = 'position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%); background: #1e293b; border: 1px solid #3b82f6; color: #93c5fd; padding: 0.6rem 1.25rem; border-radius: 8px; font-size: 0.85rem; font-weight: 600; z-index: 9999; box-shadow: 0 10px 25px rgba(0,0,0,0.5); pointer-events: none; transition: opacity 0.3s ease;';
      document.body.appendChild(container);
    }
    container.textContent = message;
    container.style.opacity = '1';
    clearTimeout(this.toastTimeout);
    this.toastTimeout = setTimeout(() => {
      if (container) container.style.opacity = '0';
    }, 4000);
  }

  // Must be called on user tap/click to unlock mobile browser audio
  unlockAudio() {
    try {
      if (!this.audioCtx) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) this.audioCtx = new AudioContext();
      }
      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }
    } catch (e) {
      console.warn('Audio unlock warning:', e);
    }
  }

  initAudio() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        this.audioCtx = new AudioContext();
      }
    } catch (e) {
      console.warn('Web Audio API not supported in this browser:', e);
    }
  }

  playAlarmSound() {
    if (!this.audioCtx) return;
    try {
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }

      // Play alternating dual-tone emergency siren
      const now = this.audioCtx.currentTime;
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(880, now); // A5
      osc.frequency.setValueAtTime(659, now + 0.15); // E5
      osc.frequency.setValueAtTime(880, now + 0.30);
      osc.frequency.setValueAtTime(659, now + 0.45);
      osc.frequency.setValueAtTime(880, now + 0.60);

      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.85);

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);

      osc.start(now);
      osc.stop(now + 0.85);
    } catch (e) {
      console.error('Error playing alarm tone:', e);
    }
  }

  async startExam(studentData, examConfig) {
    this.student = studentData;
    this.config = examConfig;
    this.maxStrikes = examConfig.maxStrikes || 3;
    this.strikes = studentData.strikes || 0;
    this.isExempt = !!studentData.exempt;

    // Connect real-time WebSocket
    this.connectWebSocket();

    // Check if student was already terminated
    if ((this.student.status === 'terminated' || this.strikes >= this.maxStrikes) && !this.isExempt) {
      this.triggerTermination('Prior session terminated due to cheating violations.');
      return;
    }

    // Switch UI to exam room
    document.getElementById('auth-container').classList.add('hidden');
    document.getElementById('exam-viewport').classList.remove('hidden');
    document.getElementById('exam-header').classList.remove('hidden');

    // Update Header
    document.getElementById('student-display-name').textContent = this.student.name;
    document.getElementById('student-display-roll').textContent = this.student.rollNo;
    document.getElementById('exam-display-title').textContent = this.config.title || this.config.examTitle || 'College MCQ Examination';
    this.updateStrikeBadge();

    // Embed Google Form
    const iframe = document.getElementById('google-form-iframe');
    let formUrl = this.config.formUrl || '';
    if (formUrl && !formUrl.includes('embedded=true')) {
      formUrl += (formUrl.includes('?') ? '&' : '?') + 'embedded=true';
    }
    iframe.src = formUrl;

    // Request Fullscreen if supported (Android, Desktop)
    if (this.isFullscreenSupported && !this.isMobile) {
      await this.requestFullscreen();
    } else {
      // On iOS Safari, Fullscreen API on regular HTML elements is not supported.
      // We automatically scroll to hide address bar and engage Mobile Safe Lock.
      window.scrollTo(0, 1);
    }

    // Start anti-cheat listeners & security monitor
    this.isExamActive = true;
    this.isSubmitGraceActive = false;
    this.lastViolationTime = 0;
    this.bindAntiCheatListeners();
    this.startSecurityMonitor();
    this.startTimer(this.config.durationMinutes || 60);

    // Start 45-second setup & cookie grace period
    this.startGracePeriod();
  }

  async requestFullscreen() {
    const el = document.documentElement;
    try {
      if (el.requestFullscreen) {
        await el.requestFullscreen();
      } else if (el.webkitRequestFullscreen) {
        await el.webkitRequestFullscreen();
      } else if (el.msRequestFullscreen) {
        await el.msRequestFullscreen();
      }
    } catch (err) {
      console.warn('Fullscreen request rejected or deferred by browser:', err.message);
    }
  }

  bindAntiCheatListeners() {
    // 0. User Interaction Tracking
    window.addEventListener('touchstart', () => {
      this.lastTouchTime = Date.now();
    }, { capture: true, passive: true });

    window.addEventListener('pointerdown', () => {
      this.lastTouchTime = Date.now();
    }, { capture: true, passive: true });

    // Track interactions with iframe and its container to prevent false strikes on form actions & submission alerts
    const trackIframeInteraction = () => {
      this.lastIframeInteractionTime = Date.now();
      if (this.blurTimer) {
        clearTimeout(this.blurTimer);
        this.blurTimer = null;
      }
      this.unfocusedSeconds = 0;
    };

    const iframe = document.getElementById('google-form-iframe');
    const iframeContainer = document.querySelector('.iframe-container');
    if (iframeContainer && typeof iframeContainer.addEventListener === 'function') {
      iframeContainer.addEventListener('mouseenter', trackIframeInteraction, { passive: true });
      iframeContainer.addEventListener('mousemove', trackIframeInteraction, { passive: true });
      iframeContainer.addEventListener('pointerdown', trackIframeInteraction, { passive: true });
      iframeContainer.addEventListener('touchstart', trackIframeInteraction, { passive: true });
    }
    if (iframe && typeof iframe.addEventListener === 'function') {
      iframe.addEventListener('load', trackIframeInteraction);
    }

    // 1. Page Visibility (The rock-solid standard for Tab Switch / App Minimize / Swiping to Home)
    // Works reliably on Android, iOS, Windows, Mac, Linux.
    // Does not falsely trigger when clicking iframe, scrolling, or selecting MCQ options!
    const handleVisibility = () => {
      if (!this.isExamActive) return;
      if (this.isWarningModalOpen) return;
      if (this.isSwitchAccountModalOpen) return;
      if (Date.now() < this.examStartGraceExpiry) return;

      const isHidden = document.visibilityState === 'hidden' || document.webkitVisibilityState === 'hidden';
      if (isHidden) {
        this.reportViolation('App Minimized / Tab Switched', 'Page visibility changed to hidden');
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    document.addEventListener('webkitvisibilitychange', handleVisibility);

    // 1b. Window Blur & External Overlay Detector (Catches Circle to Search, Select to Search, Overlays everywhere)
    window.addEventListener('blur', () => {
      if (!this.isExamActive) return;
      if (this.isWarningModalOpen) return;
      if (this.isSwitchAccountModalOpen) return;
      if (this.isSubmitGraceActive) return;
      if (Date.now() < this.examStartGraceExpiry) return;
      if (this.isExempt) return;

      if (this.blurTimer) clearTimeout(this.blurTimer);

      // Verify after 5000ms:
      // - If student clicked Submit on Google Form, native browser confirm dialog takes 1-3s;
      //   when closed, window focus fires immediately and clears this timer!
      // - If student triggered Circle to Search, Select to Search, or external overlay/app,
      //   the overlay remains active for >= 5s, triggering violation!
      this.blurTimer = setTimeout(() => {
        if (!this.isExamActive) return;
        if (this.isWarningModalOpen) return;
        if (this.isSwitchAccountModalOpen) return;
        if (this.isSubmitGraceActive) return;
        if (Date.now() < this.examStartGraceExpiry) return;
        if (this.isExempt) return;

        const isKeyboard = window.visualViewport && (window.visualViewport.height < window.innerHeight * 0.80);
        if (isKeyboard) return; // Legitimate virtual keyboard typing

        const hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : true;

        if (!hasFocus && document.visibilityState === 'visible') {
          this.reportViolation(
            'Circle to Search / External Overlay Detected',
            'Browser lost focus to Circle to Search, search overlay, or floating app'
          );
        }
      }, 5000);
    });

    window.addEventListener('focus', () => {
      if (this.blurTimer) {
        clearTimeout(this.blurTimer);
        this.blurTimer = null;
      }
      this.unfocusedSeconds = 0;
    });

    // 1c. Viewport Resize & Window-in-Window / Split-Screen Detector
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        this.checkWindowInWindow();
      }, 300);
    });

    // 1d. Picture-in-Picture Detector
    document.addEventListener('enterpictureinpicture', () => {
      if (this.isExamActive && !this.isExempt) {
        this.reportViolation('Picture-in-Picture Mode Detected', 'Exam entered Picture-in-Picture window mode');
      }
    });

    // 2. Mobile Pagehide Event (Triggered reliably on iOS Safari & Android when switching apps)
    window.addEventListener('pagehide', () => {
      if (!this.isExamActive) return;
      if (this.isWarningModalOpen) return;
      if (this.isSwitchAccountModalOpen) return;
      if (Date.now() < this.examStartGraceExpiry) return;
      this.reportViolation('App Minimized / Left Browser', 'User minimized browser or opened another mobile app');
    });

    // 3. Block text selection gestures in the outer exam wrapper
    window.addEventListener('selectstart', (e) => {
      if (this.isExamActive && e.target && !e.target.closest('#google-form-iframe')) {
        e.preventDefault();
        return false;
      }
    });

    // 4. Desktop Fullscreen Exit Detection
    // On mobile devices, virtual keyboards alter viewport geometry so fullscreenchange is not used
    if (!this.isMobile && this.isFullscreenSupported) {
      const handleFullscreenChange = () => {
        if (!this.isExamActive) return;
        if (this.isWarningModalOpen) return;
        if (this.isSwitchAccountModalOpen) return;
        if (Date.now() < this.examStartGraceExpiry) return;
        const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
        if (!isFullscreen) {
          this.reportViolation('Exited Fullscreen Mode', 'User exited full-screen view');
        }
      };
      document.addEventListener('fullscreenchange', handleFullscreenChange);
      document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    }

    // 5. Keyboard Shortcuts & DevTools Blocking
    window.addEventListener('keydown', (e) => {
      if (!this.isExamActive) return;

      // F12 or F11 or F5
      if (e.key === 'F12' || e.key === 'F5') {
        e.preventDefault();
        e.stopPropagation();
        this.reportViolation('Blocked Function Key (' + e.key + ')', 'Attempted developer/refresh shortcut');
        return false;
      }

      // Ctrl combinations: Ctrl+Shift+I/J/C, Ctrl+U, Ctrl+R, Ctrl+W, Ctrl+T, Ctrl+N
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (['i', 'j', 'c', 'u', 'r', 'w', 't', 'n', 's', 'p'].includes(k)) {
          e.preventDefault();
          e.stopPropagation();
          this.reportViolation('Blocked Keyboard Shortcut (Ctrl+' + k.toUpperCase() + ')', 'Attempted restricted key combination');
          return false;
        }
      }

      // Alt+Tab interception hint
      if (e.altKey && e.key === 'Tab') {
        e.preventDefault();
        this.reportViolation('Alt+Tab Attempt', 'Attempted application switch');
        return false;
      }
    }, true);

    // 6. Context Menu (Right-Click & Long-Press context menu)
    window.addEventListener('contextmenu', (e) => {
      if (!this.isExamActive) return;
      e.preventDefault();
      return false;
    }, true);

    // 7. Prevent accidental window close / reload
    window.addEventListener('beforeunload', (e) => {
      if (this.isExamActive) {
        e.preventDefault();
        e.returnValue = 'Warning: Leaving will automatically disqualify your examination!';
        return e.returnValue;
      }
    });
  }

  /* ---------------- Window-in-Window & Overlay Monitoring ---------------- */

  checkWindowInWindow() {
    if (!this.isExamActive) return;
    if (this.isWarningModalOpen) return;
    if (this.isSwitchAccountModalOpen) return;
    if (Date.now() < this.examStartGraceExpiry) return;
    if (this.isExempt) return;

    const winW = window.innerWidth;
    const winH = window.innerHeight;

    // Check if virtual keyboard is open (visualViewport height drops significantly)
    const isKeyboard = window.visualViewport && (window.visualViewport.height < winH * 0.80);
    if (isKeyboard) return;

    if (this.isMobile) {
      const screenW = window.screen.width;
      const screenH = window.screen.height;
      const minScreenDim = Math.min(screenW, screenH);
      const maxScreenDim = Math.max(screenW, screenH);

      const isPortrait = winH >= winW;
      const widthRatio = isPortrait ? (winW / minScreenDim) : (winW / maxScreenDim);
      const heightRatio = isPortrait ? (winH / maxScreenDim) : (winH / minScreenDim);

      // 1. Floating Window / Pop-up View (Window-in-Window mode)
      // When the browser is put into a floating pop-up window (Samsung Pop-up, Xiaomi Floating Window, etc.)
      // width is restricted, typically 50%-75% of screen width
      if (widthRatio < 0.82) {
        this.reportViolation(
          'Window-in-Window / Floating Window Detected',
          `Exam window reduced to ${Math.round(widthRatio * 100)}% width (Floating Window Mode)`
        );
        return;
      }

      // 2. Split-Screen Mode
      // In split screen, height is cut in half (< 60% of screen height)
      if (heightRatio < 0.60) {
        this.reportViolation(
          'Split-Screen Mode Detected',
          `Exam viewport height reduced to ${Math.round(heightRatio * 100)}% of screen (Split-Screen Mode)`
        );
        return;
      }
    } else {
      // Desktop: Detect if browser window was shrunk or taken out of fullscreen into split-screen/floating window
      if (this.isFullscreenSupported) {
        const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
        if (!isFullscreen) {
          const screenAvailW = window.screen.availWidth || 1920;
          const screenAvailH = window.screen.availHeight || 1080;
          if (winW < screenAvailW * 0.80 || winH < screenAvailH * 0.75) {
            this.reportViolation(
              'Window-in-Window Mode Detected',
              'Exam browser was shrunk into a window or split-screen view'
            );
          }
        }
      }
    }
  }

  startSecurityMonitor() {
    if (this.monitorInterval) clearInterval(this.monitorInterval);
    this.monitorInterval = setInterval(() => {
      if (!this.isExamActive) return;
      if (this.isWarningModalOpen) return;
      if (this.isSwitchAccountModalOpen) return;
      if (Date.now() < this.examStartGraceExpiry) return;
      if (this.isExempt) return;

      // 1. Viewport dimension check (Split-Screen & Floating Window)
      this.checkWindowInWindow();

      // 2. Continuous Unfocused / Overlay Check (Catches Circle to Search, Select to Search, floating apps everywhere)
      const isKeyboard = window.visualViewport && (window.visualViewport.height < window.innerHeight * 0.80);
      const hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : true;

      // Runs everywhere (Mobile & Desktop) when not in submission grace
      if (!this.isSubmitGraceActive && !hasFocus && !isKeyboard && document.visibilityState === 'visible') {
        this.unfocusedSeconds = (this.unfocusedSeconds || 0) + 1;
        // If an external overlay or search remains active for >= 5 seconds
        if (this.unfocusedSeconds >= 5) {
          this.reportViolation(
            'Circle to Search / External Overlay Detected',
            'External search overlay or floating window active over exam'
          );
          this.unfocusedSeconds = 0;
        }
      } else {
        this.unfocusedSeconds = 0;
      }
    }, 1000);
  }

  reportViolation(type, details) {
    if (!this.isExamActive) return;
    if (this.isWarningModalOpen) return;
    if (this.isSwitchAccountModalOpen) return;
    if (this.isSubmitGraceActive) {
      console.log(`[PROCTOR SUBMIT GRACE] Violation suppressed during final submission grace period: ${type}`);
      return;
    }
    if (Date.now() < this.examStartGraceExpiry) {
      console.log(`[PROCTOR GRACE] Violation suppressed during initial setup grace period: ${type}`);
      return;
    }

    // If student has an active security exemption from the controller, bypass all rules!
    if (this.isExempt) {
      console.log(`[PROCTOR EXEMPT] Violation suppressed for exempt student: ${type}`);
      return;
    }

    const now = Date.now();
    // Debounce to prevent multiple events from a single action (at least 5s cooldown)
    if (now - this.lastViolationTime < this.violationCooldownMs) {
      return;
    }
    this.lastViolationTime = now;

    this.strikes++;
    this.updateStrikeBadge();
    this.playAlarmSound();

    // Send violation via WebSocket or fallback REST
    const payload = {
      type: 'VIOLATION',
      studentId: this.student.id,
      violationType: type,
      details: details
    };

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    } else {
      // Fallback REST call
      fetch('/api/violation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(err => console.error('Failed to log violation:', err));
    }

    if (this.strikes >= this.maxStrikes) {
      this.triggerTermination(type);
    } else {
      this.showWarningModal(type);
    }
  }

  showWarningModal(reason) {
    this.isWarningModalOpen = true;
    const modal = document.getElementById('warning-modal');
    document.getElementById('warning-reason-text').textContent = reason;
    document.getElementById('strike-count-text').textContent = `${this.strikes} OF ${this.maxStrikes}`;

    const subtext = document.getElementById('warning-subtext');
    if (subtext) {
      const remaining = this.maxStrikes - this.strikes;
      if (remaining === 1) {
        subtext.innerHTML = `Your action has been logged on the Proctor's live monitor.<br><strong style="color: #ef4444;">⚠️ FINAL WARNING: Next infraction will immediately terminate your exam and forfeit your submission!</strong>`;
      } else {
        subtext.innerHTML = `Your action has been logged on the Proctor's live monitor.<br><strong>${remaining} warning${remaining > 1 ? 's' : ''} remaining before automatic disqualification!</strong>`;
      }
    }

    modal.classList.remove('hidden');
  }

  dismissWarning() {
    this.isWarningModalOpen = false;
    this.lastViolationTime = Date.now(); // Reset cooldown to give grace period upon dismissing
    document.getElementById('warning-modal').classList.add('hidden');
    // Force re-enter fullscreen
    if (!this.isMobile && this.isFullscreenSupported) {
      this.requestFullscreen();
    }
  }

  triggerTermination(reason) {
    this.isExamActive = false;
    this.endSubmissionGrace();
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    if (this.blurTimer) {
      clearTimeout(this.blurTimer);
      this.blurTimer = null;
    }

    // 1. Immediately wipe the Google Form iframe from DOM so questions can never be viewed/answered
    const iframeContainer = document.querySelector('.iframe-container');
    if (iframeContainer) {
      iframeContainer.innerHTML = `
        <div style="padding: 3rem; text-align: center; color: #ef4444; font-weight: bold;">
          <h2>Access Revoked: Exam Form Removed by Proctor Engine</h2>
        </div>
      `;
    }

    // 2. Hide modals and exam header
    document.getElementById('warning-modal').classList.add('hidden');
    document.getElementById('exam-viewport').classList.add('hidden');
    document.getElementById('exam-header').classList.add('hidden');

    // 3. Show Termination / Disqualification Screen
    const termScreen = document.getElementById('termination-screen');
    document.getElementById('term-student-name').textContent = this.student.name;
    document.getElementById('term-student-roll').textContent = this.student.rollNo;
    document.getElementById('term-reason').textContent = reason || 'Exceeded security strike limit';
    document.getElementById('term-time').textContent = new Date().toLocaleString();
    termScreen.classList.remove('hidden');

    // Exit fullscreen
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
  }

  completeExam() {
    this.endSubmissionGrace();
    const confirmMessage = this.isTimeOver
      ? "Did you click the 'Submit' button on your Google Form?\n\nClick OK to finalize your submission and exit the exam."
      : "Are you sure you have submitted your answers on the Google Form?\n\nThis will finalize your test session. Proceed?";

    if (!confirm(confirmMessage)) {
      return;
    }

    this.isExamActive = false;
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    if (this.blurTimer) {
      clearTimeout(this.blurTimer);
      this.blurTimer = null;
    }
    fetch('/api/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentId: this.student.id })
    }).finally(() => {
      document.getElementById('exam-viewport').classList.add('hidden');
      document.getElementById('exam-header').classList.add('hidden');
      document.getElementById('success-screen').classList.remove('hidden');
      document.getElementById('success-name').textContent = this.student.name;
      document.getElementById('success-roll').textContent = this.student.rollNo;
      document.getElementById('success-time').textContent = new Date().toLocaleString();

      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
    });
  }

  handleExamTimeOver() {
    this.isTimeOver = true;
    const timerDisplay = document.getElementById('exam-timer');
    if (timerDisplay) {
      timerDisplay.textContent = '⏰ TIME EXPIRED';
      timerDisplay.style.backgroundColor = 'rgba(239, 68, 68, 0.3)';
      timerDisplay.style.color = '#f87171';
    }

    this.playAlarmSound();

    // Show the "Exam Time Has Ended" Modal
    const modal = document.getElementById('time-over-modal');
    if (modal) modal.classList.remove('hidden');
  }

  proceedToFormSubmission() {
    // Hide the time-over modal
    const modal = document.getElementById('time-over-modal');
    if (modal) modal.classList.add('hidden');

    // Show top lock banner & question lock mask
    const banner = document.getElementById('submission-lock-banner');
    if (banner) banner.classList.remove('hidden');

    const overlay = document.getElementById('question-blocker-overlay');
    if (overlay) overlay.classList.remove('hidden');

    // Hide account switch button in footer
    const switchBtn = document.querySelector('button[onclick*="requestAccountSwitch"]');
    if (switchBtn) switchBtn.style.display = 'none';

    // Update the footer submit button to a prominent confirmation
    const submitBtn = document.querySelector('button[onclick*="completeExam"]');
    if (submitBtn) {
      submitBtn.innerHTML = '✓ I Have Clicked Submit on Google Form';
      submitBtn.style.padding = '0.55rem 1.25rem';
      submitBtn.style.fontSize = '0.9rem';
      submitBtn.className = 'btn btn-success';
    }
  }

  notifyQuestionLocked() {
    alert('🔒 EXAM TIME HAS ENDED!\n\nQuestion answering is locked. Please scroll down to the bottom of the screen to click the "Submit" button.');
  }

  updateStrikeBadge() {
    const badge = document.getElementById('strike-badge');
    if (badge) {
      badge.style.border = '';
      badge.innerHTML = `<span class="dot-pulse"></span> STRIKES: ${this.strikes} / ${this.maxStrikes}`;
      if (this.strikes === 0) {
        badge.className = 'badge badge-live';
        badge.style.backgroundColor = '';
        badge.style.color = '';
      } else if (this.strikes === 1) {
        badge.className = 'badge badge-warning';
        badge.style.backgroundColor = 'rgba(245, 158, 11, 0.2)';
        badge.style.color = '#fbbf24';
      } else if (this.strikes === 2) {
        badge.className = 'badge badge-warning';
        badge.style.backgroundColor = 'rgba(239, 68, 68, 0.25)';
        badge.style.color = '#f87171';
      } else {
        badge.className = 'badge badge-danger';
        badge.style.backgroundColor = 'rgba(239, 68, 68, 0.4)';
        badge.style.color = '#fca5a5';
      }
    }
  }

  startTimer(minutes) {
    let secondsLeft = minutes * 60;
    const timerDisplay = document.getElementById('exam-timer');
    if (!timerDisplay) return;

    const timerInterval = setInterval(() => {
      if (!this.isExamActive) {
        clearInterval(timerInterval);
        return;
      }
      secondsLeft--;
      if (secondsLeft <= 0) {
        clearInterval(timerInterval);
        this.handleExamTimeOver();
        return;
      }

      const m = Math.floor(secondsLeft / 60);
      const s = secondsLeft % 60;
      timerDisplay.textContent = `⏱️ ${m}:${s < 10 ? '0' : ''}${s}`;
    }, 1000);
  }

  connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.ws.send(JSON.stringify({
        type: 'IDENTIFY',
        role: 'student',
        studentId: this.student.id,
        examId: this.student.examId || (this.config && this.config.id)
      }));

      // Start periodic ping heartbeat every 10s
      if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'PING' }));
        }
      }, 10000);
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'TERMINATE') {
          if (!this.isExempt) {
            this.triggerTermination(data.reason);
          }
        } else if (data.type === 'PARDONED') {
          this.strikes = 0;
          this.updateStrikeBadge();
          this.showAnnouncement('Notice: The exam invigilator has pardoned your security strikes. Continue your exam carefully.');
          if (!this.isExamActive) {
            window.location.reload();
          }
        } else if (data.type === 'SECURITY_EXEMPTION') {
          this.isExempt = !!data.exempt;
          this.updateStrikeBadge();
          if (this.isExempt) {
            // Silently dismiss warning modal if open
            this.isWarningModalOpen = false;
            const warnModal = document.getElementById('warning-modal');
            if (warnModal) warnModal.classList.add('hidden');

            // If screen was terminated, silently restore exam
            const termScreen = document.getElementById('termination-screen');
            if (termScreen && !termScreen.classList.contains('hidden')) {
              termScreen.classList.add('hidden');
              this.isExamActive = true;
              const iframe = document.getElementById('google-form-iframe');
              if (iframe && (!iframe.src || iframe.src === 'about:blank')) {
                iframe.src = this.config.formUrl || 'about:blank';
              }
            }
          }
        } else if (data.type === 'ANNOUNCEMENT') {
          this.showAnnouncement(data.message);
        }
      } catch (err) {
        console.error('Error handling WS message:', err);
      }
    };

    this.ws.onclose = () => {
      if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
      // Reconnect after 3s if exam is still active
      if (this.isExamActive) {
        setTimeout(() => this.connectWebSocket(), 3000);
      }
    };
  }

  showAnnouncement(message) {
    let container = document.getElementById('proctor-announcement-toast');
    if (!container) {
      container = document.createElement('div');
      container.id = 'proctor-announcement-toast';
      container.className = 'announcement-toast';
      document.body.appendChild(container);
    }
    container.innerHTML = `
      <div class="announcement-card">
        <div style="font-size: 1.5rem; margin-right: 0.75rem;">📢</div>
        <div style="flex: 1;">
          <div style="font-size: 0.75rem; font-weight: 700; text-transform: uppercase; color: #60a5fa; letter-spacing: 0.05em; margin-bottom: 0.2rem;">Invigilator Announcement</div>
          <div style="font-size: 0.9rem; color: #f8fafc; line-height: 1.4;">${this.escapeHtml(message)}</div>
        </div>
        <button type="button" class="announcement-close-btn" onclick="this.closest('.announcement-toast').remove()">✕</button>
      </div>
    `;
    this.playAlarmSound();

    // Auto-dismiss after 15 seconds if not closed
    setTimeout(() => {
      const el = document.getElementById('proctor-announcement-toast');
      if (el) el.remove();
    }, 15000);
  }

  escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}

window.proctor = new ExamProctor();

