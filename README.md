# Dropline

A Telegram-style web app for sharing files, links and messages between your devices (or with friends). Create a session, get a 6-digit code + QR, open it anywhere — everything syncs instantly.

## Run

```
npm install   # first time only
npm start
```

Then open:
- **This PC:** http://localhost:3210
- **Phone / other devices:** the `http://192.168.x.x:3210` address printed in the terminal (must be on the same Wi-Fi). If it doesn't load, allow Node.js through Windows Firewall (private networks).

## How it works

1. **Create a session** → you get a 6-digit code and a QR.
2. On your phone, scan the QR (opens the join link directly) or open the site and tap **Join with code**.
3. Chat, paste links (auto-clickable), drag-and-drop or attach files (up to 500 MB, images preview inline). Everything appears live on all connected devices.
4. Sessions persist across restarts — the sidebar shows all sessions this device has joined, newest activity first.

## Tech

- **Server:** Node.js + Express + `ws` WebSockets — event-loop concurrency handles many simultaneous users/sessions.
- **Frontend:** vanilla HTML/CSS/JS, no build step, ~40 KB total → instant load.
- **Storage:** messages/sessions in `data/store.json`, uploaded files in `data/uploads/` (delete the `data` folder to reset everything).
- Change the port with the `PORT` env var.
