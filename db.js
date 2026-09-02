const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'exam_data.json');

// Default initial config
const defaultData = {
  config: {
    examTitle: "College MCQ Examination",
    formUrl: "https://docs.google.com/forms/d/e/1FAIpQLSfD5U3C1vT9j6_example/viewform?embedded=true",
    durationMinutes: 60,
    maxStrikes: 2, // 1 warning, 2nd strike terminates
    requireFullscreen: true,
    blockShortcuts: true,
    active: true
  },
  students: {},
  events: []
};

class ExamDatabase {
  constructor() {
    this.data = this.load();
    this.saveTimeout = null;
  }

  load() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const raw = fs.readFileSync(DATA_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        return {
          config: { ...defaultData.config, ...(parsed.config || {}) },
          students: parsed.students || {},
          events: parsed.events || []
        };
      }
    } catch (err) {
      console.error('Error reading exam_data.json, using defaults:', err.message);
    }
    return JSON.parse(JSON.stringify(defaultData));
  }

  // Throttled debounced persistence to avoid disk I/O contention under 400+ users
  scheduleSave() {
    if (this.saveTimeout) return;
    this.saveTimeout = setTimeout(() => {
      try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(this.data, null, 2), 'utf-8');
      } catch (err) {
        console.error('Failed to persist exam_data.json:', err.message);
      } finally {
        this.saveTimeout = null;
      }
    }, 1000);
  }

  forceSave() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  getConfig() {
    return this.data.config;
  }

  updateConfig(newConfig) {
    this.data.config = { ...this.data.config, ...newConfig };
    this.scheduleSave();
    return this.data.config;
  }

  getStudent(studentId) {
    return this.data.students[studentId] || null;
  }

  getAllStudents() {
    return Object.values(this.data.students);
  }

  registerStudent({ name, rollNo, section, ip }) {
    const studentId = rollNo.trim().toUpperCase();
    const existing = this.data.students[studentId];

    if (existing) {
      // If student was terminated, preserve terminated status
      existing.name = name.trim();
      existing.section = (section || '').trim();
      existing.lastPing = Date.now();
      existing.ip = ip;
      this.scheduleSave();
      return existing;
    }

    const student = {
      id: studentId,
      rollNo: studentId,
      name: name.trim(),
      section: (section || '').trim(),
      ip: ip || '127.0.0.1',
      startTime: Date.now(),
      lastPing: Date.now(),
      strikes: 0,
      status: 'active', // 'active', 'warned', 'terminated', 'completed'
      violations: []
    };

    this.data.students[studentId] = student;
    this.logEvent({
      type: 'JOIN',
      studentId: student.id,
      name: student.name,
      message: `Student joined the exam room`
    });

    this.scheduleSave();
    return student;
  }

  recordViolation(studentId, violationType, details = '') {
    const student = this.data.students[studentId];
    if (!student) return null;

    if (student.status === 'terminated' || student.status === 'completed') {
      return student;
    }

    student.strikes += 1;
    const violationEntry = {
      strike: student.strikes,
      type: violationType,
      details: details,
      timestamp: Date.now()
    };
    student.violations.push(violationEntry);
    student.lastPing = Date.now();

    if (student.strikes >= this.data.config.maxStrikes) {
      student.status = 'terminated';
      student.terminatedAt = Date.now();
      this.logEvent({
        type: 'TERMINATE',
        studentId: student.id,
        name: student.name,
        strike: student.strikes,
        message: `🚨 EXAM AUTO-TERMINATED (Strike ${student.strikes}/${this.data.config.maxStrikes}) - ${violationType}`
      });
    } else {
      student.status = 'warned';
      this.logEvent({
        type: 'WARNING',
        studentId: student.id,
        name: student.name,
        strike: student.strikes,
        message: `⚠️ Strike ${student.strikes}/${this.data.config.maxStrikes} - ${violationType}`
      });
    }

    this.scheduleSave();
    return student;
  }

  completeExam(studentId) {
    const student = this.data.students[studentId];
    if (!student) return null;
    if (student.status !== 'terminated') {
      student.status = 'completed';
      student.completedAt = Date.now();
      this.logEvent({
        type: 'COMPLETE',
        studentId: student.id,
        name: student.name,
        message: `Student completed and submitted Google Form response`
      });
      this.scheduleSave();
    }
    return student;
  }

  resetStudentStrikes(studentId) {
    const student = this.data.students[studentId];
    if (!student) return null;

    student.strikes = 0;
    student.status = 'active';
    delete student.terminatedAt;
    this.logEvent({
      type: 'PARDON',
      studentId: student.id,
      name: student.name,
      message: `Teacher reset violations & pardoned student`
    });
    this.scheduleSave();
    return student;
  }

  updatePing(studentId) {
    const student = this.data.students[studentId];
    if (student) {
      student.lastPing = Date.now();
    }
  }

  logEvent(event) {
    const entry = {
      id: Date.now() + '-' + Math.random().toString(36).substr(2, 5),
      time: new Date().toISOString(),
      timestamp: Date.now(),
      ...event
    };
    this.data.events.unshift(entry);
    // Keep max 1000 events in memory
    if (this.data.events.length > 1000) {
      this.data.events.pop();
    }
  }

  getEvents(limit = 50) {
    return this.data.events.slice(0, limit);
  }

  getStats() {
    const students = Object.values(this.data.students);
    const now = Date.now();
    let total = students.length;
    let active = 0;
    let warned = 0;
    let terminated = 0;
    let completed = 0;
    let offline = 0;

    for (const s of students) {
      const isOnline = now - s.lastPing < 20000;
      if (s.status === 'terminated') terminated++;
      else if (s.status === 'completed') completed++;
      else if (s.status === 'warned') warned++;
      else if (isOnline) active++;
      else offline++;
    }

    return { total, active, warned, terminated, completed, offline };
  }

  clearAllData() {
    this.data.students = {};
    this.data.events = [];
    this.forceSave();
  }
}

module.exports = new ExamDatabase();

