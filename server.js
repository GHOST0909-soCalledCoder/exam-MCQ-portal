const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const cors = require('cors');
const { WebSocketServer, WebSocket } = require('ws');
const db = require('./db');

// Auto-resolve forms.gle shortlinks to full embed URL for mobile iframe reliability
async function normalizeFormUrl(inputUrl) {
  if (!inputUrl) return inputUrl;
  let url = inputUrl.trim();

  if (url.includes('forms.gle/')) {
    try {
      url = await new Promise((resolve) => {
        https.get(url, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            resolve(res.headers.location);
          } else {
            resolve(url);
          }
        }).on('error', () => resolve(url));
      });
    } catch (e) {
      console.warn('Failed to resolve forms.gle shortlink:', e.message);
    }
  }

  // Ensure ?embedded=true
  if (url.includes('docs.google.com/forms') && !url.includes('embedded=true')) {
    url += (url.includes('?') ? '&' : '?') + 'embedded=true';
  }

  return url;
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname)); // Fallback if files were uploaded to root

// Explicit route for student exam portal (/)
app.get('/', (req, res) => {
  const possiblePaths = [
    path.join(__dirname, 'public', 'index.html'),
    path.join(__dirname, 'index.html')
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return res.sendFile(p);
  }
  res.status(404).send(`
    <div style="font-family: sans-serif; text-align: center; padding: 50px;">
      <h2 style="color: #ef4444;">⚠️ Frontend Files Missing</h2>
      <p>The Node.js server is running perfectly on Render, but the <b>public/</b> folder was not uploaded to your GitHub repository.</p>
      <p>Please upload the <b>public/</b> folder (containing index.html, admin.html, css, js) to your GitHub repository to view the portal.</p>
    </div>
  `);
});

// Explicit route for proctor dashboard (/admin)
app.get('/admin', (req, res) => {
  const possiblePaths = [
    path.join(__dirname, 'public', 'admin.html'),
    path.join(__dirname, 'admin.html')
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return res.sendFile(p);
  }
  res.status(404).send('<h2>admin.html not found. Please upload the public folder to GitHub.</h2>');
});

// In-memory socket maps for ultra-fast messaging
const studentSockets = new Map(); // studentId -> Set of ws
const adminSockets = new Set(); // Set of ws

// Broadcast helper to all connected admin proctors
function broadcastToAdmins(payload) {
  const message = JSON.stringify(payload);
  for (const client of adminSockets) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

// Broadcast helper to all connected students
function broadcastToStudents(payload) {
  const message = JSON.stringify(payload);
  for (const sockets of studentSockets.values()) {
    for (const client of sockets) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }
}

// Send message to a specific student
function sendToStudent(studentId, payload) {
  const sockets = studentSockets.get(studentId);
  if (!sockets) return false;
  const message = JSON.stringify(payload);
  for (const client of sockets) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
  return true;
}

// ==================== REST API ROUTES ====================

// Get current exam configuration
app.get('/api/config', (req, res) => {
  res.json({
    success: true,
    config: db.getConfig()
  });
});

// Update exam configuration (Admin)
app.post('/api/config', async (req, res) => {
  const body = req.body;
  if (body.formUrl) {
    body.formUrl = await normalizeFormUrl(body.formUrl);
  }
  const updated = db.updateConfig(body);
  broadcastToAdmins({ type: 'CONFIG_UPDATED', config: updated });
  broadcastToStudents({ type: 'CONFIG_UPDATED', config: updated });
  res.json({ success: true, config: updated });
});

// Register / Login student before exam
app.post('/api/register', (req, res) => {
  const { name, rollNo, section } = req.body;
  if (!name || !rollNo) {
    return res.status(400).json({ success: false, error: 'Name and Roll Number are required' });
  }

  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  const student = db.registerStudent({ name, rollNo, section, ip: clientIp });
  const config = db.getConfig();

  broadcastToAdmins({
    type: 'STUDENT_JOINED',
    student: student,
    stats: db.getStats()
  });

  res.json({
    success: true,
    student,
    config
  });
});

// Record anti-cheat violation (REST fallback)
app.post('/api/violation', (req, res) => {
  const { studentId, violationType, details } = req.body;
  if (!studentId || !violationType) {
    return res.status(400).json({ success: false, error: 'Missing required parameters' });
  }

  const updatedStudent = db.recordViolation(studentId, violationType, details);
  if (!updatedStudent) {
    return res.status(404).json({ success: false, error: 'Student not found' });
  }

  broadcastToAdmins({
    type: 'VIOLATION_RECORDED',
    student: updatedStudent,
    stats: db.getStats(),
    events: db.getEvents(10)
  });

  // If terminated, push terminate command to student's sockets
  if (updatedStudent.status === 'terminated') {
    sendToStudent(studentId, {
      type: 'TERMINATE',
      student: updatedStudent,
      reason: violationType
    });
  }

  res.json({ success: true, student: updatedStudent });
});

// Mark exam as submitted / completed
app.post('/api/complete', (req, res) => {
  const { studentId } = req.body;
  if (!studentId) {
    return res.status(400).json({ success: false, error: 'Missing studentId' });
  }

  const student = db.completeExam(studentId);
  if (!student) {
    return res.status(404).json({ success: false, error: 'Student not found' });
  }

  broadcastToAdmins({
    type: 'STUDENT_COMPLETED',
    student: student,
    stats: db.getStats()
  });

  res.json({ success: true, student });
});

// Admin: Get all students and stats
app.get('/api/students', (req, res) => {
  res.json({
    success: true,
    stats: db.getStats(),
    students: db.getAllStudents(),
    events: db.getEvents(50)
  });
});

// Admin: Reset strikes / pardon student
app.post('/api/students/:id/reset', (req, res) => {
  const studentId = req.params.id;
  const student = db.resetStudentStrikes(studentId);
  if (!student) {
    return res.status(404).json({ success: false, error: 'Student not found' });
  }

  sendToStudent(studentId, { type: 'PARDONED', student });

  broadcastToAdmins({
    type: 'STUDENT_PARDONED',
    student: student,
    stats: db.getStats()
  });

  res.json({ success: true, student });
});

// Admin: Clear student records for new test session
app.post('/api/clear-records', (req, res) => {
  db.clearAllData();
  broadcastToAdmins({
    type: 'DATA_CLEARED',
    stats: db.getStats(),
    students: [],
    events: []
  });
  res.json({ success: true, message: 'All exam records cleared' });
});

// Admin: Export CSV report of student infractions
app.get('/api/export-csv', (req, res) => {
  const students = db.getAllStudents();
  const config = db.getConfig();

  let csv = 'Roll Number,Name,Section,Status,Strikes,Start Time,End Time,Total Violations,Violation Log\n';

  for (const s of students) {
    const startTimeStr = s.startTime ? new Date(s.startTime).toLocaleString() : 'N/A';
    const endTimeStr = s.completedAt ? new Date(s.completedAt).toLocaleString() : (s.terminatedAt ? new Date(s.terminatedAt).toLocaleString() : 'In Progress');
    
    // Format violations list
    const logDetails = (s.violations || []).map(v => `[${new Date(v.timestamp).toLocaleTimeString()}] ${v.type} (${v.details || ''})`).join('; ');

    const safeName = `"${(s.name || '').replace(/"/g, '""')}"`;
    const safeSection = `"${(s.section || '').replace(/"/g, '""')}"`;
    const safeLog = `"${logDetails.replace(/"/g, '""')}"`;

    csv += `${s.rollNo},${safeName},${safeSection},${s.status.toUpperCase()},${s.strikes},"${startTimeStr}","${endTimeStr}",${s.violations ? s.violations.length : 0},${safeLog}\n`;
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=Exam_Report_${Date.now()}.csv`);
  res.send(csv);
});

// Navigation helper routes
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ==================== WEBSOCKET HANDLING ====================

wss.on('connection', (ws, req) => {
  let boundStudentId = null;
  let role = null;

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (messageRaw) => {
    try {
      const data = JSON.parse(messageRaw);

      switch (data.type) {
        case 'IDENTIFY':
          role = data.role;
          if (role === 'admin') {
            adminSockets.add(ws);
            ws.send(JSON.stringify({
              type: 'INIT_ADMIN',
              config: db.getConfig(),
              stats: db.getStats(),
              students: db.getAllStudents(),
              events: db.getEvents(50)
            }));
          } else if (role === 'student' && data.studentId) {
            boundStudentId = data.studentId.trim().toUpperCase();
            if (!studentSockets.has(boundStudentId)) {
              studentSockets.set(boundStudentId, new Set());
            }
            studentSockets.get(boundStudentId).add(ws);
            db.updatePing(boundStudentId);
          }
          break;

        case 'PING':
          if (boundStudentId) {
            db.updatePing(boundStudentId);
          }
          ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
          break;

        case 'DIAGNOSTIC':
          console.log(`[📱 PHONE TELEMETRY - ${boundStudentId || 'ANON'}]:`, JSON.stringify(data));
          break;

        case 'VIOLATION':
          if (boundStudentId && data.violationType) {
            const student = db.recordViolation(boundStudentId, data.violationType, data.details || '');
            if (student) {
              // Send response back to student
              ws.send(JSON.stringify({
                type: 'VIOLATION_ACK',
                strikes: student.strikes,
                status: student.status,
                maxStrikes: db.getConfig().maxStrikes,
                violationType: data.violationType
              }));

              // Notify all teacher admins
              broadcastToAdmins({
                type: 'VIOLATION_RECORDED',
                student,
                stats: db.getStats(),
                events: db.getEvents(10)
              });

              if (student.status === 'terminated') {
                sendToStudent(boundStudentId, {
                  type: 'TERMINATE',
                  student,
                  reason: data.violationType
                });
              }
            }
          }
          break;

        case 'ADMIN_BROADCAST':
          if (role === 'admin' && data.message) {
            broadcastToStudents({
              type: 'ANNOUNCEMENT',
              message: data.message
            });
          }
          break;

        case 'ADMIN_TERMINATE_STUDENT':
          if (role === 'admin' && data.studentId) {
            const student = db.recordViolation(data.studentId, 'Manual Proctor Disqualification', 'Flagged by Teacher');
            if (student) {
              sendToStudent(data.studentId, {
                type: 'TERMINATE',
                student,
                reason: 'Disqualified manually by exam invigilator'
              });
              broadcastToAdmins({
                type: 'VIOLATION_RECORDED',
                student,
                stats: db.getStats()
              });
            }
          }
          break;
      }
    } catch (e) {
      console.error('Error handling WebSocket message:', e.message);
    }
  });

  ws.on('close', () => {
    if (role === 'admin') {
      adminSockets.delete(ws);
    }
    if (boundStudentId && studentSockets.has(boundStudentId)) {
      const set = studentSockets.get(boundStudentId);
      set.delete(ws);
      if (set.size === 0) {
        studentSockets.delete(boundStudentId);
      }
    }
  });
});

// Periodic WebSocket heartbeat & stale connection cleanup (30s)
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(interval);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🚀 College Anti-Cheat MCQ Exam Portal Running`);
  console.log(`📡 Local Access   : http://localhost:${PORT}`);
  console.log(`📱 Mobile (LAN)   : http://192.168.0.245:${PORT}`);
  console.log(`🛡️ Proctor Admin  : http://192.168.0.245:${PORT}/admin`);
  console.log(`⚡ Android & iOS Ready: Optimized for 400+ mobile & desktop users`);
  console.log(`====================================================`);
});

