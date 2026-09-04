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
    this.violationCooldownMs = 2500; // Prevent duplicate rapid-fire event spam

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

    // Google Account switch temporary grace pause
    this.isPausedForAccountSwitch = false;
    this.pauseExpiry = 0;

    // Security Exemption flag (bypasses all anti-cheat rules when true)
    this.isExempt = false;

    this.initAudio();
  }

  // Allow student to safely switch Google accounts without triggering false cheating strikes
  requestAccountSwitch() {
    const msg = "Need to switch your Google account?\n\nThis will temporarily pause proctoring for 60 seconds so you can sign in to your correct Google account, then return here.\n\nProceed?";
    if (!confirm(msg)) return;

    this.isPausedForAccountSwitch = true;
    this.pauseExpiry = Date.now() + 60000;

    // Open Google account chooser in a new tab/window
    window.open('https://accounts.google.com/AccountChooser', '_blank');

    alert("Proctoring paused for 60 seconds.\n\nSwitch your Google account in the newly opened tab, close it, and return here. Your form will refresh automatically.");

    // Reload iframe when student returns
    const reloadForm = () => {
      const iframe = document.getElementById('google-form-iframe');
      if (iframe) {
        iframe.src = iframe.src;
      }
      window.removeEventListener('focus', reloadForm);
    };
    window.addEventListener('focus', reloadForm);

    setTimeout(() => {
      this.isPausedForAccountSwitch = false;
    }, 60000);
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

    // Start anti-cheat listeners
    this.isExamActive = true;
    this.bindAntiCheatListeners();
    this.startTimer(this.config.durationMinutes || 60);
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
    // 1. Page Visibility (The ONLY accurate standard for Tab Switch / App Minimize / Swiping to Home)
    // Works reliably on Android, iOS, Windows, Mac, Linux.
    // DOES NOT trigger when typing in the form, opening keyboard, or receiving notifications!
    const handleVisibility = () => {
      if (!this.isExamActive) return;
      if (this.isPausedForAccountSwitch && Date.now() < this.pauseExpiry) return;

      const isHidden = document.visibilityState === 'hidden' || document.webkitVisibilityState === 'hidden';
      if (isHidden) {
        this.reportViolation('App Minimized / Tab Switched', 'Page visibility changed to hidden');
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    document.addEventListener('webkitvisibilitychange', handleVisibility);

    // 2. Mobile Pagehide Event (Triggered reliably on iOS Safari & Android when switching apps)
    window.addEventListener('pagehide', () => {
      if (!this.isExamActive) return;
      if (this.isPausedForAccountSwitch && Date.now() < this.pauseExpiry) return;
      this.reportViolation('App Minimized / Left Browser', 'User minimized browser or opened another mobile app');
    });

    // 3. Floating Window & Circle-to-Search Guard (Both Desktop and Mobile)
    let blurCheckTimer = null;
    let edgeSwipeTriggered = false;
    let longPressTriggered = false;
    let touchHoldTimer = null;

    // Detect screen-edge swipe gestures (how Xiaomi/Oppo/Samsung/Realme open sidebar floating toolboxes)
    window.addEventListener('touchstart', (e) => {
      if (!this.isExamActive) return;
      const t = e.touches[0];
      if (!t) return;

      // 1. Edge swipe detector: If touch starts within 25px of the left or right edge of the phone
      const edgeThreshold = 25;
      if (t.clientX <= edgeThreshold || t.clientX >= (window.innerWidth - edgeThreshold)) {
        edgeSwipeTriggered = true;
        setTimeout(() => { edgeSwipeTriggered = false; }, 2500);
      }

      // 2. Long-press detector: Holding finger still for > 400ms (how Circle-to-Search / Select-to-Search is triggered)
      clearTimeout(touchHoldTimer);
      touchHoldTimer = setTimeout(() => {
        longPressTriggered = true;
        setTimeout(() => { longPressTriggered = false; }, 2500);
      }, 400);
    }, { passive: true, capture: true });

    window.addEventListener('touchend', () => {
      clearTimeout(touchHoldTimer);
    }, { passive: true, capture: true });

    window.addEventListener('touchcancel', () => {
      clearTimeout(touchHoldTimer);
    }, { passive: true, capture: true });

    // Block text selection gestures in the browser window
    window.addEventListener('selectstart', (e) => {
      if (this.isExamActive) {
        e.preventDefault();
        return false;
      }
    });

    // Smart Window Blur Detector (Works on both Mobile & Desktop):
    // Distinguishes legitimate form filling vs Floating Windows (e.g. Chalo) & Circle to Search
    window.addEventListener('blur', () => {
      if (!this.isExamActive) return;
      if (this.isPausedForAccountSwitch && Date.now() < this.pauseExpiry) return;

      if (blurCheckTimer) clearTimeout(blurCheckTimer);

      // Check after 600ms to allow normal focus shift into the Google Form iframe:
      blurCheckTimer = setTimeout(() => {
        if (!this.isExamActive) return;
        if (this.isPausedForAccountSwitch && Date.now() < this.pauseExpiry) return;

        // Is the virtual keyboard open? (When student is typing in Google Form, visualViewport shrinks by >= 18%)
        const isKeyboardActive = window.visualViewport && (window.visualViewport.height < window.innerHeight * 0.82);

        // If the student is simply typing their name/answers with on-screen keyboard, this is legitimate!
        if (isKeyboardActive) {
          return;
        }

        // Did the student just trigger a sidebar edge swipe (Floating app toolbox)?
        if (edgeSwipeTriggered) {
          this.reportViolation('Floating Window / Sidebar App Detected', 'Sidebar toolbox or floating app opened');
          edgeSwipeTriggered = false;
          return;
        }

        // Did the student trigger Circle to Search / Select to Search (long-press text)?
        if (longPressTriggered) {
          this.reportViolation('Circle to Search / Search Overlay Detected', 'Contextual search overlay triggered');
          longPressTriggered = false;
          return;
        }

        // Check if Chrome has lost OS focus:
        const hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : true;

        // If the student opened a floating window (Chalo) or Circle to Search / external app:
        if (!hasFocus) {
          this.reportViolation('External Window / Overlay Detected', 'Browser lost focus to floating app or overlay');
        } else if (!this.isMobile && document.visibilityState === 'hidden') {
          this.reportViolation('Window Focus Lost', 'Switched away from browser window');
        }
      }, 500);
    });

    // 4. Continuous Background & Floating Window Monitor (1-second heartbeat)
    // Catches floating apps, sidebar toolboxes, or search overlays that remain on screen
    setInterval(() => {
      if (!this.isExamActive) return;
      if (this.isPausedForAccountSwitch && Date.now() < this.pauseExpiry) return;

      const hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
      const isKeyboard = window.visualViewport && (window.visualViewport.height < window.innerHeight * 0.82);

      // Diagnostic telemetry sent to proctor server
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'DIAGNOSTIC',
          hasFocus: hasFocus,
          isKeyboard: isKeyboard,
          visibility: document.visibilityState,
          vpRatio: window.visualViewport ? (window.visualViewport.height / window.innerHeight).toFixed(2) : '1.0'
        }));
      }

      // If Chrome has lost OS focus while the virtual keyboard is NOT open
      if (!hasFocus && !isKeyboard) {
        this.unfocusedSeconds = (this.unfocusedSeconds || 0) + 1;
        if (this.unfocusedSeconds >= 2) {
          this.reportViolation('Floating Window / Search Overlay Active', 'External app or search window running over exam');
          this.unfocusedSeconds = 0;
        }
      } else {
        this.unfocusedSeconds = 0;
      }
    }, 1000);

    // 4. Desktop Fullscreen Exit Detection
    // On mobile devices, virtual keyboards alter viewport geometry so fullscreenchange is not used
    if (!this.isMobile && this.isFullscreenSupported) {
      const handleFullscreenChange = () => {
        if (!this.isExamActive) return;
        if (this.isPausedForAccountSwitch && Date.now() < this.pauseExpiry) return;
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

  reportViolation(type, details) {
    // If student has an active security exemption from the controller, bypass all rules!
    if (this.isExempt) {
      console.log(`[PROCTOR EXEMPT] Violation suppressed for exempt student: ${type}`);
      return;
    }

    const now = Date.now();
    // Debounce to prevent multiple events from a single action (e.g. blur + visibilitychange)
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
    const modal = document.getElementById('warning-modal');
    document.getElementById('warning-reason-text').textContent = reason;
    document.getElementById('strike-count-text').textContent = `${this.strikes} OF ${this.maxStrikes}`;

    const subtext = document.getElementById('warning-subtext');
    if (subtext) {
      const remaining = this.maxStrikes - this.strikes;
      if (remaining === 1) {
        subtext.innerHTML = `Your action has been logged on the Proctor's live monitor.<br><strong style="color: #ef4444;">⚠️ FINAL WARNING: Next infraction (Strike 3) will immediately terminate your exam and forfeit your submission!</strong>`;
      } else {
        subtext.innerHTML = `Your action has been logged on the Proctor's live monitor.<br><strong>${remaining} warning${remaining > 1 ? 's' : ''} remaining before automatic disqualification!</strong>`;
      }
    }

    modal.classList.remove('hidden');
  }

  dismissWarning() {
    document.getElementById('warning-modal').classList.add('hidden');
    // Force re-enter fullscreen
    this.requestFullscreen();
  }

  triggerTermination(reason) {
    this.isExamActive = false;

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
    const confirmMessage = this.isTimeOver
      ? "Did you click the 'Submit' button on your Google Form?\n\nClick OK to finalize your submission and exit the exam."
      : "Are you sure you have submitted your answers on the Google Form?\n\nThis will finalize your test session. Proceed?";

    if (!confirm(confirmMessage)) {
      return;
    }

    this.isExamActive = false;
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
          alert('Notice: The exam invigilator has pardoned your security strikes. Continue your exam carefully.');
          if (!this.isExamActive) {
            window.location.reload();
          }
        } else if (data.type === 'SECURITY_EXEMPTION') {
          this.isExempt = !!data.exempt;
          this.updateStrikeBadge();
          if (this.isExempt) {
            // Silently dismiss warning modal if open
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
          alert(`📢 PROCTOR ANNOUNCEMENT:\n\n${data.message}`);
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
}

window.proctor = new ExamProctor();

