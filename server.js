const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3847;
const CONCURRENCY = 4;
const TODO_FILE = path.join(__dirname, 'todo-list-ids.txt');
const TODO_FILE_ALT = path.join(__dirname, 'todo_list_ids.txt');
const DONE_FILE = path.join(__dirname, 'done-ids.txt');
const FAILED_FILE = path.join(__dirname, 'failed-ids.txt');
const REMAINING_FILE = path.join(__dirname, 'remaining-ids.txt');
const RESULT_DIR = path.join(__dirname, 'result-json');

const API_URL = 'https://api.scrapingdog.com/profile';
const STATUS_MESSAGES = {
  200: 'Successful Request',
  410: 'Request timeout',
  404: 'URL is wrong',
  202: 'Your request is accepted and the scraping is still going on.',
  403: 'Request Limit Reached.',
  429: 'Concurrent connection limit reached.',
  401: 'API Key is wrong.',
  400: 'Request failed.',
};

let state = {
  overall: 'stopped', // running | stopped
  phase: 'pending',  // pending | sleeping
  totalIds: 0,
  doneCount: 0,
  failedCount: 0,
  remainingIds: [],
  failedIdsList: [],
  remainingTimeSec: 0,
  progressPct: 0,
  shouldStop: false,
  shouldPause: false,
  runStats: null, // { done, failed, startedAt } when stopped
  lastBatchTimingMs: 0,
};

function emitState() {
  io.emit('state', { ...state });
}

async function ensureResultDir() {
  try {
    await fs.mkdir(RESULT_DIR, { recursive: true });
  } catch (e) {
    console.error('Failed to create result-json:', e.message);
  }
}

function parseIds(content) {
  return content
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function readTodoIds() {
  for (const file of [TODO_FILE, TODO_FILE_ALT]) {
    try {
      const content = await fs.readFile(file, 'utf-8');
      return parseIds(content);
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
  }
  return [];
}

async function readRemainingIds() {
  try {
    const content = await fs.readFile(REMAINING_FILE, 'utf-8');
    return parseIds(content);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function appendLine(filePath, line) {
  try {
    await fs.appendFile(filePath, line + '\n');
  } catch (e) {
    console.error('Append failed:', filePath, e.message);
  }
}

async function writeRemaining(ids) {
  try {
    await fs.writeFile(REMAINING_FILE, ids.join('\n') + (ids.length ? '\n' : ''));
  } catch (e) {
    console.error('Write remaining failed:', e.message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(minMs, maxMs) {
  return minMs + Math.random() * (maxMs - minMs);
}

async function callProfileApi(id) {
  const params = {
    api_key: '697d20a6c1c25317df41062b',
    id,
    type: 'profile',
    premium: 'true',
    webhook: 'false',
    fresh: 'false',
  };
  const res = await axios.get(API_URL, {
    params,
    validateStatus: () => true,
    timeout: 60000,
  });
  return { status: res.status, data: res.data };
}

async function processOneId(id) {
  try {
    const { status, data } = await callProfileApi(id);
    const message = STATUS_MESSAGES[status] || `HTTP ${status}`;

    if (status === 200) {
      await fs.writeFile(
        path.join(RESULT_DIR, `${id}.json`),
        JSON.stringify(data, null, 2)
      );
      await appendLine(DONE_FILE, id);
      return { success: true, id, status, message };
    }

    await appendLine(FAILED_FILE, id);
    return { success: false, id, status, message };
  } catch (err) {
    const message = err.response
      ? STATUS_MESSAGES[err.response.status] || `HTTP ${err.response.status}`
      : err.message || 'Network/Unknown error';
    await appendLine(FAILED_FILE, id);
    return { success: false, id, status: err.response?.status ?? 0, message };
  }
}

async function runProcessor() {
  while (true) {
    state.overall = 'stopped';
    state.phase = 'pending';
    state.doneCount = 0;
    state.failedCount = 0;
    state.failedIdsList = [];
    state.runStats = null;
    state.shouldStop = false;
    emitState();

    // Pre-load for display: use remaining if exists, else todo
    let displayIds = await readRemainingIds();
    if (displayIds.length === 0) displayIds = await readTodoIds();
    state.totalIds = displayIds.length;
    state.remainingIds = [...displayIds];
    state.progressPct = displayIds.length ? 0 : 100;
    state.remainingTimeSec = 0;
    emitState();

    await ensureResultDir();

    // Wait for Start button
    while (state.overall !== 'running' && !state.shouldStop) {
      await sleep(200);
    }
    if (state.shouldStop) continue;

    // On Start: use remaining-ids.txt to resume, else todo-list-ids.txt
    let ids = await readRemainingIds();
    if (ids.length === 0) ids = await readTodoIds();
    state.totalIds = ids.length;
    state.remainingIds = [...ids];
    state.progressPct = ids.length ? 0 : 100;
    emitState();
    if (ids.length === 0) continue;

    const runStartedAt = Date.now();
    let runDone = 0;
    let runFailed = 0;
    const batchTimes = [];

    while (ids.length > 0 && !state.shouldStop) {
      const batch = ids.splice(0, CONCURRENCY);
      state.phase = 'pending';
      emitState();

      const batchStart = Date.now();
      const results = await Promise.all(batch.map((id) => processOneId(id)));
      const batchElapsed = Date.now() - batchStart;
      batchTimes.push(batchElapsed);

      for (const r of results) {
        if (r.success) {
          state.doneCount++;
          runDone++;
        } else {
          state.failedCount++;
          runFailed++;
          state.failedIdsList.push({ id: r.id, status: r.status, message: r.message });
        }
      }

      state.remainingIds = [...ids];
      state.progressPct =
        state.totalIds > 0
          ? Math.round(((state.doneCount + state.failedCount) / state.totalIds) * 100)
          : 100;

      const avgBatchMs =
        batchTimes.length > 0
          ? batchTimes.reduce((a, b) => a + b, 0) / batchTimes.length
          : 0;
      const batchesLeft = Math.ceil(ids.length / CONCURRENCY);
      const delayMs = randomDelay(2000, 4000);
      state.remainingTimeSec = Math.round(
        (batchesLeft * (avgBatchMs + (2000 + 4000) / 2)) / 1000
      );
      emitState();

      if (ids.length > 0 && !state.shouldStop) {
        state.phase = 'sleeping';
        emitState();
        await sleep(delayMs);
      }
    }

    if (state.shouldStop && ids.length > 0) {
      await writeRemaining(ids);
    }

    state.overall = 'stopped';
    state.phase = 'pending';
    state.runStats = {
      done: runDone,
      failed: runFailed,
      startedAt: runStartedAt,
    };
    state.remainingIds = [...ids];
    state.remainingTimeSec = 0;
    emitState();
  }
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', (req, res) => {
  res.json(state);
});

app.post('/api/start', (req, res) => {
  if (state.overall === 'running') {
    return res.status(400).json({ error: 'Already running' });
  }
  state.shouldStop = false;
  state.overall = 'running';
  emitState();
  res.json({ ok: true });
});

app.post('/api/stop', (req, res) => {
  state.shouldStop = true;
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  emitState();
});

server.listen(PORT, () => {
  console.log(`Dashboard: http://localhost:${PORT}`);
  runProcessor().catch((err) => {
    console.error('Processor error:', err);
    state.overall = 'stopped';
    state.phase = 'pending';
    emitState();
  });
});
