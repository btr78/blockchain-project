import crypto from 'crypto';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { Blockchain, Transaction, generateKeyPair } from './blockchain.js';
import { MiningMachine } from './miningMachine.js';
import { createPoolMiner } from './poolMiner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const blockchain = new Blockchain(null);
const miners = new Map();

// Pool miner instances (one per connected client)
const poolMiners = new Map();

// Store logs per pool miner for the UI to fetch
const poolLogs = new Map();

// --- Local Mining API Routes (existing) ---

app.post('/api/miner/register', (req, res) => {
  const { powerMode } = req.body;
  const keyPair = generateKeyPair();
  const minerId = crypto.randomBytes(8).toString('hex');

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

app.post('/api/miner/:id/start', (req, res) => {
  const machine = miners.get(req.params.id);
  if (!machine) return res.status(404).json({ error: 'Miner not found' });

  const result = machine.startContinuousMining();
  res.json(result);
});

app.post('/api/miner/:id/stop', (req, res) => {
  const machine = miners.get(req.params.id);
  if (!machine) return res.status(404).json({ error: 'Miner not found' });

  const result = machine.stopMining();
  res.json(result);
});

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

app.get('/api/miner/:id/stats', (req, res) => {
  const machine = miners.get(req.params.id);
  if (!machine) return res.status(404).json({ error: 'Miner not found' });

  res.json(machine.getStats());
});

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

app.get('/api/blockchain/info', (req, res) => {
  res.json({
    chainLength: blockchain.chain.length,
    difficulty: blockchain.difficulty,
    reward: blockchain.reward,
    pendingTransactions: blockchain.pendingTransactions.length,
    activeMiners: miners.size,
  });
});

app.get('/api/profiles', (req, res) => {
  const machine = new MiningMachine();
  res.json(machine.getDeviceProfile());
});

// --- Pool Mining API Routes (NEW) ---

// Connect to a mining pool
app.post('/api/pool/connect', async (req, res) => {
  const { coin, poolUrl, walletAddress, workerName, password } = req.body;

  if (!coin || !poolUrl || !walletAddress) {
    return res.status(400).json({ error: 'coin, poolUrl, and walletAddress are required' });
  }

  const poolId = crypto.randomBytes(8).toString('hex');

  try {
    const miner = createPoolMiner(coin, {
      poolUrl,
      walletAddress,
      workerName: workerName || 'phone',
      password: password || 'x',
    });

    // Set up log collection
    const logs = [];
    poolLogs.set(poolId, logs);

    miner.on('log', (msg) => {
      const entry = { time: Date.now(), message: msg };
      logs.push(entry);
      if (logs.length > 100) logs.shift(); // Keep last 100 entries
      console.log(`[Pool:${poolId}] ${msg}`);
    });

    miner.on('error', (err) => {
      console.error(`[Pool:${poolId}] Error: ${err.message}`);
    });

    await miner.connect();
    poolMiners.set(poolId, miner);

    res.json({ poolId, status: 'connected', coin: coin.toUpperCase() });
  } catch (err) {
    res.status(500).json({ error: `Failed to connect: ${err.message}` });
  }
});

// Start pool mining
app.post('/api/pool/:id/start', (req, res) => {
  const miner = poolMiners.get(req.params.id);
  if (!miner) return res.status(404).json({ error: 'Pool miner not found' });

  try {
    const result = miner.start();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop pool mining
app.post('/api/pool/:id/stop', (req, res) => {
  const miner = poolMiners.get(req.params.id);
  if (!miner) return res.status(404).json({ error: 'Pool miner not found' });

  const result = miner.stop();
  res.json(result);
});

// Disconnect from pool
app.post('/api/pool/:id/disconnect', (req, res) => {
  const miner = poolMiners.get(req.params.id);
  if (!miner) return res.status(404).json({ error: 'Pool miner not found' });

  miner.disconnect();
  poolMiners.delete(req.params.id);
  poolLogs.delete(req.params.id);

  res.json({ status: 'disconnected' });
});

// Get pool mining stats
app.get('/api/pool/:id/stats', (req, res) => {
  const miner = poolMiners.get(req.params.id);
  if (!miner) return res.status(404).json({ error: 'Pool miner not found' });

  res.json(miner.getStats());
});

// Get pool mining logs
app.get('/api/pool/:id/logs', (req, res) => {
  const logs = poolLogs.get(req.params.id);
  if (!logs) return res.status(404).json({ error: 'Pool miner not found' });

  const since = parseInt(req.query.since) || 0;
  const filtered = logs.filter(l => l.time > since);
  res.json({ logs: filtered });
});

// Get default pool configs
app.get('/api/pool/defaults', (req, res) => {
  res.json({
    btc: {
      name: 'Bitcoin',
      symbol: 'BTC',
      algorithm: 'SHA-256d (Double SHA-256)',
      pools: [
        { name: 'CK Solo Pool', url: 'solo.ckpool.org:3333', note: 'Solo mining - you keep the whole block reward if you find a block' },
        { name: 'Braiins Pool', url: 'stratum+tcp://stratum.braiins.com:3333', note: 'Large pool, reliable' },
      ],
      walletPlaceholder: 'Your BTC wallet address (e.g., bc1q...)',
    },
    xmr: {
      name: 'Monero',
      symbol: 'XMR',
      algorithm: 'RandomX (CPU-optimized)',
      pools: [
        { name: 'SupportXMR', url: 'pool.supportxmr.com:3333', note: 'Popular community pool' },
        { name: '2Miners', url: 'xmr.2miners.com:2222', note: 'Large multi-coin pool' },
      ],
      walletPlaceholder: 'Your XMR wallet address (e.g., 4...)',
      note: 'Monero uses RandomX which requires a native module for valid shares. CPU mining XMR is practical and profitable.',
    },
  });
});

// Serve the mining interface
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'miner.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Mining server running on http://0.0.0.0:${PORT}`);
  console.log(`Open on iPhone: http://<your-local-ip>:${PORT}`);
  console.log('');
  console.log('Supported coins:');
  console.log('  BTC - Bitcoin (SHA-256d) - Pool mining via Stratum V1');
  console.log('  XMR - Monero (RandomX)   - Pool mining via Stratum');
  console.log('  Local - Custom blockchain (for testing)');
});
