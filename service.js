const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json()); // <-- Add this line

const PORT = 8097;

const esp32Clients = [];
const audioQueue = [];
let receiveList = [
  // { id: 'device1', name: 'Device 1', ImageBase64: '', isConnect: 'timestamp' },
];

let receiveSelected = [
  //"id"
];



//google
const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, 'intercom-463016-9268ece115a4.json'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});


// Route สำหรับ ESP32 เข้ามารับ stream
app.get('/stream', async (req, res) => {
  console.log('[ESP32] Connected to /stream');
  const deviceId = req?.query?.deviceId;
  const now = Date.now() + (7 * 60 * 60 * 1000); // เวลาในเขต Bangkok (UTC+7)
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

  esp32Clients.push({ deviceId, res });

  req.on('close', async () => {
    console.log('[ESP32] Disconnected');
    // ไม่ต้องเปลี่ยนค่า isConnect ให้เก็บ timestamp ล่าสุดไว้
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

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});


