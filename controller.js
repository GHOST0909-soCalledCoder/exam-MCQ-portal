/**
 * Master Exam Controller Script
 * Central Oversight Across All Rooms & Student Security Exemption Management
 */

class MasterController {
  constructor() {
    this.ws = null;
    this.exams = [];
    this.students = [];
    this.events = [];
    this.selectedRoomId = 'all';
    this.statusFilter = 'all';
    this.selectedStudentIds = new Set();
    this.stats = { total: 0, active: 0, warned: 0, terminated: 0, completed: 0, exempt: 0 };

    this.initWebSocket();
    this.fetchInitialData();
  }

  async fetchInitialData() {
    try {
      // 1. Load all exams / rooms
      const examRes = await fetch('/api/exams');
      const examData = await examRes.json();
      if (examData.success) {
        this.exams = examData.exams || [];
        this.renderRooms();
        this.renderRoomFilterSelect();
      }

      // 2. Load all student records
      const res = await fetch('/api/students');
      const data = await res.json();
      if (data.success) {
        this.students = data.students || [];
        this.events = data.events || [];
        this.updateStatsUI();
        this.renderRooms(); // Update counts on room cards
        this.renderStudents();
        this.renderEvents();
      }
    } catch (e) {
      console.error('Error fetching controller data:', e);
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
        statusEl.innerHTML = '<span class="dot-pulse"></span> LIVE OVERWATCH';
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
        console.error('Error handling controller WS message:', err);
      }
    };

    this.ws.onclose = () => {
      const statusEl = document.getElementById('ws-status');
      if (statusEl) {
        statusEl.className = 'badge badge-danger';
        statusEl.innerHTML = '⚠️ RECONNECTING OVERWATCH...';
      }
      setTimeout(() => this.initWebSocket(), 3000);
    };
  }

  handleSocketEvent(data) {
    switch (data.type) {
      case 'INIT_ADMIN':
        if (data.exams) this.exams = data.exams;
        if (data.students) this.students = data.students;
        if (data.events) this.events = data.events;
        this.renderRooms();
        this.renderRoomFilterSelect();
        this.updateStatsUI();
        this.renderStudents();
        this.renderEvents();
        break;

      case 'STUDENT_JOINED':
        this.upsertStudent(data.student);
        this.updateStatsUI();
        this.renderRooms();
        this.renderStudents();
        this.addEventLog({
          type: 'JOIN',
          message: `${data.student.name} (${data.student.rollNo}) joined [${data.student.examTitle || 'Exam'}].`
        });
        break;

      case 'VIOLATION_RECORDED':
        this.upsertStudent(data.student);
        this.updateStatsUI();
        this.renderRooms();
        this.renderStudents();
        
        const latestViolation = (data.student.violations && data.student.violations.length > 0)
          ? data.student.violations[data.student.violations.length - 1]
          : null;

        const maxSt = data.student.maxStrikes || 3;
        const isTerminated = data.student.status === 'terminated';

        this.addEventLog({
          type: isTerminated ? 'TERMINATE' : 'WARNING',
          message: `${isTerminated ? '🚨 AUTO-DISQUALIFIED' : '⚠️ WARNING'} [Strike ${data.student.strikes}/${maxSt}]: ${data.student.name} (${data.student.rollNo}) in [${data.student.examTitle || 'Exam'}] - ${latestViolation ? latestViolation.type : 'Security Infraction'}`
        });
        break;

      case 'STUDENT_EXEMPTION_UPDATED':
        this.upsertStudent(data.student);
        this.updateStatsUI();
        this.renderRooms();
        this.renderStudents();
        this.addEventLog({
          type: data.student.exempt ? 'EXEMPTION' : 'ENFORCE',
          message: data.student.exempt
            ? `🛡️ SECURITY RULES BYPASSED for ${data.student.name} (${data.student.rollNo}) in [${data.student.examTitle || 'Exam'}]`
            : `🔒 SECURITY RULES RE-ENFORCED for ${data.student.name} (${data.student.rollNo}) in [${data.student.examTitle || 'Exam'}]`
        });
        break;

      case 'BATCH_EXEMPTION_UPDATED':
        if (Array.isArray(data.students)) {
          for (const s of data.students) {
            this.upsertStudent(s);
          }
        }
        this.updateStatsUI();
        this.renderRooms();
        this.renderStudents();
        this.addEventLog({
          type: 'EXEMPTION',
          message: `🛡️ Batch security exemption updated for ${data.students ? data.students.length : 0} students.`
        });
        break;

      case 'STUDENT_PARDONED':
        this.upsertStudent(data.student);
        this.updateStatsUI();
        this.renderRooms();
        this.renderStudents();
        this.addEventLog({
          type: 'PARDON',
          message: `✨ Strikes pardoned for ${data.student.name} (${data.student.rollNo}) in [${data.student.examTitle || 'Exam'}].`
        });
        break;

      case 'STUDENT_COMPLETED':
        this.upsertStudent(data.student);
        this.updateStatsUI();
        this.renderRooms();
        this.renderStudents();
        this.addEventLog({
          type: 'COMPLETE',
          message: `✓ Completed: ${data.student.name} (${data.student.rollNo}) submitted form in [${data.student.examTitle || 'Exam'}].`
        });
        break;

      case 'EXAM_CREATED':
      case 'EXAM_UPDATED':
      case 'EXAM_DELETED':
        this.fetchInitialData();
        break;

      case 'DATA_CLEARED':
        if (data.examId) {
          this.students = this.students.filter(s => s.examId !== data.examId);
        } else {
          this.students = [];
          this.events = [];
        }
        this.selectedStudentIds.clear();
        this.updateSelectedCounter();
        this.updateStatsUI();
        this.renderRooms();
        this.renderStudents();
        this.renderEvents();
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

  /* ---------------- Multi-Room Grid ---------------- */

  renderRooms() {
    const container = document.getElementById('rooms-grid');
    if (!container) return;

    if (!this.exams || this.exams.length === 0) {
      container.innerHTML = `
        <div style="color: var(--text-muted); font-size: 0.85rem; padding: 1rem;">
          No examination rooms configured yet. Create exams on the Teacher Dashboard.
        </div>
      `;
      return;
    }

    container.innerHTML = this.exams.map(exam => {
      const roomStudents = this.students.filter(s => s.examId === exam.id);
      const activeCount = roomStudents.filter(s => s.status === 'active').length;
      const exemptCount = roomStudents.filter(s => s.exempt).length;
      const infractionsCount = roomStudents.reduce((acc, s) => acc + (s.strikes || 0), 0);
      const isSelected = this.selectedRoomId === exam.id;

      return `
        <div class="room-card ${isSelected ? 'active-filter' : ''}" onclick="controller.filterByRoom('${exam.id}')">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.5rem;">
            <h4 style="font-size: 0.95rem; font-weight: 700; color: #f8fafc; margin-right: 0.5rem;">
              ${this.escapeHtml(exam.title)}
            </h4>
            <span class="badge ${exam.active ? 'badge-live' : ''}" style="font-size: 0.7rem;">
              ${exam.active ? 'LIVE' : 'INACTIVE'}
            </span>
          </div>

          <div style="font-size: 0.78rem; color: var(--text-secondary); margin-bottom: 0.75rem;">
            Faculty: <strong>${this.escapeHtml(exam.teacherName || 'Faculty')}</strong> • ${exam.durationMinutes || 60}m
          </div>

          <div style="display: flex; justify-content: space-between; font-size: 0.8rem; padding-top: 0.5rem; border-top: 1px solid rgba(51, 65, 85, 0.4);">
            <div>
              👥 <strong>${roomStudents.length}</strong> enrolled (${activeCount} active)
            </div>
            <div>
              <span style="color: #22c55e; font-weight: 700;">${exemptCount} exempt</span>
            </div>
          </div>
          ${infractionsCount > 0 ? `
            <div style="font-size: 0.75rem; color: #f87171; margin-top: 0.4rem;">
              ⚠️ ${infractionsCount} security infraction${infractionsCount > 1 ? 's' : ''} logged
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
  }

  filterByRoom(roomId) {
    this.selectedRoomId = roomId;
    const select = document.getElementById('room-filter-select');
    if (select) select.value = roomId;

    this.renderRooms();
    this.updateStatsUI();
    this.renderStudents();
  }

  renderRoomFilterSelect() {
    const select = document.getElementById('room-filter-select');
    if (!select) return;

    let html = '<option value="all">🌐 All Rooms</option>';
    this.exams.forEach(e => {
      html += `<option value="${e.id}">${this.escapeHtml(e.title)}</option>`;
    });

    select.innerHTML = html;
    select.value = this.selectedRoomId;
  }

  onRoomFilterChange() {
    const select = document.getElementById('room-filter-select');
    if (!select) return;
    this.filterByRoom(select.value);
  }

  openExportModal() {
    const modal = document.getElementById('export-csv-modal');
    const select = document.getElementById('export-exam-select');
    if (!modal || !select) return;

    let html = '<option value="all">🌐 All Examination Rooms (Combined)</option>';
    this.exams.forEach(e => {
      html += `<option value="${e.id}">${this.escapeHtml(e.title)}</option>`;
    });
    select.innerHTML = html;
    select.value = this.selectedRoomId || 'all';
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

  /* ---------------- Stats & Filters ---------------- */

  updateStatsUI() {
    let relevantStudents = this.students;
    if (this.selectedRoomId !== 'all') {
      relevantStudents = this.students.filter(s => s.examId === this.selectedRoomId);
    }

    const totalRooms = this.exams.length;
    const total = relevantStudents.length;
    const active = relevantStudents.filter(s => s.status === 'active').length;
    const exempt = relevantStudents.filter(s => s.exempt).length;
    const warned = relevantStudents.filter(s => s.status === 'warned').length;
    const terminated = relevantStudents.filter(s => s.status === 'terminated').length;

    const elRooms = document.getElementById('stat-rooms');
    const elTotal = document.getElementById('stat-total');
    const elActive = document.getElementById('stat-active');
    const elExempt = document.getElementById('stat-exempt');
    const elWarned = document.getElementById('stat-warned');
    const elTerm = document.getElementById('stat-terminated');

    if (elRooms) elRooms.textContent = totalRooms;
    if (elTotal) elTotal.textContent = total;
    if (elActive) elActive.textContent = active;
    if (elExempt) elExempt.textContent = exempt;
    if (elWarned) elWarned.textContent = warned;
    if (elTerm) elTerm.textContent = terminated;
  }

  setStatusFilter(filterName) {
    this.statusFilter = filterName;
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.filter === filterName);
    });
    this.renderStudents();
  }

  /* ---------------- Student Roster & Selection ---------------- */

  getFilteredStudents() {
    const searchInput = document.getElementById('search-input');
    const search = (searchInput ? searchInput.value : '').toLowerCase().trim();

    return this.students.filter(s => {
      // Room filter
      if (this.selectedRoomId !== 'all' && s.examId !== this.selectedRoomId) {
        return false;
      }
      // Status & Exemption filter
      if (this.statusFilter === 'exempt' && !s.exempt) return false;
      if (this.statusFilter === 'enforced' && s.exempt) return false;
      if (this.statusFilter === 'warned' && s.status !== 'warned') return false;
      if (this.statusFilter === 'terminated' && s.status !== 'terminated') return false;

      // Search query
      if (search) {
        const matchRoll = (s.rollNo || '').toLowerCase().includes(search);
        const matchName = (s.name || '').toLowerCase().includes(search);
        const matchRoom = (s.examTitle || '').toLowerCase().includes(search);
        const matchSec = (s.section || '').toLowerCase().includes(search);
        return matchRoll || matchName || matchRoom || matchSec;
      }
      return true;
    });
  }

  renderStudents() {
    const tbody = document.getElementById('students-table-body');
    if (!tbody) return;

    const filtered = this.getFilteredStudents();
    const countBadge = document.getElementById('student-count-badge');
    if (countBadge) countBadge.textContent = filtered.length;

    // Check if all filtered are selected
    const allCheckbox = document.getElementById('select-all-checkbox');
    if (allCheckbox) {
      allCheckbox.checked = filtered.length > 0 && filtered.every(s => this.selectedStudentIds.has(s.id));
    }

    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="10" style="text-align: center; color: var(--text-muted); padding: 2.5rem;">
            No students matching current room, search query, or status filter.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = filtered.map(s => {
      const isSelected = this.selectedStudentIds.has(s.id);
      const maxSt = s.maxStrikes || 3;

      let statusBadge = '';
      if (s.status === 'terminated') {
        statusBadge = `<span class="badge badge-danger">DISQUALIFIED (${s.strikes}/${maxSt})</span>`;
      } else if (s.status === 'warned') {
        statusBadge = `<span class="badge badge-warning">WARNED (${s.strikes}/${maxSt})</span>`;
      } else if (s.status === 'completed') {
        statusBadge = '<span class="badge badge-live" style="background: rgba(16, 185, 129, 0.2); color: #10b981;">COMPLETED</span>';
      } else {
        statusBadge = '<span class="badge badge-live">ACTIVE</span>';
      }

      const securityBadge = s.exempt
        ? '<span class="badge-exempt">🛡️ EXEMPT (Bypassed)</span>'
        : '<span class="badge-enforced">🔒 Enforced</span>';

      const strikeColor = s.strikes >= maxSt ? '#ef4444' : (s.strikes === 2 ? '#f97316' : (s.strikes === 1 ? '#f59e0b' : '#10b981'));

      return `
        <tr style="${s.exempt ? 'background-color: rgba(34, 197, 94, 0.04);' : ''}">
          <td style="text-align: center;">
            <input type="checkbox" class="custom-checkbox" ${isSelected ? 'checked' : ''} onchange="controller.toggleSelectStudent('${s.id}', this.checked)">
          </td>
          <td><strong>${this.escapeHtml(s.rollNo)}</strong></td>
          <td>${this.escapeHtml(s.name)}</td>
          <td>${this.escapeHtml(s.section || '-')}</td>
          <td>
            <span class="badge" style="background: rgba(99, 102, 241, 0.15); color: #818cf8; font-size: 0.75rem;">
              ${this.escapeHtml(s.examTitle || 'General')}
            </span>
          </td>
          <td>${securityBadge}</td>
          <td>
            <strong style="color: ${strikeColor}">
              ${s.strikes} / ${maxSt}
            </strong>
          </td>
          <td>${statusBadge}</td>
          <td>
            ${s.exempt ? `
              <button class="btn btn-secondary" style="width: auto; padding: 0.25rem 0.65rem; font-size: 0.75rem;" onclick="controller.toggleStudentExemption('${s.id}', false)" title="Re-enforce security rules on this student">
                🔒 Enforce Rules
              </button>
            ` : `
              <button class="btn btn-success" style="width: auto; padding: 0.25rem 0.65rem; font-size: 0.75rem;" onclick="controller.toggleStudentExemption('${s.id}', true)" title="Exclude this student from all security rules">
                🛡️ Exclude Rules
              </button>
            `}
          </td>
          <td>
            <div style="display: flex; gap: 0.35rem;">
              ${s.strikes > 0 ? `
                <button class="btn btn-secondary" style="width: auto; padding: 0.25rem 0.55rem; font-size: 0.75rem;" onclick="controller.pardonStudent('${s.id}')" title="Reset strikes">
                  Pardon
                </button>
              ` : ''}
              ${s.status !== 'terminated' ? `
                <button class="btn btn-danger" style="width: auto; padding: 0.25rem 0.55rem; font-size: 0.75rem;" onclick="controller.disqualifyStudent('${s.id}')" title="Disqualify student">
                  Disqualify
                </button>
              ` : ''}
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  toggleSelectAll(checked) {
    const filtered = this.getFilteredStudents();
    if (checked) {
      filtered.forEach(s => this.selectedStudentIds.add(s.id));
    } else {
      filtered.forEach(s => this.selectedStudentIds.delete(s.id));
    }
    this.updateSelectedCounter();
    this.renderStudents();
  }

  toggleSelectStudent(studentId, checked) {
    if (checked) {
      this.selectedStudentIds.add(studentId);
    } else {
      this.selectedStudentIds.delete(studentId);
    }
    this.updateSelectedCounter();

    const allCheckbox = document.getElementById('select-all-checkbox');
    const filtered = this.getFilteredStudents();
    if (allCheckbox) {
      allCheckbox.checked = filtered.length > 0 && filtered.every(s => this.selectedStudentIds.has(s.id));
    }
  }

  updateSelectedCounter() {
    const counter = document.getElementById('selected-counter');
    if (counter) {
      counter.textContent = `${this.selectedStudentIds.size} student${this.selectedStudentIds.size === 1 ? '' : 's'} selected`;
    }
  }

  /* ---------------- Exemption & Control Actions ---------------- */

  async toggleStudentExemption(studentId, isExempt) {
    const student = this.students.find(s => s.id === studentId);
    const label = student ? `${student.name} (${student.rollNo})` : studentId;
    const actionText = isExempt ? 'EXCLUDE from all security rules' : 'RE-ENFORCE all security rules on';

    try {
      const res = await fetch(`/api/students/${studentId}/exemption`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exempt: isExempt })
      });
      const data = await res.json();
      if (data.success) {
        this.upsertStudent(data.student);
        this.updateStatsUI();
        this.renderRooms();
        this.renderStudents();
      } else {
        alert('Error: ' + (data.error || 'Failed to update exemption status'));
      }
    } catch (e) {
      alert('Network error: ' + e.message);
    }
  }

  async batchSetExemption(isExempt) {
    const studentIds = Array.from(this.selectedStudentIds);
    if (studentIds.length === 0) {
      alert('Please select at least one student from the roster using the checkboxes first.');
      return;
    }

    const actionText = isExempt 
      ? `EXCLUDE ${studentIds.length} selected student(s) from all security rules?\n\nThey will be able to freely switch tabs, exit fullscreen, resize windows, and use external tools without getting any strikes.`
      : `RE-ENFORCE security rules on ${studentIds.length} selected student(s)?\n\nTheir browsers will return to active anti-cheat monitoring.`;

    if (!confirm(actionText)) return;

    try {
      const res = await fetch('/api/students/batch-exemption', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentIds, exempt: isExempt })
      });
      const data = await res.json();
      if (data.success) {
        if (data.students) {
          for (const s of data.students) this.upsertStudent(s);
        }
        this.selectedStudentIds.clear();
        this.updateSelectedCounter();
        this.updateStatsUI();
        this.renderRooms();
        this.renderStudents();
        alert(`✅ Successfully updated security exemption for ${data.count || studentIds.length} students.`);
      } else {
        alert('Error: ' + (data.error || 'Failed to update batch exemption'));
      }
    } catch (e) {
      alert('Network error: ' + e.message);
    }
  }

  async pardonStudent(studentId) {
    const student = this.students.find(s => s.id === studentId);
    const label = student ? `${student.name} (${student.rollNo})` : studentId;
    if (!confirm(`Are you sure you want to pardon ${label} and reset their strikes to 0?`)) return;

    try {
      const res = await fetch(`/api/students/${studentId}/reset`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        this.upsertStudent(data.student);
        this.updateStatsUI();
        this.renderStudents();
      }
    } catch (e) {
      alert('Error pardoning student: ' + e.message);
    }
  }

  async batchPardon() {
    const studentIds = Array.from(this.selectedStudentIds);
    if (studentIds.length === 0) {
      alert('Please select at least one student using the checkboxes first.');
      return;
    }

    if (!confirm(`Reset strikes and pardon all ${studentIds.length} selected students?`)) return;

    for (const id of studentIds) {
      try {
        await fetch(`/api/students/${id}/reset`, { method: 'POST' });
      } catch (e) {}
    }
    this.selectedStudentIds.clear();
    this.updateSelectedCounter();
    await this.fetchInitialData();
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

  batchDisqualify() {
    const studentIds = Array.from(this.selectedStudentIds);
    if (studentIds.length === 0) {
      alert('Please select at least one student using the checkboxes first.');
      return;
    }

    if (!confirm(`DANGER: Immediately disqualify all ${studentIds.length} selected students?`)) return;

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      for (const id of studentIds) {
        this.ws.send(JSON.stringify({
          type: 'ADMIN_TERMINATE_STUDENT',
          studentId: id
        }));
      }
    }
    this.selectedStudentIds.clear();
    this.updateSelectedCounter();
  }

  /* ---------------- Audit Event Log ---------------- */

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
      container.innerHTML = '<div style="color: var(--text-muted); font-style: italic;">Monitoring all exam rooms and security events in real time...</div>';
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

  clearLogUI() {
    const container = document.getElementById('event-log-container');
    if (container) {
      container.innerHTML = '<div style="color: var(--text-muted); font-style: italic;">Audit feed cleared.</div>';
    }
  }

  escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}

window.controller = new MasterController();

