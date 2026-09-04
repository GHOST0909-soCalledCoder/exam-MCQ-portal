# 🛡️ College Anti-Cheat MCQ Exam Portal

A high-concurrency, lightweight anti-cheat examination portal designed for college MCQ tests embedded with **Google Forms**. 

It enforces fullscreen mode, detects tab-switching and window minimization, sounds an alert alarm on Strike 1, and **immediately terminates and locks out the student on Strike 2**, while giving invigilators a real-time command dashboard.

---

## 🚀 Key Features

- **Google Form Embedding:** Teachers can paste any Google Form link directly from the dashboard.
- **Anti-Cheat Engine:**
  - **Tab-Switch & Minimize Detection:** Uses the `Page Visibility API` and `Window Blur` event.
  - **Fullscreen Enforcement:** Student must enter fullscreen; exiting fullscreen triggers a strike.
  - **Two-Strike Rule:**
    - **Strike 1:** Audible siren alarm + visual strike warning modal.
    - **Strike 2:** **Immediate Test Auto-Termination**: the Google Form iframe is instantly removed from the DOM, student is locked out, and an incident report is submitted.
  - **Hotkey & DevTools Blocking:** Blocks `F12`, `Ctrl+Shift+I`, `Ctrl+U`, `Ctrl+C`, `Ctrl+V`, `Ctrl+W`, `Ctrl+T`, `Alt+Tab`, and right-click.
- **Teacher Proctoring Command Center (`/admin`):**
  - Real-time student tracking (Active, Warned, Disqualified, Completed).
  - Live incident feed with timestamps.
  - Ability to change the Google Form URL on the fly.
  - Student pardon/reset capability (in case of accidental triggers).
  - Broadcast announcements directly to student screens.
  - **1-Click CSV Export** for official college records.
- **High Concurrency Performance:**
  - Built with **Node.js (Express) + WebSockets (`ws`)**.
  - **Tested and verified with 400+ concurrent students** using only ~76 MB RAM and zero crashes.

---

## 🏃 How to Run the Server

### 1. Start the Server
Open a terminal in this directory:
```bash
npm start
```
The server will start on port `3000`:
- **Student Exam Portal:** `http://localhost:3000`
- **Teacher Proctor Dashboard:** `http://localhost:3000/admin`

---

## 🌐 Running for 400+ Students in College (Campus LAN / Wi-Fi)

To let all 400 students connect from college lab computers or laptops:
1. Find your host computer's local IP address (e.g., `192.168.1.100` on Windows by running `ipconfig`).
2. Share the URL with students:
   ```
  
   ```
3. Open the Teacher Dashboard on the teacher's PC:
   ```
   
   ```
4. Paste your Google Form link into the **Exam Configuration** section and click **Save Config**.

---

## 🧪 Concurrency Load Testing

To simulate 400 concurrent students connecting, pinging, and committing violations:
```bash
npm run test:load
```
Results will display execution times, memory usage, and zero dropped sockets.

