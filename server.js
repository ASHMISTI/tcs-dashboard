/**
 * TCS Real-Time Observability Engine - Backend Server
 * Serves static files and streams synthetic Apache/Nginx-style access logs via WebSocket.
 * Simulates a production Express.js API server with realistic traffic patterns.
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const LOG_FILE = path.join(__dirname, 'access.log');

// ─── Serve static frontend files ───────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Dummy auth endpoint
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'admin' && password === 'admin123') {
    return res.json({ success: true, token: 'demo-jwt-token-xyz' });
  }
  return res.status(401).json({ success: false, message: 'Invalid credentials' });
});

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ─── Log generation config ──────────────────────────────────────────────────
const ENDPOINTS = [
  { path: '/api/users', method: 'GET',    weight: 15 },
  { path: '/api/products', method: 'GET', weight: 12 },
  { path: '/api/orders', method: 'POST',  weight: 8  },
  { path: '/api/auth/login', method: 'POST', weight: 6 },
  { path: '/api/cart', method: 'GET',     weight: 10 },
  { path: '/api/cart', method: 'PUT',     weight: 5  },
  { path: '/api/payments', method: 'POST', weight: 4 },
  { path: '/api/search', method: 'GET',   weight: 11 },
  { path: '/api/categories', method: 'GET', weight: 9},
  { path: '/api/reports', method: 'GET',  weight: 3  },
  { path: '/static/bundle.js', method: 'GET', weight: 7 },
  { path: '/favicon.ico', method: 'GET',  weight: 2  },
  { path: '/api/admin/config', method: 'GET', weight: 2 },
  { path: '/api/webhooks', method: 'POST', weight: 3 },
  { path: '/api/notifications', method: 'GET', weight: 5 },
];

const STATUS_CODES = [
  { code: 200, weight: 55 }, { code: 201, weight: 10 },
  { code: 304, weight: 8  }, { code: 400, weight: 6  },
  { code: 401, weight: 4  }, { code: 403, weight: 3  },
  { code: 404, weight: 7  }, { code: 429, weight: 2  },
  { code: 500, weight: 3  }, { code: 502, weight: 1  },
  { code: 503, weight: 1  },
];

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14) Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14) Mobile Chrome/120',
  'PostmanRuntime/7.36.1',
  'python-requests/2.31.0',
  'axios/1.6.0',
  'curl/8.4.0',
];

const IP_POOL = [
  '103.21.244.1','185.220.101.45','45.33.32.156','192.168.1.101',
  '10.0.0.52','172.16.0.8','203.0.113.42','198.51.100.77',
  '54.239.28.85','13.107.42.16','192.168.10.200','8.8.8.8',
];

function weightedRandom(items) {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = Math.random() * total;
  for (const item of items) { r -= item.weight; if (r <= 0) return item; }
  return items[0];
}

function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function generateLatency(statusCode) {
  // Errors and 5xx tend to be slower
  if (statusCode >= 500) return randomInt(800, 8000);
  if (statusCode === 429) return randomInt(50, 200);
  if (statusCode >= 400) return randomInt(10, 300);
  // Normal distribution approximation for success paths
  const base = randomInt(20, 400);
  const spike = Math.random() < 0.05 ? randomInt(1000, 3000) : 0; // 5% spikes
  return base + spike;
}

function generateLogEntry() {
  const ep     = weightedRandom(ENDPOINTS);
  const status = weightedRandom(STATUS_CODES);
  const latency = generateLatency(status.code);
  const bytes   = status.code === 304 ? 0 : randomInt(512, 65536);
  const ip      = pick(IP_POOL);
  const ua      = pick(USER_AGENTS);
  const ts      = new Date().toISOString();

  const apacheLog = `${ip} - - [${new Date().toUTCString()}] "${ep.method} ${ep.path} HTTP/1.1" ${status.code} ${bytes} "-" "${ua}" ${latency}ms`;

  return {
    timestamp: ts,
    ip,
    method: ep.method,
    path: ep.path,
    status: status.code,
    bytes,
    latency,
    userAgent: ua,
    raw: apacheLog,
  };
}

// ─── Broadcast to all WS clients ───────────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

// ─── Append to log file ────────────────────────────────────────────────────
function appendLog(entry) {
  fs.appendFile(LOG_FILE, entry.raw + '\n', () => {});
}

// ─── Log emission loop ─────────────────────────────────────────────────────
let logInterval = null;
let batchMode   = false;

function startLogEmitter() {
  // Emit 1-3 logs per second normally, occasionally burst
  const emit = () => {
    const count = Math.random() < 0.1 ? randomInt(5, 15) : randomInt(1, 3);
    for (let i = 0; i < count; i++) {
      const entry = generateLogEntry();
      appendLog(entry);
      broadcast({ type: 'log', data: entry });
    }
    const nextDelay = randomInt(300, 1200);
    logInterval = setTimeout(emit, nextDelay);
  };
  emit();
}

// ─── WebSocket connection handler ───────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('[WS] Client connected. Total:', wss.clients.size);

  // Send server info on connect
  ws.send(JSON.stringify({
    type: 'server_info',
    data: {
      name: 'TCS-Observability Demo Express Server',
      version: '3.8.1',
      node: process.version,
      uptime: process.uptime(),
      pid: process.pid,
      endpoints: ENDPOINTS.map(e => e.path),
    }
  }));

  ws.on('close', () => console.log('[WS] Client disconnected. Total:', wss.clients.size));
  ws.on('error', err => console.error('[WS] Error:', err.message));
});

// ─── Start server ──────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🚀 TCS Observability Server running on http://localhost:${PORT}`);
  console.log(`📊 WebSocket streaming on ws://localhost:${PORT}`);
  console.log(`📄 Log file: ${LOG_FILE}\n`);
  startLogEmitter();
});
