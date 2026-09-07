const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'exam_data.json');

// Default initial config with 3 strikes
const defaultData = {
  config: {
    examTitle: "College MCQ Examination",
    formUrl: "https://docs.google.com/forms/d/e/1FAIpQLSd-PjZnx1jxPjFjnn58gMrHd6elziU-tBtcsLJKK2-m235L_Q/viewform?usp=send_form&embedded=true",
    durationMinutes: 60,
    maxStrikes: 3, // 3 strikes: 2 warnings, 3rd strike terminates
    requireFullscreen: true,
    blockShortcuts: true,
    active: true
  },
  exams: {},
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
        
        // Ensure default 3 strikes if not explicitly set
        const config = { 
          ...defaultData.config, 
          ...(parsed.config || {}),
          maxStrikes: (parsed.config && parsed.config.maxStrikes) || 3
        };

        // Seed initial exam from config if exams collection is empty
        let exams = parsed.exams || {};
        if (Object.keys(exams).length === 0) {
          const defaultExamId = 'exam-default';
          exams[defaultExamId] = {
            id: defaultExamId,
            title: config.examTitle || "General MCQ Test",
            formUrl: config.formUrl || defaultData.config.formUrl,
            durationMinutes: config.durationMinutes || 60,
            maxStrikes: 3,
            teacherName: "General Exam",
            active: true,
            createdAt: Date.now()
          };
        }

        return {
          config,
          exams,
          students: parsed.students || {},
          events: parsed.events || []
        };
      }
    } catch (err) {
      console.error('Error reading exam_data.json, using defaults:', err.message);
    }
    
    // Fallback if file doesn't exist
    const initial = JSON.parse(JSON.stringify(defaultData));
    const defaultExamId = 'exam-default';
    initial.exams[defaultExamId] = {
      id: defaultExamId,
      title: initial.config.examTitle,
      formUrl: initial.config.formUrl,
      durationMinutes: initial.config.durationMinutes,
      maxStrikes: 3,
      teacherName: "General Exam",
      active: true,
      createdAt: Date.now()
    };
    return initial;
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

  // Global Config
  getConfig() {
    return this.data.config;
  }

  updateConfig(newConfig) {
    this.data.config = { ...this.data.config, ...newConfig };
    this.scheduleSave();
    return this.data.config;
  }

  // ==================== MULTI-EXAM MANAGEMENT ====================

  getAllExams() {
    return Object.values(this.data.exams || {});
  }

  getActiveExams() {
    return Object.values(this.data.exams || {}).filter(e => e.active !== false);
  }

  getExam(examId) {
    if (!examId) return null;
    return (this.data.exams && this.data.exams[examId]) || null;
  }

  createExam({ title, formUrl, durationMinutes, teacherName, maxStrikes = 3, active = true }) {
    const id = 'exam-' + Date.now().toString(36) + '-' + Math.random().toString(36).substr(2, 4);
    const newExam = {
      id,
      title: (title || 'New MCQ Exam').trim(),
      formUrl: (formUrl || '').trim(),
      durationMinutes: parseInt(durationMinutes, 10) || 60,
      maxStrikes: parseInt(maxStrikes, 10) || 3,
      teacherName: (teacherName || 'Faculty').trim(),
      active: active !== false,
      createdAt: Date.now()
    };

    if (!this.data.exams) this.data.exams = {};
    this.data.exams[id] = newExam;

    this.logEvent({
      type: 'EXAM_CREATED',
      examId: id,
      title: newExam.title,
      message: `Teacher created new exam: "${newExam.title}" (${newExam.teacherName})`
    });

    this.scheduleSave();
    return newExam;
  }

  updateExam(examId, updates) {
    const exam = this.getExam(examId);
    if (!exam) return null;

    if (updates.title !== undefined) exam.title = updates.title.trim();
    if (updates.formUrl !== undefined) exam.formUrl = updates.formUrl.trim();
    if (updates.durationMinutes !== undefined) exam.durationMinutes = parseInt(updates.durationMinutes, 10) || 60;
    if (updates.teacherName !== undefined) exam.teacherName = updates.teacherName.trim();
    if (updates.maxStrikes !== undefined) exam.maxStrikes = parseInt(updates.maxStrikes, 10) || 3;
    if (updates.active !== undefined) exam.active = !!updates.active;
    exam.updatedAt = Date.now();

    this.logEvent({
      type: 'EXAM_UPDATED',
      examId,
      title: exam.title,
      message: `Exam updated: "${exam.title}"`
    });

    this.scheduleSave();
    return exam;
  }

  deleteExam(examId) {
    if (this.data.exams && this.data.exams[examId]) {
      const title = this.data.exams[examId].title;
      delete this.data.exams[examId];

      this.logEvent({
        type: 'EXAM_DELETED',
        examId,
        title,
        message: `Teacher deleted exam: "${title}"`
      });

      this.scheduleSave();
      return true;
    }
    return false;
  }

  // ==================== STUDENT MANAGEMENT ====================

  getStudent(studentId) {
    return this.data.students[studentId] || null;
  }

  getAllStudents(examId = null) {
    const students = Object.values(this.data.students || {});
    if (examId && examId !== 'all') {
      return students.filter(s => s.examId === examId);
    }
    return students;
  }

  registerStudent({ name, rollNo, section, ip, examId }) {
    const studentId = rollNo.trim().toUpperCase();
    const existing = this.data.students[studentId];

    // Find the exam the student is enrolling into
    let targetExam = this.getExam(examId);
    if (!targetExam) {
      const activeList = this.getActiveExams();
      targetExam = activeList.length > 0 ? activeList[0] : Object.values(this.data.exams)[0];
    }

    const assignedExamId = targetExam ? targetExam.id : 'exam-default';
    const assignedExamTitle = targetExam ? targetExam.title : 'MCQ Exam';
    const assignedMaxStrikes = targetExam ? (targetExam.maxStrikes || 3) : 3;

    if (existing) {
      existing.name = name.trim();
      existing.section = (section || '').trim();
      existing.lastPing = Date.now();
      existing.ip = ip;
      // If switching to a different exam room, reset session strikes cleanly
      if (existing.examId !== assignedExamId) {
        existing.examId = assignedExamId;
        existing.examTitle = assignedExamTitle;
        existing.strikes = 0;
        existing.status = 'active';
        existing.violations = [];
        delete existing.terminatedAt;
        delete existing.completedAt;
      }
      existing.maxStrikes = assignedMaxStrikes;
      if (existing.exempt === undefined) existing.exempt = false;
      this.scheduleSave();
      return existing;
    }

    const student = {
      id: studentId,
      rollNo: studentId,
      name: name.trim(),
      section: (section || '').trim(),
      ip: ip || '127.0.0.1',
      examId: assignedExamId,
      examTitle: assignedExamTitle,
      startTime: Date.now(),
      lastPing: Date.now(),
      strikes: 0,
      maxStrikes: assignedMaxStrikes,
      status: 'active', // 'active', 'warned', 'terminated', 'completed'
      exempt: false, // Excluded from security rules when true
      violations: []
    };

    this.data.students[studentId] = student;
    this.logEvent({
      type: 'JOIN',
      studentId: student.id,
      name: student.name,
      examId: student.examId,
      examTitle: student.examTitle,
      message: `Student joined "${student.examTitle}"`
    });

    this.scheduleSave();
    return student;
  }

  setStudentExemption(studentId, isExempt) {
    const student = this.data.students[studentId];
    if (!student) return null;

    student.exempt = !!isExempt;
    if (student.exempt) {
      // If student was terminated, restore them to active so they can continue testing
      if (student.status === 'terminated') {
        student.status = 'active';
        delete student.terminatedAt;
      }
      this.logEvent({
        type: 'EXEMPTION_GRANTED',
        studentId: student.id,
        name: student.name,
        examId: student.examId,
        examTitle: student.examTitle,
        message: `🛡️ Security rules bypassed for ${student.name} (${student.rollNo}) [Controller Override]`
      });
    } else {
      this.logEvent({
        type: 'EXEMPTION_REVOKED',
        studentId: student.id,
        name: student.name,
        examId: student.examId,
        examTitle: student.examTitle,
        message: `🔒 Security rules re-enforced for ${student.name} (${student.rollNo})`
      });
    }

    this.scheduleSave();
    return student;
  }

  batchSetStudentExemption(studentIds, isExempt) {
    if (!Array.isArray(studentIds)) return [];
    const updated = [];
    for (const id of studentIds) {
      const res = this.setStudentExemption(id, isExempt);
      if (res) updated.push(res);
    }
    return updated;
  }

  recordViolation(studentId, violationType, details = '') {
    const student = this.data.students[studentId];
    if (!student) return null;

    // If student is excluded from security rules, ignore all infractions!
    if (student.exempt) {
      return student;
    }

    if (student.status === 'terminated' || student.status === 'completed') {
      return student;
    }

    // Server-side debouncing: minimum 4 seconds between strike increments for the same student.
    // Prevents network latency packet bursts from delivering instant multi-strikes.
    const now = Date.now();
    if (student.lastViolationTime && (now - student.lastViolationTime < 4000)) {
      student.lastPing = now;
      return student;
    }
    student.lastViolationTime = now;

    const maxStrikes = student.maxStrikes || 3;
    student.strikes += 1;
    const violationEntry = {
      strike: student.strikes,
      maxStrikes: maxStrikes,
      type: violationType,
      details: details,
      timestamp: now
    };
    student.violations.push(violationEntry);
    student.lastPing = now;

    if (student.strikes >= maxStrikes) {
      student.status = 'terminated';
      student.terminatedAt = Date.now();
      this.logEvent({
        type: 'TERMINATE',
        studentId: student.id,
        name: student.name,
        examId: student.examId,
        examTitle: student.examTitle,
        strike: student.strikes,
        message: `🚨 EXAM AUTO-TERMINATED (Strike ${student.strikes}/${maxStrikes}) - ${student.name} [${student.examTitle || 'Exam'}] - ${violationType}`
      });
    } else {
      student.status = 'warned';
      this.logEvent({
        type: 'WARNING',
        studentId: student.id,
        name: student.name,
        examId: student.examId,
        examTitle: student.examTitle,
        strike: student.strikes,
        message: `⚠️ Strike ${student.strikes}/${maxStrikes} - ${student.name} [${student.examTitle || 'Exam'}] - ${violationType}`
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
        examId: student.examId,
        examTitle: student.examTitle,
        message: `Student completed "${student.examTitle || 'Exam'}"`
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
      examId: student.examId,
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

  getEvents(limit = 50, examId = null) {
    if (examId && examId !== 'all') {
      return this.data.events.filter(e => !e.examId || e.examId === examId).slice(0, limit);
    }
    return this.data.events.slice(0, limit);
  }

  getStats(examId = null) {
    const students = this.getAllStudents(examId);
    const now = Date.now();
    let total = students.length;
    let active = 0;
    let warned = 0;
    let terminated = 0;
    let completed = 0;
    let offline = 0;
    let exempt = 0;

    for (const s of students) {
      if (s.exempt) exempt++;
      const isOnline = now - s.lastPing < 20000;
      if (s.status === 'terminated') terminated++;
      else if (s.status === 'completed') completed++;
      else if (s.status === 'warned') warned++;
      else if (isOnline) active++;
      else offline++;
    }

    return { total, active, warned, terminated, completed, offline, exempt };
  }

  clearAllData(examId = null) {
    if (examId && examId !== 'all') {
      for (const [id, s] of Object.entries(this.data.students || {})) {
        if (s.examId === examId) {
          delete this.data.students[id];
        }
      }
      this.data.events = this.data.events.filter(e => e.examId !== examId);
    } else {
      this.data.students = {};
      this.data.events = [];
    }
    this.forceSave();
  }
}

module.exports = new ExamDatabase();


