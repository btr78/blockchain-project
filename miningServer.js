const express = require('express');
const path = require('path');
const { Blockchain, Transaction, generateKeyPair } = require('./blockchain');
const { MiningMachine } = require('./miningMachine');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const blockchain = new Blockchain(null);
const miners = new Map();

// --- API Routes ---

// Register a new miner (called when iPhone connects)
app.post('/api/miner/register', (req, res) => {
  const { powerMode } = req.body;
  const keyPair = generateKeyPair();
  const minerId = require('crypto').randomBytes(8).toString('hex');

  const machine = new MiningMachine({
    keyPair,
    difficulty: blockchain.difficulty,
    powerMode: powerMode || 'balanced',
  });
  machine.initialize(blockchain);

  miners.set(minerId, machine);

  res.json({
    minerId,
    minerAddress: keyPair.publicKey.substring(0, 64) + '...',
    difficulty: blockchain.difficulty,
    powerMode: machine.powerMode,
    profiles: machine.getDeviceProfile(),
  });
});

// Start mining for a registered miner
app.post('/api/miner/:id/start', (req, res) => {
  const machine = miners.get(req.params.id);
  if (!machine) return res.status(404).json({ error: 'Miner not found' });

  const result = machine.startContinuousMining();
  res.json(result);
});

// Stop mining
app.post('/api/miner/:id/stop', (req, res) => {
  const machine = miners.get(req.params.id);
  if (!machine) return res.status(404).json({ error: 'Miner not found' });

  const result = machine.stopMining();
  res.json(result);
});

// Mine a single block
app.post('/api/miner/:id/mine-block', (req, res) => {
  const machine = miners.get(req.params.id);
  if (!machine) return res.status(404).json({ error: 'Miner not found' });

  try {
    const result = machine.mineBlock();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get miner stats
app.get('/api/miner/:id/stats', (req, res) => {
  const machine = miners.get(req.params.id);
  if (!machine) return res.status(404).json({ error: 'Miner not found' });

  res.json(machine.getStats());
});

// Set power mode
app.post('/api/miner/:id/power-mode', (req, res) => {
  const machine = miners.get(req.params.id);
  if (!machine) return res.status(404).json({ error: 'Miner not found' });

  const { mode } = req.body;
  try {
    const result = machine.setPowerMode(mode);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get blockchain info
app.get('/api/blockchain/info', (req, res) => {
  res.json({
    chainLength: blockchain.chain.length,
    difficulty: blockchain.difficulty,
    reward: blockchain.reward,
    pendingTransactions: blockchain.pendingTransactions.length,
    activeMiners: miners.size,
  });
});

// Get device profiles
app.get('/api/profiles', (req, res) => {
  const machine = new MiningMachine();
  res.json(machine.getDeviceProfile());
});

// Serve the iPhone mining interface
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'miner.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Mining server running on http://0.0.0.0:${PORT}`);
  console.log(`Open on iPhone: http://<your-local-ip>:${PORT}`);
});
