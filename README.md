# 🛡️ College Anti-Cheat MCQ Exam Portal

A high-concurrency, lightweight anti-cheat examination portal designed for college MCQ tests embedded with **Google Forms**. 

It enforces fullscreen and viewport locks, detects tab switching, app minimization, split-screen, and Android/iOS/Desktop external search overlays (**Circle to Search**, **Select to Search**), provides a customizable strike limit with audible sirens, and gives invigilators a real-time live monitoring command dashboard.

---

## 🚀 Key Features

- **Google Form Embedding & Sandbox Isolation:** Teachers can paste any Google Form link directly from the dashboard. Embedded in an isolated sandbox preventing breakout navigation to raw Google Forms.
- **Configurable Teacher Strike Limits:** Teachers can configure any arbitrary strike limit ($1$ to $99$, default: $3$) per exam and edit it live during active exams.
- **Anti-Cheat Engine (Universal Mobile & Desktop Protection):**
  - **Circle to Search & Select to Search Detection:** Real-time overlay detection catching Android Circle to Search, Samsung Smart Select, Google Lens, and desktop floating search overlays/Copilot.
  - **Tab-Switch & Minimize Detection:** Uses the `Page Visibility API`, `pagehide`, and `window.blur` events.
  - **Window-in-Window & Split-Screen Detection:** Detects floating pop-up windows and Android/iPad split-screen mode.
  - **Desktop Fullscreen Enforcement:** Enforces fullscreen on PC/Mac; exiting fullscreen triggers a strike.
  - **Keyboard Shortcut & DevTools Blocking:** Blocks `F12`, `F5`, `Ctrl+Shift+I/J/C`, `Ctrl+U`, `Ctrl+C`, `Ctrl+V`, `Ctrl+W`, `Ctrl+T`, `Ctrl+R`, `Alt+Tab`, and right-click context menu.
  - **Audible Emergency Siren:** Sounds an alarm when an infraction occurs.
  - **Automatic Disqualification:** Upon reaching the teacher-configured strike limit, the exam form is immediately revoked from the DOM and the student is locked out with an incident report.
- **Student Usability & Fair Play Safeguards:**
  - **45-Second Initial Setup & Cookie Grace Period:** Students have a 45-second buffer upon entering to accept Google cookie prompts, dismiss browser popups, or adjust settings before anti-cheat rules engage.
  - **Google Account Switcher:** Built-in modal allowing students to switch between signed-in Google accounts (`/u/0/`, `/u/1/`, or specific email) without escaping the proctored portal.
  - **Google Form Submit Grace (60s):** Dedicated button and 5-second automatic dialog tolerance preventing false strikes when Google Form's native submission alert (`"Your email address will be recorded..."`) is confirmed.
  - **Virtual Keyboard Awareness:** Prevents false split-screen alarms while typing text answers.
- **Live Proctoring Controller (`/controller` & `/admin`):**
  - Real-time student grid with WebSocket live updates (Active, Warned, Disqualified, Completed).
  - Live incident feed with timestamps, student roll numbers, and violation details.
  - Remote security exemptions, strike resets, and broadcast announcements.
  - **1-Click CSV Export** for official university and college records.
- **High Concurrency Performance:**
  - Built with **Node.js (Express) + WebSockets (`ws`)**.
  - **Load tested with 400+ concurrent students** with zero dropped connections and minimal memory footprint (~76 MB RAM).

---

## 📁 Project Structure

```
├── server.js              # Express HTTP & WebSocket real-time server
├── db.js                  # Persistent JSON database manager with batching
├── package.json           # Dependencies and project metadata
├── package-lock.json      # Dependency lockfile
├── README.md              # Project documentation
├── .gitignore             # Git ignore rules (ignores node_modules, exam_data.json)
├── test_load.js           # 400-student automated stress testing script
└── public/                # Frontend client assets
    ├── index.html         # Student examination portal & Google Form view
    ├── admin.html         # Teacher exam configuration & management panel
    ├── controller.html    # Invigilator real-time proctoring command grid
    ├── css/
    │   └── style.css      # Portal styling, dark theme, and modal dialogs
    └── js/
        ├── proctor.js     # Client-side anti-cheat engine & overlay detector
        ├── admin.js       # Teacher dashboard logic & strike configuration
        └── controller.js  # Live WebSocket proctoring controller logic
```

---

## 🏃 How to Run the Server

### 1. Install Dependencies
```bash
npm install
```

### 2. Start the Server
```bash
npm start
```
The server will start on port `3000`:
- **Student Exam Portal:** `http://localhost:3000`
- **Teacher Admin Dashboard:** `http://localhost:3000/admin`
- **Live Proctor Controller:** `http://localhost:3000/controller`

---

## 🌐 Running on Campus LAN / Wi-Fi (Multi-Device)

1. Find your host computer's local IP address (e.g. `192.168.0.245` via `ipconfig`).
2. Students can join from any phone, tablet, or PC on the same Wi-Fi:
   ```
   http://192.168.0.245:3000
   ```
3. Open the Teacher Dashboard:
   ```
   http://192.168.0.245:3000/admin
   ```

---

## 🧪 Concurrency Load Testing

To simulate 400 concurrent students taking the exam simultaneously:
```bash
npm run test:load
```


