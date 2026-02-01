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
const DONE_FILE = path.join(__dirname, 'done-ids.txt');
const FAILED_FILE = path.join(__dirname, 'failed-ids.txt');
const REMAINING_FILE = path.join(__dirname, 'remaining-ids.txt');
const RESULT_DIR = path.join(__dirname, 'result-json');

// const API_URL = 'https://api.scrapingdog.com/profile';
const API_URL = 'http://localhost:3000/api/test';
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
  doneIds: [],
  failedIds: [],
  failedDetails: {}, // { status, message } 
  remainingTimeSec: 0,
  progressPct: 0,
  shouldStop: false,
  runStats: null, // { done, failed, startedAt }
};

async function readDoneIds() {
  try {
    const content = await fs.readFile(DONE_FILE, 'utf-8');
    return parseIds(content);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function readFailedIds() {
  try {
    const content = await fs.readFile(FAILED_FILE, 'utf-8');
    return parseIds(content);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function getStateFromFiles() {
  const todoIds = await readTodoIds();
  const doneIds = await readDoneIds();
  const failedIds = await readFailedIds();
  const remainingIds =
    state.overall === 'running'
      ? state.remainingIds
      : await readRemainingIds();
  const totalIds = todoIds.length;
  const doneCount = doneIds.length;
  const failedCount = failedIds.length;
  const remainingCount = remainingIds.length;
  const progressPct =
    totalIds > 0
      ? Math.round(((doneCount + failedCount) / totalIds) * 100)
      : 100;
  const failedIdsList = failedIds.map((id) => ({
    id,
    status: state.failedDetails[id]?.status,
    message: state.failedDetails[id]?.message,
  }));
  return {
    totalIds,
    doneCount,
    failedCount,
    remainingCount,
    remainingIds,
    doneIds,
    failedIds,
    failedIdsList,
    progressPct,
  };
}

async function emitState() {
  const fileState = await getStateFromFiles();
  io.emit('state', { ...state, ...fileState });
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
  try {
    const content = await fs.readFile(TODO_FILE, 'utf-8');
    return parseIds(content);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
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

async function regenerateRemainingIds() {
  try {
    const todoIds = await readTodoIds();
    const doneIds = await readDoneIds();
    const failedIds = await readFailedIds();
    
    const doneSet = new Set(doneIds);
    const failedSet = new Set(failedIds);
    
    const remaining = todoIds.filter(id => !doneSet.has(id) && !failedSet.has(id));
    
    await writeRemaining(remaining);
    console.log(`Regenerated remaining-ids.txt: ${remaining.length} IDs remaining`);
    return remaining;
  } catch (e) {
    console.error('Failed to regenerate remaining-ids.txt:', e.message);
    return [];
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
  // Regenerate remaining-ids.txt on server startup
  await regenerateRemainingIds();
  
  while (true) {
    state.overall = 'stopped';
    state.phase = 'pending';
    state.doneCount = 0;
    state.failedCount = 0;
    state.failedDetails = {};
    state.runStats = null;
    state.shouldStop = false;
    await emitState();

    await ensureResultDir();

    // Wait for Start button
    while (state.overall !== 'running' && !state.shouldStop) {
      await sleep(200);
    }
    if (state.shouldStop) continue;

    // On Start: regenerate remaining-ids.txt to ensure sync
    const ids = await regenerateRemainingIds();
    state.remainingIds = [...ids];
    await emitState();
    if (ids.length === 0) {
      console.log('No remaining IDs to process');
      continue;
    }

    const runStartedAt = Date.now();
    let runDone = 0;
    let runFailed = 0;
    const batchTimes = [];

    while (ids.length > 0 && !state.shouldStop) {
      const batch = ids.splice(0, CONCURRENCY);
      state.phase = 'pending';
      await emitState();

      const batchStart = Date.now();
      const promises = batch.map((id) =>
        processOneId(id).then(async (r) => {
          if (r.success) {
            state.doneCount++;
            runDone++;
          } else {
            state.failedCount++;
            runFailed++;
            state.failedDetails[r.id] = { status: r.status, message: r.message };
          }
          await emitState();
          return r;
        })
      );
      await Promise.all(promises);
      const batchElapsed = Date.now() - batchStart;
      batchTimes.push(batchElapsed);

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
      await emitState();

      if (ids.length > 0 && !state.shouldStop) {
        state.phase = 'sleeping';
        await emitState();
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
    await emitState();
  }
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', async (req, res) => {
  const fileState = await getStateFromFiles();
  res.json({ ...state, ...fileState });
});

app.post('/api/start', (req, res) => {
  if (state.overall === 'running') {
    return res.status(400).json({ error: 'Already running' });
  }
  state.shouldStop = false;
  state.overall = 'running';
  emitState().then(() => res.json({ ok: true })).catch(() => res.json({ ok: true }));
});

app.post('/api/stop', (req, res) => {
  state.shouldStop = true;
  res.json({ ok: true });
});

io.on('connection', () => {
  emitState().catch(() => {});
});

server.listen(PORT, () => {
  console.log(`Dashboard: http://localhost:${PORT}`);
  runProcessor().catch((err) => {
    console.error('Processor error:', err);
    state.overall = 'stopped';
    state.phase = 'pending';
    emitState().catch(() => {});
  });
});
