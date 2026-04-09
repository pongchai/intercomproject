const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffmpeg = require('fluent-ffmpeg');
const play = require('play-dl');
ffmpeg.setFfmpegPath(ffmpegPath);

const schedule = require("node-schedule");

const { PassThrough } = require("stream");
let scheduleList = []; // { id, url, schedAt, mode, job }

let esp32Messages = {}; // เก็บข้อความล่าสุดของแต่ละ device
const upload = multer({ dest: 'uploads/' });

const pcmFolder = path.join(__dirname, 'pcm_files');
if (!fs.existsSync(pcmFolder)) fs.mkdirSync(pcmFolder);


const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "*");
  next();
});

app.use(cors());
app.use(express.json()); // <-- Add this line

const PORT = process.env.PORT || 8097;

const esp32Clients = [];
const audioQueue = [];
let receiveList = [
  // { id: 'device1', name: 'Device 1', ImageBase64: '', isConnect: 'timestamp' },
];

let receiveSelected = [
  //"id"
];

// Route สำหรับ ESP32 เข้ามารับ stream
app.get('/stream', async (req, res) => {
  console.log('[ESP32] Connected to /stream');
  const deviceId = req?.query?.deviceId;
  const now = Date.now() + (7 * 60 * 60 * 1000); // เวลาในเขต Bangkok  (UTC+7)
  if (receiveList.filter(device => device.id === deviceId).length === 0) {
    receiveList.push({ id: deviceId, name: '', ImageBase64: '', lastetUpdate: now });
  } else {
    // ถ้ามีอยู่แล้ว ให้ set isConnect = timestamp ล่าสุด
    receiveList = receiveList.map(device =>
      device.id === deviceId ? { ...device, lastetUpdate: now } : device
    );
  }
  console.log('Device ID:', deviceId);

  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Connection': 'keep-alive'
  });

  const keepAlive = setInterval(() => {
    try {
      res.write(" "); // กัน Railway ตัด connection
    } catch (e) {}
  }, 2000);

  esp32Clients.push({ deviceId, res });

  req.on('close', async () => {
    console.log('[ESP32] Disconnected');
    // ไม่ต้องเปลี่ยนค่า isConnect ให้เก็บ timestamp ล่าสุดไว้
    clearInterval(keepAlive);
    
    const index = esp32Clients.findIndex(client => client.res === res);
    if (index !== -1) esp32Clients.splice(index, 1);
  });
});

app.get('/receiveList', (req, res) => {
  res.status(200).json({ receiveList: receiveList});
});

app.post('/updateReceive', (req, res) => {
  const payload = req.body;
  console.log('[UPDATE] Received payload:', payload);
  if(payload.id) {
    receiveList = receiveList.map(device => {
      if(device.id === payload.id) {
        return { ...device, name: payload.name, ImageBase64: payload.ImageBase64 || '' };
      }
      return device;
    })
  }
  res.status(200).json({ receiveList: receiveList});
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

wss.on('connection', ws => {
  console.log('[Browser] WebSocket connected');
  ws.on('message', msg => {
    const buffer = Buffer.from(msg);
    // const cleanedBuffer = removeCRLF(buffer); // ✅ ใช้งานจริง
    audioQueue.push(buffer);
  });
  ws.on('close', () => console.log('[Browser] Disconnected'));
});

// Loop ส่งเสียงไปยัง ESP32 ทุก ๆ 1 ms
setInterval(() => {
  if (audioQueue.length > 0 && esp32Clients.length > 0) {
    const chunk = audioQueue.shift();
    esp32Clients.forEach(client => {
      try {
      if(receiveSelected.includes(client.deviceId)) {
        client.res.write(chunk);
      }
      } catch (err) {
        console.error('[ERROR] Write to ESP32 failed:', err.message);
      }
    });
  }
}, 1);

setInterval(() => {
  if (esp32Clients.length > 0) {
    esp32Clients.forEach(client => {
      try {
        receiveList.map(device => {
          if (device.id === client.deviceId) {
            device.lastetUpdate = Date.now() + (7 * 60 * 60 * 1000); // อัพเดทเวลาเป็น UTC+7
          }
          return device;
        });
       
      } catch (err) {
        console.error('err', err.message);
      }
    });
  }
}, 15000);// 15 วินาที

// schedule

async function playAudioToESP32(pcmFile, targetDevices = []) {
  
  const filePath = path.join(pcmFolder, pcmFile);
  if (!fs.existsSync(filePath)) return console.error('PCM file not found:', pcmFile);

  const pcmData = fs.readFileSync(filePath);
  const chunkSize = 1024;

  (async () => {
    esp32Clients.forEach(client => {
    if (targetDevices.includes(client.deviceId)) {
      try {
        esp32Messages[client.deviceId] = "           " + pcmFile;
        setTimeout(() => {
          esp32Messages[client.deviceId] = " ";
        }, 1000*30);
      } catch {}
    }
    });


    for (let i = 0; i < pcmData.length; i += chunkSize) {
      const chunk = pcmData.slice(i, i + chunkSize);
      esp32Clients.forEach(client => {
        if (targetDevices.includes(client.deviceId)) {
          try { client.res.write(chunk); } catch {}
        }
      });
      await new Promise(r => setTimeout(r, 1));
    }
  })();
}

async function streamYoutubeToESP32(url, targetDevices = []) {
  try {
    const stream = await play.stream(url);

    const pcmStream = ffmpeg(stream.stream)
      .audioCodec("pcm_s16le")
      .audioChannels(1)
      .audioFrequency(16000)
      .format("s16le")
      .pipe();

    pcmStream.on("data", chunk => {
      esp32Clients.forEach(client => {
        if (targetDevices.includes(client.deviceId)) {
          client.res.write(chunk);
        }
      });
    });

  } catch (err) {
    console.error("Play-dl error:", err.message);
  }
}

// POST /schedule
app.post("/schedule", (req, res) => {
  const { fileName, schedAt, mode, devices } = req.body;
  if (!fileName || !schedAt) return res.status(400).json({ error: "Missing fields" });

  const id = Date.now();
  const schedAtUTC = new Date(schedAt + "+07:00").toISOString();
  const jobTime = new Date(schedAtUTC)
  console.log("[Scheduler] Schedule job at:", jobTime.toString());

  const job = schedule.scheduleJob(jobTime, async () => {
  console.log("[Scheduler] Job triggered at:", new Date().toISOString());
    if (!esp32Clients.length) {
      console.log("[Scheduler] No ESP32 clients connected");
      return;
    }
    await  playAudioToESP32(fileName, devices || [] );

    if (mode === "ครั้งเดียว") {
      scheduleList = scheduleList.filter(i => i.id !== id);
    } else if (mode === "ทุกวัน") {
      const next = new Date(jobTime.getTime() + 24*60*60*1000);
      scheduleList = scheduleList.map(i => i.id === id ? { ...i, schedAt: next.toISOString() } : i);
      schedule.scheduleJob(next, async () => await playAudioToESP32(fileName, devices || [] ));
    }
  });

  scheduleList.push({ id, fileName, schedAt, mode, job });
  const sendList = scheduleList.map(({ job, ...rest }) => rest);
  res.json({ scheduleList: sendList, timeNow: new Date().toISOString() });
});

app.put("/schedule/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const { fileName, schedAt, mode } = req.body;
  let item = scheduleList.find(i => i.id === id);
  if (!item) {
    return res.status(404).json({ error: "Schedule not found" });
  }
  // Cancel old job if exists
  if (item.job) item.job.cancel();

  // Update fields
  item.fileName = fileName;
  item.schedAt = schedAt;
  item.mode = mode;

  // Reschedule job
  const schedAtUTC = new Date(schedAt + "+07:00").toISOString();
  const jobTime = new Date(schedAtUTC);
  item.job = schedule.scheduleJob(jobTime, async () => {
    await playAudioToESP32(fileName);
    if (mode === "ครั้งเดียว") {
      scheduleList = scheduleList.filter(i => i.id !== id);
    } else if (mode === "ทุกวัน") {
      const next = new Date(jobTime.getTime() + 24*60*60*1000);
      item.schedAt = next.toISOString();
      item.job = schedule.scheduleJob(next, async () => await playAudioToESP32(fileName));
    }
  });

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

  const inputPath = req.file.path;
  console.log(req.file);
  
  const originalName = req.file.originalname.replace(/\.[^/.]+$/, "");
  const outputName = originalName + '.pcm';
  const outputPath = path.join(pcmFolder, outputName);

  try {
    ffmpeg(inputPath)
      .outputOptions([
        '-f s16le',      // PCM 16-bit little endian
        '-acodec pcm_s16le',
        '-ac 1',         // mono channel
        '-ar 16000'      // 16 kHz sample rate
      ])
      .save(outputPath)
      .on('end', () => {
        // ลบไฟล์ต้นฉบับหลังแปลงเสร็จ
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

app.post("/playYoutubeToDevice", async (req, res) => {
  const { url, devices } = req.body;

  if (!url) {
    return res.status(400).json({ error: "No URL" });
  }

  console.log("Play YouTube:", url);

  streamYoutubeToESP32(url, devices || []);

  res.json({ success: true });
});

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

server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});