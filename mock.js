const express = require('express');
const { Random, MersenneTwister19937 } = require('random-js');

const app = express();

// RNG engine
const engine = MersenneTwister19937.autoSeed();
const random = new Random(engine);

const RESPONSES = [
  {
    status: 200,
    message: 'Successful Request',
    value: { givenID: null },
    chance: 85
  },
  {
    status: 404,
    message: 'URL is wrong',
    chance: 2
  },
  {
    status: 429,
    message: 'Concurrent connection limit reached',
    chance: 4
  },
  {
    status: 400,
    message: 'Request failed',
    chance: 9
  }
];

app.get('/api/test', async (req, res) => {
  const { id } = req.query;

  console.log(`Received request with id: ${id} at ${new Date().toISOString()}`);

  // create weighted table
  const weighted = RESPONSES.flatMap(r =>
    Array(r.chance).fill(r)
  );

  // weighted random pick
  const selected = random.pick(weighted);

  // random delay 2000–4000 ms
  const delay = random.integer(2000, 4000);

  setTimeout(() => {
    const payload = {
      status: selected.status,
      message: selected.message
    };

    if (selected.value) {
      payload.value = {
        ...selected.value,
        givenID: id ?? null
      };
    }

    res.status(selected.status).json(payload);
  }, delay);
});

app.listen(3000, () => {
  console.log('Mock API running on http://localhost:3000');
});
