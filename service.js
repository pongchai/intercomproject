const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const { Innertube } = require("youtubei.js");
const { PassThrough } = require("stream");
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { performance } = require('perf_hooks');

ffmpeg.setFfmpegPath(ffmpegPath);

const schedule = require("node-schedule");

let scheduleList = []; // { id, url, schedAt, mode, job }

let esp32Messages = {}; // เก็บข้อความล่าสุดของแต่ละ device
const upload = multer({ dest: 'uploads/' });

const pcmFolder = path.join(__dirname, 'pcm_files');
if (!fs.existsSync(pcmFolder)) fs.mkdirSync(pcmFolder);

const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  next();
});

app.use(cors());
app.options("*", cors());
app.use(express.json()); // <-- Add this line

const PORT = process.env.PORT || 8080;

const esp32Clients = [];
const audioQueue = [];
let keepAliveActive = true;
const MAX_QUEUE = 10;

let receiveList = [
  // { id: 'device1', name: 'Device 1', ImageBase64: '', isConnect: 'timestamp' },
];

let receiveSelected = [
  //"id"
];

// แก้ route /stream
app.get('/stream', async (req, res) => {
    try {
        req.setTimeout(0);
        const deviceId = req?.query?.deviceId;
        if (!deviceId) return res.status(400).end();

        res.writeHead(200, {
            'Content-Type': 'audio/octet-stream',
            'Connection': 'keep-alive',
            'Cache-Control': 'no-cache, no-store',
            'X-Accel-Buffering': 'no',
            'Transfer-Encoding': 'chunked',
            'Access-Control-Allow-Origin': '*'
        });
        res.flushHeaders();

        // ✅ ไม่มี keepAlive interval เลย — ไม่ส่งอะไรตอนเงียบ

        const index = esp32Clients.findIndex(c => c.deviceId === deviceId);
        if (index !== -1) {
            esp32Clients[index].res = res;
        } else {
            esp32Clients.push({ deviceId, res });
        }

        const existsDevice = receiveList.find(d => d.id === deviceId);
        if (!existsDevice) {
            receiveList.push({
                id: deviceId,
                name: deviceId,
                ImageBase64: '',
                lastetUpdate: Date.now() + (7 * 60 * 60 * 1000)
            });
        }

        req.on('close', () => {
            const idx = esp32Clients.findIndex(c => c.res === res);
            if (idx !== -1) esp32Clients.splice(idx, 1);
        });

    } catch (err) {
        console.error("STREAM ERROR:", err);
    }
});

app.get('/receiveList', (req, res) => {
  res.status(200).json({ receiveList: receiveList});
});

app.post('/updateReceive', (req, res) => {
  const payload = req.body;

  const index = receiveList.findIndex(d => d.id === payload.id);

  if (index !== -1) {
    receiveList[index] = {
      ...receiveList[index],
      name: payload.name,
      ImageBase64: payload.ImageBase64 || ''
    };
  } else {
    // 🔥 เพิ่มใหม่
    receiveList.push({
      id: payload.id,
      name: payload.name || payload.id,
      ImageBase64: payload.ImageBase64 || '',
      lastetUpdate: Date.now()
    });
  }

  res.json({ receiveList });
});

app.post('/selectedReceive', (req, res) => {
  const payload = req.body;
  console.log('[selected-receive] Received payload:', payload);
  receiveSelected = payload.selected || [];
  res.status(200).json({ receiveSelected: receiveSelected});
});

// สร้าง HTTP server จาก express app
const server = http.createServer(app);

// WebSocket Server สำหรับ Browser ส่งเสียง
const wss = new WebSocket.Server({ server, path: '/broadcast' });

let audioLogCount = 0;
wss.on('connection', ws => {
    console.log('📡 Browser WS connected');

    const TARGET_CHUNK = 4096;
    const MIN_BUFFER = TARGET_CHUNK * 3; // ✅ สะสม 3 chunks ก่อนเริ่มส่ง
    let jitterBuf = Buffer.alloc(0);
    let bufferReady = false; // ✅ รอให้ buffer เต็มพอก่อน

    function flushToClients() {
        if (jitterBuf.length === 0) return;
        if (receiveSelected.length === 0) {
            jitterBuf = Buffer.alloc(0);
            bufferReady = false;
            return;
        }

        // ✅ รอสะสม buffer ก่อน ลด underrun
        if (!bufferReady) {
            if (jitterBuf.length >= MIN_BUFFER) {
                bufferReady = true;
            } else {
                return;
            }
        }

        while (jitterBuf.length >= TARGET_CHUNK) {
            const chunk = jitterBuf.slice(0, TARGET_CHUNK);
            jitterBuf = jitterBuf.slice(TARGET_CHUNK);
            esp32Clients.forEach(client => {
                const allowSend = receiveSelected.includes(client.deviceId);
                if (!allowSend || client.res.writableEnded) return;
                try { client.res.write(chunk); } catch(err) {}
            });
        }
    }

    ws.on('message', msg => {
        keepAliveActive = false;
        jitterBuf = Buffer.concat([jitterBuf, Buffer.from(msg)]);
        flushToClients();
    });

    ws.on('close', () => {
        keepAliveActive = true;
        jitterBuf = Buffer.alloc(0);
        bufferReady = false;
        receiveSelected = [];
        console.log('📡 Browser WS disconnected');
    });
});

// ===== แทนที่ setInterval ส่งเสียง (บริเวณ setInterval(() => {...}, 30)) ====

setInterval(() => {
    if (esp32Clients.length > 0) {
        const now = Date.now() + (7 * 60 * 60 * 1000);
        receiveList.forEach(device => {
            const isStillConnected = esp32Clients.some(c => c.deviceId === device.id);
            if (isStillConnected) device.lastetUpdate = now;
        });
    }
}, 15000);


// schedule

async function playAudioToESP32(pcmFile, targetDevices = []) {
  const filePath = path.join(pcmFolder, pcmFile);
  if (!fs.existsSync(filePath)) return console.error('PCM file not found:', pcmFile);

  const pcmData = fs.readFileSync(filePath);
  
  // 16000 Hz × 2 bytes = 32000 bytes/sec
  // ส่ง 3200 bytes ทุก 100ms → ตรง bitrate พอดี
  const CHUNK_SIZE = 3200;
  const DELAY_MS = 100;

  return new Promise(async (resolve) => {
    for (let i = 0; i < pcmData.length; i += CHUNK_SIZE) {
      const chunk = pcmData.slice(i, i + CHUNK_SIZE);

      const targets = esp32Clients.filter(client =>
        targetDevices.includes(client.deviceId) && !client.res.writableEnded
      );

      targets.forEach(client => {
        try { client.res.write(chunk); } catch {}
      });

      // ใช้ Promise แบบนี้แม่นกว่า setTimeout ธรรมดา
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
    resolve();
  });
}

// POST /schedule
app.post("/schedule", (req, res) => {
  const { fileName, schedAt, mode, devices } = req.body;
  if (!fileName || !schedAt) return res.status(400).json({ error: "Missing fields" });

  const id = Date.now();
  const schedAtFixed = schedAt.trim().replace(" ", "T") + ":00+07:00";
  const jobTime = new Date(schedAtFixed);

  if (isNaN(jobTime.getTime())) {
    return res.status(400).json({ error: "Invalid date: " + schedAt });
  }
  if (jobTime.getTime() <= Date.now()) {
    return res.status(400).json({ error: "เวลาผ่านไปแล้ว กรุณาเลือกเวลาในอนาคต" });
  }

  let job;

  if (mode === "ครั้งเดียว") {
    // ✅ schedule ครั้งเดียว พอเล่นจบลบทิ้ง
    job = schedule.scheduleJob(jobTime, async () => {
      console.log("[Scheduler] ครั้งเดียว triggered:", fileName);
      if (esp32Clients.length) {
        await playAudioToESP32(fileName, devices || []);
      }
      // ✅ รอเล่นจบแล้วค่อยลบ
      scheduleList = scheduleList.filter(i => i.id !== id);
      console.log("[Scheduler] ลบ schedule id:", id);
    });

  } else if (mode === "ประจำ" || mode === "จันทร์-ศุกร์") {
    // ✅ ใช้ cron — ทำงานทุกวันที่เวลานี้ ไม่ต้อง re-schedule
    const h = jobTime.getUTCHours();    // jobTime อยู่ใน UTC แล้ว (+07:00 ถูก parse แล้ว)
    const m = jobTime.getUTCMinutes();
    const days = getCronDays(mode);
    const cronExpr = `${m} ${h} * * ${days}`;
    console.log("[Scheduler] ประจำ cron:", cronExpr);

    job = schedule.scheduleJob(cronExpr, async () => {
      console.log("[Scheduler] ประจำ triggered:", fileName, new Date().toISOString());
      if (esp32Clients.length) {
        await playAudioToESP32(fileName, devices || []);
      }
    });
  }

  scheduleList.push({ id, fileName, schedAt, mode, devices, job });
  const sendList = scheduleList.map(({ job, ...rest }) => rest);
  res.json({ scheduleList: sendList, timeNow: new Date().toISOString() });
});

app.put("/schedule/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const { fileName, schedAt, mode, devices } = req.body;
  let item = scheduleList.find(i => i.id === id);
  if (!item) return res.status(404).json({ error: "Schedule not found" });

  if (item.job) item.job.cancel();

  item.fileName = fileName;
  item.schedAt = schedAt;
  item.mode = mode;
  item.devices = devices;

  const schedAtFixed = schedAt.trim().replace(" ", "T") + ":00+07:00";
  const jobTime = new Date(schedAtFixed);

  if (mode === "ครั้งเดียว") {
    item.job = schedule.scheduleJob(jobTime, async () => {
      if (esp32Clients.length) await playAudioToESP32(fileName, devices || []);
      scheduleList = scheduleList.filter(i => i.id !== id);
    });

  } else if (mode === "ประจำ") {
    const h = jobTime.getUTCHours();
    const m = jobTime.getUTCMinutes();
    const cronExpr = `${m} ${h} * * *`;
    item.job = schedule.scheduleJob(cronExpr, async () => {
      if (esp32Clients.length) await playAudioToESP32(fileName, devices || []);
    });
  }

  const sendList = scheduleList.map(({ job, ...rest }) => rest);
  res.json({ scheduleList: sendList });
});

// GET /schedule
app.get("/schedule", (req, res) => {
  const sendList = scheduleList.map(({ job, ...rest }) => rest);
  res.json({ scheduleList: sendList });
});

app.get("/schedule/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const item = scheduleList.find(i => i.id === id);
  if (!item) {
    return res.status(404).json({ error: "Schedule not found" });
  }
  // Remove job property before sending
  const { job, ...rest } = item;
  res.json(rest);
});

// DELETE /schedule/:id
app.delete("/schedule/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const item = scheduleList.find(i => i.id === id);
  if (item && item.job) item.job.cancel();
  scheduleList = scheduleList.filter(i => i.id !== id);

  const sendList = scheduleList.map(({ job, ...rest }) => rest);
  res.json({ scheduleList: sendList });
});

app.post('/uploadAudio', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  // ✅ เช็ค MP3 ก่อนเลย
  if (!req.file.originalname.toLowerCase().endsWith('.mp3')) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: "รองรับเฉพาะไฟล์ MP3 เท่านั้น" });
  }

  const inputPath = req.file.path;
  const originalName = req.file.originalname.replace(/\.[^/.]+$/, "");
  const outputName = `${Date.now()}_${originalName}.pcm`;
  const outputPath = path.join(pcmFolder, outputName);

  try {
    ffmpeg(inputPath)
      .outputOptions([
        '-f s16le',
        '-acodec pcm_s16le',
        '-ac 1',
        '-ar 16000'
      ])
      .save(outputPath)
      .on('end', () => {
        fs.unlink(inputPath, err => {
          if (err) console.error('Failed to delete temp file:', err);
        });
        res.json({ success: true, pcmFile: outputName });
        console.log('[Upload] PCM created:', outputName);
      })
      .on('error', (err) => {
        console.error('[Upload] FFmpeg error:', err);
        res.status(500).json({ error: err.message });
      });
  } catch (err) {
    console.error('[Upload] Unexpected error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/audioList', (req, res) => {
  const PCM_FOLDER = pcmFolder

  fs.readdir(PCM_FOLDER, (err, files) => {
    if (err) {
      console.error('[PCM List] Read folder error:', err);
      return res.status(500).json({ error: err.message });
    }
    // กรองเฉพาะไฟล์ .pcm
    const pcmFiles = files.filter(f => f.endsWith('.pcm'));
    res.json({ pcmFiles });
  });
});

app.post('/deleteAudio', (req, res) => {

  const { fileName } = req.body;

  if (!fileName) {
    return res.status(400).json({
      error: "No fileName"
    });
  }

  const filePath = path.join(pcmFolder, fileName);

  if (!fs.existsSync(filePath)) {

    return res.status(404).json({
      error: "File not found"
    });
  }

  fs.unlink(filePath, err => {

    if (err) {

      console.error(err);

      return res.status(500).json({
        error: err.message
      });
    }

    console.log("[DELETE AUDIO]", fileName);

    res.json({
      success: true
    });
  });
});

//stream text max7219
app.get('/getText', (req, res) => {
  const deviceId = req.query.deviceId;
  const msg = esp32Messages[deviceId] || " ";
  res.json({ msg });
});

// หน้าเว็บส่งข้อความมาที่ Node.js
app.post('/sendText', (req, res) => {
  const { deviceIds, msg } = req.body;
  if (!deviceIds || !Array.isArray(deviceIds)) {
    return res.status(400).json({ error: "deviceIds ต้องเป็น array" });
  }

  deviceIds.forEach(id => {
    esp32Messages[id] = "           " + msg;

    setTimeout(() => {
      esp32Messages[id] = " ";
    }, 1000 * 30);
  });

  res.json({ success: true, sentTo: deviceIds.length });
});

app.post('/playYoutube', async (req, res) => {
    const { url, devices } = req.body;
    if (!url) return res.status(400).json({ error: "No URL" });

    try {
      const yt = await Innertube.create();
      const info = await yt.getInfo(extractVideoId(url));
      const format = info.chooseFormat({ type: 'audio', quality: 'best' });
      const streamUrl = format.decipher(yt.session.player);

      res.json({ success: true, message: "Streaming started" });

      // Stream YouTube audio → ffmpeg → PCM → audioQueue
      const ffmpegProc = ffmpeg(streamUrl)
        .inputOptions(['-reconnect 1', '-reconnect_streamed 1'])
        .outputOptions(['-f s16le', '-acodec pcm_s16le', '-ac 1', '-ar 16000'])
        .pipe();

      const targetDevices = devices || receiveSelected;

      ffmpegProc.on('data', (chunk) => {
        // ส่งตรงไปยัง ESP32 clients เลย
        esp32Clients.forEach(client => {
          if (
            targetDevices.length === 0 ||
            targetDevices.includes(client.deviceId)
          ) {
            if (!client.res.writableEnded) {
              try { client.res.write(chunk); } catch(e) {}
            }
          }
        });
      });

      ffmpegProc.on('error', (err) => {
        console.error('[YouTube] ffmpeg error:', err.message);
      });

      ffmpegProc.on('end', () => {
        console.log('[YouTube] Stream ended');
      });

    } catch (err) {
      console.error('[YouTube]', err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  // helper
  function extractVideoId(url) {
    const m = url.match(/(?:youtube\.com.*[?&]v=|youtu\.be\/)([^&\n?#]+)/);
    return m ? m[1] : url;
  }

// API เช็คเวลาปัจจุบัน
app.get('/time', (req, res) => {
  const now = new Date();

  // เวลาไทย UTC+7
  // การคำนวณนี้ทำให้ได้เวลาในเขต Bangkok โดยไม่ต้องพึ่งพา TimeZone ของ Node.js Environment
  const nowTH = new Date(now.getTime() + 7 * 60 * 60 * 1000);

  // แปลงปีเป็น พ.ศ.
  const yearTH = nowTH.getFullYear() + 543;

  // เดือน + วัน เติม 0 ข้างหน้า
  const day = String(nowTH.getDate()).padStart(2, '0');
  const month = String(nowTH.getMonth() + 1).padStart(2, '0');

  // สร้างรูปแบบวันที่ dd/mm/yyyy (พ.ศ.)
  const thailand_date = `${day}/${month}/${yearTH}`;

  // **ส่วนที่เพิ่มเข้ามา: การสร้างรูปแบบเวลา HH:MM:SS**
  const hours = String(nowTH.getHours()).padStart(2, '0');
  const minutes = String(nowTH.getMinutes()).padStart(2, '0');
  const seconds = String(nowTH.getSeconds()).padStart(2, '0');

  // สร้างรูปแบบเวลา HH:MM:SS
  const thailand_time = `${hours}:${minutes}:${seconds}`;

  res.json({
    utc: now.toISOString(),
    timestamp: now.getTime(),
    thailand: nowTH.toISOString(),
    thailand_string: nowTH.toLocaleString("th-TH", { timeZone: 'Asia/Bangkok' }),
    thailand_date,
    // ส่งกลับเวลา HH:MM:SS ตามที่ต้องการ
    thailand_time 
  });
});


app.get('/syncTime', (req, res) => {
  res.json({ startTime: Date.now() });
});

app.get('/ping', (req,res)=>{

  res.json({ ok:true });

});

server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

// ✅ ใหม่
// เดิม — logic กลับด้าน
setInterval(() => {
  for (let i = esp32Clients.length - 1; i >= 0; i--) {
    if (!esp32Clients[i].res?.writableEnded === false ||  
        esp32Clients[i].res.destroyed) {
      esp32Clients.splice(i, 1);
    }
  }
}, 10000);

// ✅ แก้เป็น
setInterval(() => {
  for (let i = esp32Clients.length - 1; i >= 0; i--) {
    const r = esp32Clients[i].res;
    if (!r || r.writableEnded || r.destroyed) {
      console.log('🧹 remove dead client:', esp32Clients[i].deviceId);
      esp32Clients.splice(i, 1);
    }
  }
}, 10000);

process.on('uncaughtException', err => {
  console.error('🔥 UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', err => {
  console.error('🔥 UNHANDLED REJECTION:', err);
});