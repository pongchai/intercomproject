const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfmpegPath(ffmpegPath);

const schedule = require("node-schedule");

const { PassThrough } = require("stream");
let scheduleList = []; // { id, url, schedAt, mode, job }

let esp32Messages = {}; // เก็บข้อความล่าสุดของแต่ละ device
const upload = multer({ dest: 'uploads/' });

const pcmFolder = path.join(__dirname, 'pcm_files');
if (!fs.existsSync(pcmFolder)) fs.mkdirSync(pcmFolder);


const app = express();
let streamStartTime = 0;

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "*");
  next();
});

app.use(cors());
app.use(express.json()); // <-- Add this line

const PORT = process.env.PORT || 8080;

const esp32Clients = [];
const audioQueue = [];
const MAX_QUEUE = 50;

let receiveList = [
  // { id: 'device1', name: 'Device 1', ImageBase64: '', isConnect: 'timestamp' },
];

let receiveSelected = [
  //"id"
];

// Route สำหรับ ESP32 เข้ามารับ stream
app.get('/stream', async (req, res) => {
  try {
    req.setTimeout(0);

    const deviceId = req?.query?.deviceId;

    if (!deviceId) {
      return res.status(400).end();
    }

    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Connection': 'keep-alive'
    });

    const keepAlive = setInterval(() => {
      if (!res.writableEnded) {
        res.write(" ");
      }
    }, 2000);

    const index = esp32Clients.findIndex(c => c.deviceId === deviceId);

    if (index !== -1) {
      console.log("♻️ replace old connection:", deviceId);
      esp32Clients[index].res.end();
      esp32Clients[index] = { deviceId, res };
    } else {
      esp32Clients.push({ deviceId, res });
    }

    // 🔥 เพิ่ม device เข้า receiveList อัตโนมัติ
const existsDevice = receiveList.find(d => d.id === deviceId);

if (!existsDevice) {
  console.log("➕ add device to receiveList:", deviceId);

  receiveList.push({
    id: deviceId,
    name: deviceId,
    ImageBase64: '',
    lastetUpdate: Date.now()
  });
}

    req.on('close', () => {
      clearInterval(keepAlive);
      const index = esp32Clients.findIndex(c => c.res === res);
      if (index !== -1) esp32Clients.splice(index, 1);
    });

  } catch (err) {
    console.error("🔥 STREAM ERROR:", err);
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

wss.on('connection', ws => {
  console.log('[Browser] WebSocket connected');
  ws.on('message', msg => {
    const buffer = Buffer.from(msg);

    const queueLen = audioQueue.length;

    if (queueLen > MAX_QUEUE) {
      console.log("🔥 overflow → trim queue");
      audioQueue.splice(0, Math.floor(queueLen / 2));
    } else if (queueLen > 20) {
      console.log("⚠️ mild lag → drop half");
      audioQueue.splice(0, Math.floor(queueLen / 2));
    }

    if (audioQueue.length >= MAX_QUEUE) {
      audioQueue.shift();
    }

    audioQueue.push(buffer);
  });
  ws.on('close', () => console.log('[Browser] Disconnected'));
});

// ปรับ Interval จาก 1ms เป็น 40-50ms เพื่อให้เหมาะสมกับ Buffer ของ ESP32
// และส่งข้อมูลเป็นก้อนที่ใหญ่ขึ้นเล็กน้อย
setInterval(() => {

  // 🔥 STEP 1: ไม่มี client → หยุด stream ทันที
  if (esp32Clients.length === 0) {
    console.log("🛑 no clients → stop stream");

    try {
      currentStream.destroy();
    } catch (e) {}

    if (currentFFmpeg) {
      try {
        currentFFmpeg.kill('SIGKILL');
      } catch (e) {}
    }

    currentStream = null;
    currentFFmpeg = null;
    isPlaying = false;
  }

  // 🔥 debug log (สุ่ม)
  if (Math.random() < 0.1) {
    console.log("Queue:", audioQueue.length, "Clients:", esp32Clients.length);
  }

  // 🔥 STEP 2: ส่งเสียงปกติ
  if (
    audioQueue.length > 0 &&
    esp32Clients.length > 0 &&
    Array.isArray(receiveSelected)
  ) {
    const chunksToSend = audioQueue.splice(0, 2);
    const finalBuffer = Buffer.concat(chunksToSend);

    esp32Clients.forEach(client => {
      try {
        if (
          receiveSelected.length === 0 ||
          receiveSelected.includes(client.deviceId)
        ) {
          if (!client.res.writableEnded) {
            const ok = client.res.write(finalBuffer);
            if (!ok) {
              console.log("⚠️ slow client:", client.deviceId);
            }
          }
        }
      } catch (err) {
        console.error('[ERROR] Stream failed:', err.message);
      }
    });
  }

}, 40);


setInterval(() => {
  if (esp32Clients.length > 0) {
    const now = Date.now() + (7 * 60 * 60 * 1000);
    
    // อัปเดตค่าใน Array เดิมโดยตรง
    receiveList.forEach(device => {
      const isStillConnected = esp32Clients.some(client => client.deviceId === device.id);
      if (isStillConnected) {
        device.lastetUpdate = now;
      }
    });
  }
}, 15000); // 15 วินาที


// schedule

async function playAudioToESP32(pcmFile, targetDevices = []) {
  const filePath = path.join(pcmFolder, pcmFile);
  if (!fs.existsSync(filePath)) return console.error('PCM file not found:', pcmFile);

  console.log(`[Scheduler] Starting stream: ${pcmFile}`);

  // ส่งข้อความไปโชว์ที่หน้าจอ ESP32
  esp32Clients.forEach(client => {
    if (targetDevices.includes(client.deviceId)) {
      esp32Messages[client.deviceId] = "           " + pcmFile;
      setTimeout(() => {
        esp32Messages[client.deviceId] = " ";
      }, 1000 * 30);
    }
  });

  // ใช้ Stream เพื่ออ่านไฟล์ทีละนิด ไม่กิน RAM
  const readStream = fs.createReadStream(filePath, { highWaterMark: 1024 }); // อ่านทีละ 1KB

  for await (const chunk of readStream) {
    esp32Clients.forEach(client => {
      if (
        targetDevices.length === 0 ||
        targetDevices.includes(client.deviceId)
      ) {
        if (!client.res.writableEnded) {
          try {
            client.res.write(chunk);
          } catch (e) {
            console.error("write fail:", client.deviceId);
          }
        }
      }
    });
    // หน่วงเวลาเล็กน้อยเพื่อให้สัมพันธ์กับ Sample Rate (16kHz)
    // 1024 bytes / (16000 samples/sec * 2 bytes/sample) ≈ 32ms
    await new Promise(r => setTimeout(r, 30));
  }
  
  console.log(`[Scheduler] Finished stream: ${pcmFile}`);
}


// POST /schedule
app.post("/schedule", (req, res) => {
  const { fileName, schedAt, mode, devices } = req.body;
  if (!fileName || !schedAt) return res.status(400).json({ error: "Missing fields" });

  const id = Date.now();
  const jobTime = new Date(schedAt);
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

        schedule.scheduleJob(next, async () => {
          await playAudioToESP32(fileName, devices || []);
        });

        // 🔥 ไม่ต้อง push ใหม่
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
  const jobTime = new Date(schedAt);
  item.job = schedule.scheduleJob(jobTime, async () => {
    await playAudioToESP32(fileName);
    if (mode === "ครั้งเดียว") {
      scheduleList = scheduleList.filter(i => i.id !== id);
    } else if (mode === "ทุกวัน") {
      const next = new Date(jobTime.getTime() + 24*60*60*1000);
      item.schedAt = next.toISOString();
      item.job = schedule.scheduleJob(next, async () => {
        await playAudioToESP32(fileName);
      });
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
  const outputName = `${Date.now()}_${originalName}.pcm`;
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

const ytdl = require('@distube/ytdl-core');

let currentStream = null;
let currentFFmpeg = null;
let isPlaying = false;

app.post('/playYoutubeToDevice', async (req, res) => {
  const { url, devices } = req.body;

  if (!url) return res.status(400).json({ error: "No URL" });

  try {
    // 🔥 kill ของเก่า
    if (currentStream) {
      try { currentStream.destroy(); } catch (e) {}
      currentStream = null;
    }

    if (currentFFmpeg) {
      try { currentFFmpeg.kill('SIGKILL'); } catch (e) {}
      currentFFmpeg = null;
    }

    if (isPlaying) {
      console.log("⚠️ already playing → restart");
    }

    isPlaying = true;

    currentStream = ytdl(url, {
      filter: 'audioonly',
      quality: 'highestaudio'
    });

    currentFFmpeg = ffmpeg(currentStream);

    const ffmpegStream = currentFFmpeg
      .format('s16le')
      .audioCodec('pcm_s16le')
      .audioChannels(1)
      .audioFrequency(16000)
      .on('error', err => console.error("FFmpeg error:", err))
      .pipe();

    // 🔥 WATCHDOG
    const watchdog = setTimeout(() => {
      console.log("⏱ watchdog: force stop");

      if (currentStream) currentStream.destroy();
      if (currentFFmpeg) {
        try { currentFFmpeg.kill('SIGKILL'); } catch (e) {}
      }

      currentStream = null;
      currentFFmpeg = null;
      isPlaying = false;

    }, 1000 * 60 * 10);

    // 🔥 END
    ffmpegStream.on('end', () => {
      console.log("[FFmpeg] ended");

      clearTimeout(watchdog);

      currentStream = null;
      currentFFmpeg = null;
      isPlaying = false;
    });

    // 🔥 ERROR
    ffmpegStream.on('error', (err) => {
      console.error("[FFmpeg Stream Error]", err);

      clearTimeout(watchdog);

      currentStream = null;
      currentFFmpeg = null;
      isPlaying = false;
    });

    // 🔥 PROCESS CLOSE
    currentFFmpeg.on('close', () => {
      console.log("[FFmpeg] process closed");
      currentFFmpeg = null;
    });

    // 🔥 ส่งเสียง
    ffmpegStream.on('data', (chunk) => {

    // 🔥 ไม่มี client → หยุด YouTube ทันที
      if (esp32Clients.length === 0) {
        console.log("🛑 no clients → stop youtube stream");

        if (currentStream) {
          try { currentStream.destroy(); } catch (e) {}
        }

        if (currentFFmpeg) {
          try { currentFFmpeg.kill('SIGKILL'); } catch (e) {}
        }

        currentStream = null;
        currentFFmpeg = null;
        isPlaying = false;

        return;
      }

      // 🔥 ส่งเสียงปกติ
      esp32Clients.forEach(client => {
        if (!devices || devices.includes(client.deviceId)) {
          if (!client.res.writableEnded) {
            try {
              client.res.write(chunk);
            } catch (e) {
              console.error("write fail:", client.deviceId);
            }
          }
        }
      });

    });

    res.json({ success: true });

  } catch (err) {
    console.error("YT ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/syncTime', (req, res) => {
  res.json({ startTime: streamStartTime });
});

server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

setInterval(() => {
  for (let i = esp32Clients.length - 1; i >= 0; i--) {
    if (
      !esp32Clients[i].res ||
      esp32Clients[i].res.writableEnded ||
      esp32Clients[i].res.destroyed
    ) {
      console.log("🧹 remove dead client:", esp32Clients[i].deviceId);
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