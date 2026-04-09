const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const multer = require('multer');

// ================== กัน crash ==================
process.on("uncaughtException", err => {
  console.error("🔥 UNCAUGHT:", err);
});
process.on("unhandledRejection", err => {
  console.error("🔥 UNHANDLED:", err);
});

// ================== optional modules ==================
let ffmpeg;
try {
  const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
  ffmpeg = require('fluent-ffmpeg');
  ffmpeg.setFfmpegPath(ffmpegPath);
} catch (err) {
  console.log("⚠️ ffmpeg not available");
}

let play;
try {
  play = require('play-dl');
} catch (err) {
  console.log("⚠️ play-dl not available");
}

// ================== folders ==================
const uploadDir = path.join(__dirname, 'uploads');
const pcmDir = path.join(__dirname, 'pcm_files');

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(pcmDir)) fs.mkdirSync(pcmDir);

// ================== app ==================
const app = express();
const server = http.createServer(app);

// ✅ CORS FIX
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "*");
  next();
});

app.use(cors());
app.use(express.json());

const upload = multer({ dest: uploadDir });

// ================== test API ==================
app.get('/time', (req, res) => {
  try {
    const now = new Date();
    const nowTH = new Date(now.getTime() + 7 * 60 * 60 * 1000);

    const h = String(nowTH.getHours()).padStart(2, '0');
    const m = String(nowTH.getMinutes()).padStart(2, '0');
    const s = String(nowTH.getSeconds()).padStart(2, '0');

    res.json({
      thailand_time: `${h}:${m}:${s}`
    });

  } catch (err) {
    console.error("❌ /time error:", err);
    res.status(500).json({ error: "server error" });
  }
});

// ================== device list ==================
let receiveList = [];

app.get('/receiveList', (req, res) => {
  try {
    res.json({ receiveList });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "error" });
  }
});

// ================== stream ==================
const clients = [];

app.get('/stream', (req, res) => {
  try {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Connection': 'keep-alive'
    });

    clients.push(res);

    req.on('close', () => {
      const i = clients.indexOf(res);
      if (i !== -1) clients.splice(i, 1);
    });

  } catch (err) {
    console.error("❌ stream error:", err);
  }
});

// ================== websocket ==================
const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
  ws.on('message', msg => {
    clients.forEach(res => {
      try {
        res.write(msg);
      } catch {}
    });
  });
});

// ================== PORT ==================
const PORT = process.env.PORT || 8097;

server.listen(PORT, () => {
  console.log("✅ Server running on port", PORT);
});