/**
 * Teacher / Proctor Command Center Script
 * Multi-Exam & Real-Time Monitoring of Students via WebSockets
 */

class AdminDashboard {
  constructor() {
    this.ws = null;
    this.exams = [];
    this.students = [];
    this.events = [];
    this.selectedExamId = 'all';
    this.stats = { total: 0, active: 0, warned: 0, terminated: 0, completed: 0 };
    this.currentFilter = 'all';

    this.initWebSocket();
    this.bindCreateExamForm();
    this.fetchInitialData();
  }

  async fetchInitialData() {
    try {
      // 1. Fetch all exams
      const examRes = await fetch('/api/exams');
      const examData = await examRes.json();
      if (examData.success) {
        this.exams = examData.exams || [];
        this.renderExams();
        this.renderExamFilterOptions();
      }

      // 2. Fetch all student records
      const res = await fetch('/api/students');
      const data = await res.json();
      if (data.success) {
        this.students = data.students || [];
        this.stats = data.stats || this.stats;
        this.events = data.events || [];
        this.updateStatsUI();
        this.renderStudents();
        this.renderEvents();
        this.renderExams(); // Update enrollment counts
      }
    } catch (e) {
      console.error('Error fetching initial proctor data:', e);
    }
  }

  initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      const statusEl = document.getElementById('ws-status');
      if (statusEl) {
        statusEl.className = 'badge badge-live';
        statusEl.innerHTML = '<span class="dot-pulse"></span> LIVE MONITOR CONNECTED';
      }

      this.ws.send(JSON.stringify({
        type: 'IDENTIFY',
        role: 'admin'
      }));
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleSocketEvent(data);
      } catch (err) {
        console.error('Error handling admin WS message:', err);
      }
    };

    this.ws.onclose = () => {
      const statusEl = document.getElementById('ws-status');
      if (statusEl) {
        statusEl.className = 'badge badge-danger';
        statusEl.innerHTML = '⚠️ RECONNECTING MONITOR...';
      }
      setTimeout(() => this.initWebSocket(), 3000);
    };
  }

  handleSocketEvent(data) {
    switch (data.type) {
      case 'INIT_ADMIN':
        if (data.exams) this.exams = data.exams;
        if (data.students) this.students = data.students;
        if (data.stats) this.stats = data.stats;
        if (data.events) this.events = data.events;
        this.renderExams();
        this.renderExamFilterOptions();
        this.updateStatsUI();
        this.renderStudents();
        this.renderEvents();
        break;

      case 'EXAM_CREATED':
        this.exams.unshift(data.exam);
        this.renderExams();
        this.renderExamFilterOptions();
        this.addEventLog({
          type: 'EXAM',
          message: `📚 New Exam Created: "${data.exam.title}" by ${data.exam.teacherName || 'Faculty'}`
        });
        break;

      case 'EXAM_UPDATED':
        {
          const idx = this.exams.findIndex(e => e.id === data.exam.id);
          if (idx >= 0) {
            this.exams[idx] = data.exam;
          } else {
            this.exams.push(data.exam);
          }
          this.renderExams();
          this.renderExamFilterOptions();
        }
        break;

      case 'EXAM_DELETED':
        this.exams = this.exams.filter(e => e.id !== data.examId);
        if (this.selectedExamId === data.examId) {
          this.selectedExamId = 'all';
          const filterSel = document.getElementById('exam-filter-select');
          if (filterSel) filterSel.value = 'all';
        }
        this.renderExams();
        this.renderExamFilterOptions();
        this.updateStatsUI();
        this.renderStudents();
        break;

      case 'STUDENT_JOINED':
        this.upsertStudent(data.student);
        if (data.stats && this.selectedExamId === 'all') this.stats = data.stats;
        this.updateStatsUI();
        this.renderStudents();
        this.renderExams();
        this.addEventLog({
          type: 'JOIN',
          name: data.student.name,
          message: `${data.student.name} (${data.student.rollNo}) joined [${data.student.examTitle || 'Exam'}].`
        });
        break;

      case 'VIOLATION_RECORDED':
        this.upsertStudent(data.student);
        if (data.stats && this.selectedExamId === 'all') this.stats = data.stats;
        this.updateStatsUI();
        this.renderStudents();
        
        const latestViolation = (data.student.violations && data.student.violations.length > 0)
          ? data.student.violations[data.student.violations.length - 1]
          : null;

        const maxSt = data.student.maxStrikes || 3;
        const isTerminated = data.student.status === 'terminated';

        this.addEventLog({
          type: isTerminated ? 'TERMINATE' : 'WARNING',
          name: data.student.name,
          message: `${isTerminated ? '🚨 AUTO-DISQUALIFIED' : '⚠️ WARNING'} [Strike ${data.student.strikes}/${maxSt}]: ${data.student.name} (${data.student.rollNo}) in [${data.student.examTitle || 'Exam'}] - ${latestViolation ? latestViolation.type : 'Security Violation'}`
        });
        break;

      case 'STUDENT_COMPLETED':
        this.upsertStudent(data.student);
        if (data.stats && this.selectedExamId === 'all') this.stats = data.stats;
        this.updateStatsUI();
        this.renderStudents();
        this.addEventLog({
          type: 'COMPLETE',
          name: data.student.name,
          message: `✓ ${data.student.name} (${data.student.rollNo}) submitted Google Form in [${data.student.examTitle || 'Exam'}].`
        });
        break;

      case 'STUDENT_PARDONED':
        this.upsertStudent(data.student);
        if (data.stats && this.selectedExamId === 'all') this.stats = data.stats;
        this.updateStatsUI();
        this.renderStudents();
        this.addEventLog({
          type: 'PARDON',
          name: data.student.name,
          message: `🛡️ Student ${data.student.name} (${data.student.rollNo}) pardoned - strikes reset to 0.`
        });
        break;

      case 'STUDENT_EXEMPTION_UPDATED':
        this.upsertStudent(data.student);
        if (data.stats && this.selectedExamId === 'all') this.stats = data.stats;
        this.updateStatsUI();
        this.renderStudents();
        this.addEventLog({
          type: 'EXEMPT',
          name: data.student.name,
          message: data.student.exempt 
            ? `🛡️ Master Controller granted security exemption to ${data.student.name} (${data.student.rollNo}).`
            : `🔒 Master Controller re-enforced security rules for ${data.student.name} (${data.student.rollNo}).`
        });
        break;

      case 'BATCH_EXEMPTION_UPDATED':
        if (Array.isArray(data.students)) {
          for (const s of data.students) this.upsertStudent(s);
        }
        if (data.stats && this.selectedExamId === 'all') this.stats = data.stats;
        this.updateStatsUI();
        this.renderStudents();
        break;

      case 'DATA_CLEARED':
        if (data.examId) {
          this.students = this.students.filter(s => s.examId !== data.examId);
        } else {
          this.students = [];
          this.events = [];
        }
        this.updateStatsUI();
        this.renderStudents();
        this.renderEvents();
        this.renderExams();
        break;
    }
  }

  upsertStudent(student) {
    const idx = this.students.findIndex(s => s.id === student.id);
    if (idx >= 0) {
      this.students[idx] = student;
    } else {
      this.students.unshift(student);
    }
  }

  /* ---------------- Exam Hub Management ---------------- */

  toggleCreateExamModal() {
    const panel = document.getElementById('create-exam-panel');
    if (!panel) return;
    const isHidden = panel.style.display === 'none' || !panel.style.display;
    panel.style.display = isHidden ? 'block' : 'none';
    if (isHidden) {
      const titleInput = document.getElementById('new-exam-title');
      if (titleInput) titleInput.focus();
    }
  }

  bindCreateExamForm() {
    const form = document.getElementById('create-exam-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = document.getElementById('new-exam-title').value.trim();
      const teacherName = document.getElementById('new-exam-teacher').value.trim();
      const durationMinutes = parseInt(document.getElementById('new-exam-duration').value, 10) || 60;
      const maxStrikes = parseInt(document.getElementById('new-exam-strikes').value, 10) || 3;
      const formUrl = document.getElementById('new-exam-url').value.trim();

      if (!title || !formUrl) {
        alert('Please fill in both Exam Title and Google Form URL.');
        return;
      }

      try {
        const res = await fetch('/api/exams', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            teacherName,
            durationMinutes,
            maxStrikes,
            formUrl,
            active: true
          })
        });

        const data = await res.json();
        if (data.success) {
          form.reset();
          document.getElementById('new-exam-duration').value = '60';
          document.getElementById('new-exam-strikes').value = '3';
          this.toggleCreateExamModal();
          alert(`✅ Examination "${data.exam.title}" created successfully!`);
        } else {
          alert('Error: ' + (data.error || 'Failed to create exam'));
        }
      } catch (err) {
        alert('Network error creating exam: ' + err.message);
      }
    });
  }

  renderExams() {
    const tbody = document.getElementById('exams-table-body');
    if (!tbody) return;

    if (!this.exams || this.exams.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">
            No examinations configured yet. Click "Create / Upload New Exam" above to publish your first Google Form test.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = this.exams.map(exam => {
      const studentCount = this.students.filter(s => s.examId === exam.id).length;
      const statusBadge = exam.active
        ? '<span class="badge badge-live" style="font-size: 0.75rem;">ACTIVE</span>'
        : '<span class="badge" style="background: rgba(148, 163, 184, 0.2); color: #94a3b8; font-size: 0.75rem;">INACTIVE</span>';

      return `
        <tr>
          <td><strong>${this.escapeHtml(exam.title)}</strong></td>
          <td>${this.escapeHtml(exam.teacherName || 'Faculty')}</td>
          <td>${exam.durationMinutes || 60} mins</td>
          <td>
            <span class="badge" style="background: rgba(239, 68, 68, 0.15); color: #f87171; font-weight: 600;">
              ${exam.maxStrikes || 3} Strikes
            </span>
          </td>
          <td>${statusBadge}</td>
          <td><strong>${studentCount}</strong> students</td>
          <td>
            <button class="btn btn-secondary" style="width: auto; padding: 0.25rem 0.6rem; font-size: 0.75rem;" onclick="admin.copyExamLink('${exam.id}')" title="Copy direct link for students">
              📋 Copy Direct Link
            </button>
          </td>
          <td>
            <div style="display: flex; gap: 0.35rem;">
              <button class="btn btn-secondary" style="width: auto; padding: 0.25rem 0.6rem; font-size: 0.75rem;" onclick="admin.toggleExamStatus('${exam.id}', ${!exam.active})">
                ${exam.active ? 'Disable' : 'Enable'}
              </button>
              <button class="btn btn-danger" style="width: auto; padding: 0.25rem 0.6rem; font-size: 0.75rem;" onclick="admin.deleteExam('${exam.id}')">
                Delete
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  renderExamFilterOptions() {
    const select = document.getElementById('exam-filter-select');
    if (!select) return;

    const currentVal = this.selectedExamId;
    let html = '<option value="all">🌐 All Examinations</option>';

    this.exams.forEach(e => {
      const activeText = e.active ? '' : ' [Inactive]';
      html += `<option value="${e.id}">${this.escapeHtml(e.title)} (${this.escapeHtml(e.teacherName || 'Faculty')})${activeText}</option>`;
    });

    select.innerHTML = html;
    if (this.exams.some(e => e.id === currentVal) || currentVal === 'all') {
      select.value = currentVal;
    } else {
      select.value = 'all';
      this.selectedExamId = 'all';
    }
  }

  onExamFilterChange() {
    const select = document.getElementById('exam-filter-select');
    if (!select) return;

    this.selectedExamId = select.value;

    // Update export CSV button
    const csvBtn = document.getElementById('btn-export-csv');
    if (csvBtn) {
      csvBtn.href = '/api/export-csv' + (this.selectedExamId !== 'all' ? `?examId=${encodeURIComponent(this.selectedExamId)}` : '');
    }

    this.updateStatsUI();
    this.renderStudents();
  }

  openExportModal() {
    const modal = document.getElementById('export-csv-modal');
    const select = document.getElementById('export-exam-select');
    if (!modal || !select) return;

    let html = '<option value="all">🌐 All Examinations (Combined)</option>';
    this.exams.forEach(e => {
      html += `<option value="${e.id}">${this.escapeHtml(e.title)} (${this.escapeHtml(e.teacherName || 'Faculty')})</option>`;
    });
    select.innerHTML = html;
    select.value = this.selectedExamId || 'all';
    modal.classList.remove('hidden');
  }

  downloadSelectedCSV() {
    const select = document.getElementById('export-exam-select');
    const modal = document.getElementById('export-csv-modal');
    const examId = select ? select.value : 'all';
    const url = `/api/export-csv${examId !== 'all' ? `?examId=${encodeURIComponent(examId)}` : ''}`;

    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    if (modal) modal.classList.add('hidden');
  }

  copyExamLink(examId) {
    const origin = window.location.origin;
    const url = `${origin}/?exam=${encodeURIComponent(examId)}`;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => {
        alert(`Direct Exam URL copied to clipboard!\n\n${url}\n\nStudents opening this link will immediately be enrolled in this exam.`);
      }).catch(() => {
        prompt('Copy this exam link:', url);
      });
    } else {
      prompt('Copy this exam link:', url);
    }
  }

  async toggleExamStatus(examId, newStatus) {
    try {
      const res = await fetch(`/api/exams/${examId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: newStatus })
      });
      const data = await res.json();
      if (data.success) {
        const idx = this.exams.findIndex(e => e.id === examId);
        if (idx >= 0) this.exams[idx].active = newStatus;
        this.renderExams();
        this.renderExamFilterOptions();
      } else {
        alert('Error updating exam status: ' + (data.error || 'Unknown error'));
      }
    } catch (e) {
      alert('Error updating exam status: ' + e.message);
    }
  }

  async deleteExam(examId) {
    const target = this.exams.find(e => e.id === examId);
    const title = target ? target.title : examId;
    if (!confirm(`Are you sure you want to delete the examination "${title}"?\n\nThis will remove it from student portals. Student records for this exam will remain preserved in historical logs.`)) {
      return;
    }

    try {
      const res = await fetch(`/api/exams/${examId}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        this.exams = this.exams.filter(e => e.id !== examId);
        this.renderExams();
        this.renderExamFilterOptions();
      } else {
        alert('Error deleting exam: ' + (data.error || 'Unknown error'));
      }
    } catch (e) {
      alert('Error deleting exam: ' + e.message);
    }
  }

  /* ---------------- Student Roster & Stats ---------------- */

  updateStatsUI() {
    let relevantStudents = this.students;
    if (this.selectedExamId !== 'all') {
      relevantStudents = this.students.filter(s => s.examId === this.selectedExamId);
    }

    const total = relevantStudents.length;
    const active = relevantStudents.filter(s => s.status === 'active').length;
    const warned = relevantStudents.filter(s => s.status === 'warned').length;
    const terminated = relevantStudents.filter(s => s.status === 'terminated').length;
    const completed = relevantStudents.filter(s => s.status === 'completed').length;

    const elTotal = document.getElementById('stat-total');
    const elActive = document.getElementById('stat-active');
    const elWarned = document.getElementById('stat-warned');
    const elTerm = document.getElementById('stat-terminated');
    const elComp = document.getElementById('stat-completed');

    if (elTotal) elTotal.textContent = total;
    if (elActive) elActive.textContent = active;
    if (elWarned) elWarned.textContent = warned;
    if (elTerm) elTerm.textContent = terminated;
    if (elComp) elComp.textContent = completed;
  }

  setFilter(filterName) {
    this.currentFilter = filterName;
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.filter === filterName);
    });
    this.renderStudents();
  }

  renderStudents() {
    const tbody = document.getElementById('student-table-body');
    if (!tbody) return;

    const searchInput = document.getElementById('search-input');
    const search = (searchInput ? searchInput.value : '').toLowerCase().trim();

    let filtered = this.students.filter(s => {
      // Exam filter
      if (this.selectedExamId !== 'all' && s.examId !== this.selectedExamId) {
        return false;
      }
      // Status filter
      if (this.currentFilter !== 'all' && s.status !== this.currentFilter) {
        return false;
      }
      // Search query
      if (search) {
        const matchRoll = (s.rollNo || '').toLowerCase().includes(search);
        const matchName = (s.name || '').toLowerCase().includes(search);
        const matchExam = (s.examTitle || '').toLowerCase().includes(search);
        return matchRoll || matchName || matchExam;
      }
      return true;
    });

    const badge = document.getElementById('student-count-badge');
    if (badge) badge.textContent = filtered.length;

    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="9" style="text-align: center; color: var(--text-muted); padding: 2rem;">
            No students matching the current examination, status, or search query.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = filtered.map(s => {
      const maxSt = s.maxStrikes || 3;
      let statusBadge = '';
      if (s.exempt) {
        statusBadge = '<span class="badge" style="background: rgba(34, 197, 94, 0.2); color: #22c55e; border: 1px solid #22c55e;">🛡️ EXEMPT</span>';
      } else if (s.status === 'terminated') {
        statusBadge = `<span class="badge badge-danger">DISQUALIFIED (${s.strikes}/${maxSt})</span>`;
      } else if (s.status === 'warned') {
        statusBadge = `<span class="badge badge-warning">WARNED (${s.strikes}/${maxSt})</span>`;
      } else if (s.status === 'completed') {
        statusBadge = '<span class="badge badge-live" style="background: rgba(16, 185, 129, 0.2); color: #10b981;">COMPLETED</span>';
      } else {
        statusBadge = '<span class="badge badge-live">ACTIVE</span>';
      }

      const latestViolation = (s.violations && s.violations.length > 0)
        ? s.violations[s.violations.length - 1]
        : null;

      const violationDisplay = latestViolation 
        ? `<span style="color: #f87171; font-weight: 500;">${this.escapeHtml(latestViolation.type)}</span> <span style="font-size: 0.75rem; color: var(--text-muted);">(${new Date(latestViolation.timestamp).toLocaleTimeString()})</span>`
        : '<span style="color: var(--text-muted);">None</span>';

      const joinTime = s.startTime ? new Date(s.startTime).toLocaleTimeString() : '--';

      const strikeColor = s.strikes >= maxSt ? '#ef4444' : (s.strikes === 2 ? '#f97316' : (s.strikes === 1 ? '#f59e0b' : '#10b981'));

      return `
        <tr>
          <td><strong>${this.escapeHtml(s.rollNo)}</strong></td>
          <td>${this.escapeHtml(s.name)}</td>
          <td>${this.escapeHtml(s.section || '-')}</td>
          <td>
            <span class="badge" style="background: rgba(99, 102, 241, 0.15); color: #818cf8; font-size: 0.75rem;">
              ${this.escapeHtml(s.examTitle || 'General Exam')}
            </span>
          </td>
          <td>${statusBadge}</td>
          <td>
            <strong style="color: ${strikeColor}">
              ${s.strikes} / ${maxSt}
            </strong>
          </td>
          <td>${joinTime}</td>
          <td>${violationDisplay}</td>
          <td>
            <div style="display: flex; gap: 0.35rem;">
              ${s.strikes > 0 ? `
                <button class="btn btn-secondary" style="width: auto; padding: 0.25rem 0.6rem; font-size: 0.75rem;" onclick="admin.resetStrikes('${s.id}')" title="Clear strikes & pardon student">
                  Pardon
                </button>
              ` : ''}
              ${s.status !== 'terminated' ? `
                <button class="btn btn-danger" style="width: auto; padding: 0.25rem 0.6rem; font-size: 0.75rem;" onclick="admin.disqualifyStudent('${s.id}')" title="Disqualify student immediately">
                  Disqualify
                </button>
              ` : ''}
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  async resetStrikes(studentId) {
    const student = this.students.find(s => s.id === studentId);
    const label = student ? `${student.name} (${student.rollNo})` : studentId;
    if (!confirm(`Are you sure you want to pardon ${label} and reset their strikes to 0?`)) return;
    try {
      const res = await fetch(`/api/students/${studentId}/reset`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        alert(`Strikes for ${label} have been reset to 0.`);
      }
    } catch (e) {
      alert('Error resetting strikes: ' + e.message);
    }
  }

  disqualifyStudent(studentId) {
    const student = this.students.find(s => s.id === studentId);
    const label = student ? `${student.name} (${student.rollNo})` : studentId;
    if (!confirm(`Force-terminate and disqualify ${label} immediately?`)) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'ADMIN_TERMINATE_STUDENT',
        studentId: studentId
      }));
    }
  }

  broadcastPrompt() {
    const msg = prompt('Enter announcement message to broadcast to all testing students:');
    if (!msg || !msg.trim()) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'ADMIN_BROADCAST',
        message: msg.trim()
      }));
      alert('Announcement broadcasted to all student screens!');
    }
  }

  addEventLog(event) {
    const container = document.getElementById('event-log-container');
    if (!container) return;
    const div = document.createElement('div');
    div.className = `event-item ${event.type || ''}`;
    const timeStr = new Date().toLocaleTimeString();
    div.innerHTML = `<span style="color: var(--text-muted);">[${timeStr}]</span> <span>${this.escapeHtml(event.message)}</span>`;
    container.prepend(div);

    while (container.children.length > 50) {
      container.removeChild(container.lastChild);
    }
  }

  renderEvents() {
    const container = document.getElementById('event-log-container');
    if (!container) return;
    if (!this.events || this.events.length === 0) {
      container.innerHTML = '<div style="color: var(--text-muted); font-style: italic;">Listening for student infractions in real time...</div>';
      return;
    }
    container.innerHTML = this.events.map(ev => {
      const timeStr = ev.time ? new Date(ev.timestamp || ev.time).toLocaleTimeString() : '';
      return `<div class="event-item ${ev.type || ''}">
        <span style="color: var(--text-muted);">[${timeStr}]</span> 
        <span>${this.escapeHtml(ev.message)}</span>
      </div>`;
    }).join('');
  }

  clearEventsUI() {
    const container = document.getElementById('event-log-container');
    if (container) {
      container.innerHTML = '<div style="color: var(--text-muted); font-style: italic;">Event feed cleared.</div>';
    }
  }

  async clearAllRecords() {
    const isFiltered = this.selectedExamId !== 'all';
    const targetExam = isFiltered ? this.exams.find(e => e.id === this.selectedExamId) : null;
    const confirmMsg = isFiltered
      ? `DANGER: Are you sure you want to clear all student exam records for "${targetExam ? targetExam.title : 'this exam'}"?`
      : 'DANGER: Are you sure you want to clear ALL student exam records across ALL examinations?';

    if (!confirm(confirmMsg)) return;

    try {
      const res = await fetch('/api/clear-records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ examId: isFiltered ? this.selectedExamId : null })
      });
      const data = await res.json();
      if (data.success) {
        alert('Student records cleared successfully.');
      }
    } catch (e) {
      alert('Error clearing records: ' + e.message);
    }
  }

  escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}

window.admin = new AdminDashboard();
