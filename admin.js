/**
 * Teacher / Proctor Command Center Script
 * Real-time monitoring of up to 500+ students via WebSockets
 */

class AdminDashboard {
  constructor() {
    this.ws = null;
    this.students = [];
    this.events = [];
    this.stats = { total: 0, active: 0, warned: 0, terminated: 0, completed: 0 };
    this.currentFilter = 'all';
    this.config = null;

    this.initWebSocket();
    this.bindFormEvents();
    this.fetchInitialData();
  }

  async fetchInitialData() {
    try {
      const res = await fetch('/api/students');
      const data = await res.json();
      if (data.success) {
        this.students = data.students || [];
        this.stats = data.stats || this.stats;
        this.events = data.events || [];
        this.updateStatsUI();
        this.renderStudents();
        this.renderEvents();
      }

      const cfgRes = await fetch('/api/config');
      const cfgData = await cfgRes.json();
      if (cfgData.success) {
        this.populateConfig(cfgData.config);
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
      document.getElementById('ws-status').className = 'badge badge-live';
      document.getElementById('ws-status').innerHTML = '<span class="dot-pulse"></span> LIVE MONITOR CONNECTED';

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
      document.getElementById('ws-status').className = 'badge badge-danger';
      document.getElementById('ws-status').innerHTML = '⚠️ RECONNECTING MONITOR...';
      setTimeout(() => this.initWebSocket(), 3000);
    };
  }

  handleSocketEvent(data) {
    switch (data.type) {
      case 'INIT_ADMIN':
        this.populateConfig(data.config);
        this.stats = data.stats;
        this.students = data.students;
        this.events = data.events;
        this.updateStatsUI();
        this.renderStudents();
        this.renderEvents();
        break;

      case 'STUDENT_JOINED':
        this.upsertStudent(data.student);
        if (data.stats) this.stats = data.stats;
        this.updateStatsUI();
        this.renderStudents();
        this.addEventLog({
          type: 'JOIN',
          name: data.student.name,
          message: `${data.student.name} (${data.student.rollNo}) joined the exam session.`
        });
        break;

      case 'VIOLATION_RECORDED':
        this.upsertStudent(data.student);
        if (data.stats) this.stats = data.stats;
        this.updateStatsUI();
        this.renderStudents();
        
        const latestViolation = (data.student.violations && data.student.violations.length > 0)
          ? data.student.violations[data.student.violations.length - 1]
          : null;

        this.addEventLog({
          type: data.student.status === 'terminated' ? 'TERMINATE' : 'WARNING',
          name: data.student.name,
          message: `${data.student.status === 'terminated' ? '🚨 AUTO-DISQUALIFIED' : '⚠️ WARNING'} [Strike ${data.student.strikes}]: ${data.student.name} (${data.student.rollNo}) - ${latestViolation ? latestViolation.type : 'Security Violation'}`
        });
        break;

      case 'STUDENT_COMPLETED':
        this.upsertStudent(data.student);
        if (data.stats) this.stats = data.stats;
        this.updateStatsUI();
        this.renderStudents();
        this.addEventLog({
          type: 'COMPLETE',
          name: data.student.name,
          message: `✓ ${data.student.name} (${data.student.rollNo}) successfully submitted Google Form response.`
        });
        break;

      case 'STUDENT_PARDONED':
        this.upsertStudent(data.student);
        if (data.stats) this.stats = data.stats;
        this.updateStatsUI();
        this.renderStudents();
        break;

      case 'CONFIG_UPDATED':
        this.populateConfig(data.config);
        break;

      case 'DATA_CLEARED':
        this.students = [];
        this.events = [];
        this.stats = data.stats || { total: 0, active: 0, warned: 0, terminated: 0, completed: 0 };
        this.updateStatsUI();
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

  updateStatsUI() {
    document.getElementById('stat-total').textContent = this.stats.total || 0;
    document.getElementById('stat-active').textContent = this.stats.active || 0;
    document.getElementById('stat-warned').textContent = this.stats.warned || 0;
    document.getElementById('stat-terminated').textContent = this.stats.terminated || 0;
    document.getElementById('stat-completed').textContent = this.stats.completed || 0;
  }

  populateConfig(config) {
    if (!config) return;
    this.config = config;
    document.getElementById('cfg-form-url').value = config.formUrl || '';
    document.getElementById('cfg-title').value = config.examTitle || '';
    document.getElementById('cfg-duration').value = config.durationMinutes || 60;
  }

  bindFormEvents() {
    document.getElementById('config-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const formUrl = document.getElementById('cfg-form-url').value.trim();
      const examTitle = document.getElementById('cfg-title').value.trim();
      const durationMinutes = parseInt(document.getElementById('cfg-duration').value, 10);

      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ formUrl, examTitle, durationMinutes })
        });
        const data = await res.json();
        if (data.success) {
          alert('Exam configuration updated successfully! Incoming students will load this Google Form.');
        }
      } catch (err) {
        alert('Failed to update config: ' + err.message);
      }
    });
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
    const search = (document.getElementById('search-input').value || '').toLowerCase().trim();

    let filtered = this.students.filter(s => {
      // Status filter
      if (this.currentFilter !== 'all' && s.status !== this.currentFilter) {
        return false;
      }
      // Search query
      if (search) {
        const matchRoll = s.rollNo.toLowerCase().includes(search);
        const matchName = s.name.toLowerCase().includes(search);
        return matchRoll || matchName;
      }
      return true;
    });

    document.getElementById('student-count-badge').textContent = filtered.length;

    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" style="text-align: center; color: var(--text-muted); padding: 2rem;">
            No students matching current filter or search query.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = filtered.map(s => {
      let statusBadge = '';
      if (s.status === 'terminated') {
        statusBadge = '<span class="badge badge-danger">DISQUALIFIED (2/2)</span>';
      } else if (s.status === 'warned') {
        statusBadge = '<span class="badge badge-warning">WARNED (1/2)</span>';
      } else if (s.status === 'completed') {
        statusBadge = '<span class="badge badge-live" style="background: rgba(16, 185, 129, 0.2); color: #10b981;">COMPLETED</span>';
      } else {
        statusBadge = '<span class="badge badge-live">ACTIVE</span>';
      }

      const latestViolation = (s.violations && s.violations.length > 0)
        ? s.violations[s.violations.length - 1]
        : null;

      const violationDisplay = latestViolation 
        ? `<span style="color: #f87171; font-weight: 500;">${latestViolation.type}</span> <span style="font-size: 0.75rem; color: var(--text-muted);">(${new Date(latestViolation.timestamp).toLocaleTimeString()})</span>`
        : '<span style="color: var(--text-muted);">None</span>';

      const joinTime = s.startTime ? new Date(s.startTime).toLocaleTimeString() : '--';

      return `
        <tr>
          <td><strong>${s.rollNo}</strong></td>
          <td>${s.name}</td>
          <td>${s.section || '-'}</td>
          <td>${statusBadge}</td>
          <td>
            <strong style="color: ${s.strikes >= 2 ? '#ef4444' : (s.strikes === 1 ? '#f59e0b' : '#10b981')}">
              ${s.strikes} / 2
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
    if (!confirm(`Are you sure you want to pardon student ${studentId} and reset their strikes?`)) return;
    try {
      const res = await fetch(`/api/students/${studentId}/reset`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        alert(`Strikes for student ${studentId} have been reset to 0.`);
      }
    } catch (e) {
      alert('Error resetting strikes: ' + e.message);
    }
  }

  disqualifyStudent(studentId) {
    if (!confirm(`Force-terminate student ${studentId} immediately?`)) return;
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
    const div = document.createElement('div');
    div.className = `event-item ${event.type || ''}`;
    const timeStr = new Date().toLocaleTimeString();
    div.innerHTML = `<span style="color: var(--text-muted);">[${timeStr}]</span> <span>${event.message}</span>`;
    container.prepend(div);

    // Keep max 50 items displayed in UI
    while (container.children.length > 50) {
      container.removeChild(container.lastChild);
    }
  }

  renderEvents() {
    const container = document.getElementById('event-log-container');
    if (!this.events || this.events.length === 0) {
      container.innerHTML = '<div style="color: var(--text-muted); font-style: italic;">Listening for student infractions in real time...</div>';
      return;
    }
    container.innerHTML = this.events.map(ev => {
      const timeStr = ev.time ? new Date(ev.timestamp || ev.time).toLocaleTimeString() : '';
      return `<div class="event-item ${ev.type || ''}">
        <span style="color: var(--text-muted);">[${timeStr}]</span> 
        <span>${ev.message}</span>
      </div>`;
    }).join('');
  }

  clearEventsUI() {
    document.getElementById('event-log-container').innerHTML = '<div style="color: var(--text-muted); font-style: italic;">Event feed cleared.</div>';
  }

  async clearAllRecords() {
    if (!confirm('DANGER: Are you sure you want to clear all student exam records? This is recommended only when starting a completely new exam batch.')) {
      return;
    }
    try {
      await fetch('/api/clear-records', { method: 'POST' });
    } catch (e) {
      alert('Error clearing records: ' + e.message);
    }
  }
}

window.admin = new AdminDashboard();

