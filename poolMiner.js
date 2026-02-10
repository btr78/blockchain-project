import crypto from 'crypto';
import { EventEmitter } from 'events';
import { StratumClient, parsePoolUrl } from './stratumClient.js';

// ============================================================
// Utility functions for Bitcoin mining
// ============================================================

function doubleSHA256(buffer) {
  return crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(buffer).digest()
  ).digest();
}

// Reverse byte order of a hex string (used for hash display)
function reverseHex(hex) {
  return Buffer.from(hex, 'hex').reverse().toString('hex');
}

// Stratum sends prevhash with each 4-byte word byte-swapped
// Un-swap each word for the block header
function swapEndianWords(hex) {
  let result = '';
  for (let i = 0; i < hex.length; i += 8) {
    result += hex[i + 6] + hex[i + 7]
            + hex[i + 4] + hex[i + 5]
            + hex[i + 2] + hex[i + 3]
            + hex[i + 0] + hex[i + 1];
  }
  return result;
}

// Build coinbase transaction from parts
function buildCoinbase(coinb1, extranonce1, extranonce2, coinb2) {
  return Buffer.concat([
    Buffer.from(coinb1, 'hex'),
    Buffer.from(extranonce1, 'hex'),
    Buffer.from(extranonce2, 'hex'),
    Buffer.from(coinb2, 'hex'),
  ]);
}

// Calculate merkle root from coinbase hash and branches
function calculateMerkleRoot(coinbaseHash, merkleBranches) {
  let hash = coinbaseHash;
  for (const branch of merkleBranches) {
    hash = doubleSHA256(Buffer.concat([hash, Buffer.from(branch, 'hex')]));
  }
  return hash;
}

// Build 80-byte block header
function buildBlockHeader(version, prevhash, merkleRoot, ntime, nbits, nonce) {
  const header = Buffer.alloc(80);

  // Version - 4 bytes LE
  header.writeUInt32LE(parseInt(version, 16), 0);

  // Previous block hash - 32 bytes (un-swap Stratum format)
  Buffer.from(swapEndianWords(prevhash), 'hex').copy(header, 4);

  // Merkle root - 32 bytes
  merkleRoot.copy(header, 36);

  // Timestamp - 4 bytes LE
  header.writeUInt32LE(parseInt(ntime, 16), 68);

  // Bits - 4 bytes LE
  header.writeUInt32LE(parseInt(nbits, 16), 72);

  // Nonce - 4 bytes LE
  header.writeUInt32LE(nonce, 76);

  return header;
}

// Convert pool difficulty to a 256-bit target
function difficultyToTarget(difficulty) {
  // Bitcoin pool difficulty 1 target
  const maxTarget = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
  return maxTarget / BigInt(Math.max(1, Math.floor(difficulty)));
}

// Check if a hash meets the target difficulty
function hashMeetsTarget(hashBuffer, difficulty) {
  // Hash from double SHA-256 is in internal byte order (little-endian)
  // Reverse it for big-endian comparison
  const hashReversed = Buffer.from(hashBuffer).reverse();
  const hashBigInt = BigInt('0x' + hashReversed.toString('hex'));
  const target = difficultyToTarget(difficulty);
  return hashBigInt <= target;
}

// Generate extranonce2 hex string of the correct size
function generateExtranonce2(value, size) {
  const buf = Buffer.alloc(size);
  // Write value as little-endian
  for (let i = 0; i < size && i < 6; i++) {
    buf[i] = (value >> (8 * i)) & 0xff;
  }
  return buf.toString('hex');
}

// ============================================================
// Bitcoin Pool Miner
// ============================================================

class BtcPoolMiner extends EventEmitter {
  constructor(options = {}) {
    super();
    this.poolUrl = options.poolUrl || 'solo.ckpool.org:3333';
    this.walletAddress = options.walletAddress || '';
    this.workerName = options.workerName || 'worker1';
    this.password = options.password || 'x';

    this.stratum = null;
    this.isRunning = false;
    this.currentJob = null;

    // Stratum state
    this.extranonce1 = null;
    this.extranonce2Size = 4;
    this.extranonce2Counter = 0;
    this.difficulty = 1;

    // Stats
    this.stats = {
      hashesComputed: 0,
      sharesAccepted: 0,
      sharesRejected: 0,
      sharesSubmitted: 0,
      startTime: null,
      lastShareTime: null,
      lastHashRate: 0,
    };

    // Mining loop
    this._miningTimer = null;
    this._miningActive = false;
  }

  async connect() {
    const { host, port, useTLS } = parsePoolUrl(this.poolUrl);

    this.stratum = new StratumClient(host, port, useTLS);

    // Listen for pool notifications
    this.stratum.on('mining.set_difficulty', (params) => {
      this.difficulty = params[0];
      this.emit('difficulty', this.difficulty);
      this.emit('log', `Difficulty set to ${this.difficulty}`);
    });

    this.stratum.on('mining.notify', (params) => {
      this._handleNewJob(params);
    });

    this.stratum.on('error', (err) => {
      this.emit('error', err);
      this.emit('log', `Connection error: ${err.message}`);
    });

    this.stratum.on('disconnected', () => {
      this.emit('disconnected');
      this.emit('log', 'Disconnected from pool');
      this._miningActive = false;
    });

    // Connect to pool
    await this.stratum.connect();
    this.emit('log', `Connected to ${host}:${port}`);

    // Subscribe
    const subscribeResult = await this.stratum.call('mining.subscribe', ['blockchain-miner/1.0']);
    this.extranonce1 = subscribeResult[1];
    this.extranonce2Size = subscribeResult[2];
    this.emit('log', `Subscribed. Extranonce1: ${this.extranonce1}`);

    // Authorize
    const workerFull = this.walletAddress + (this.workerName ? '.' + this.workerName : '');
    const authorized = await this.stratum.call('mining.authorize', [workerFull, this.password]);
    if (!authorized) {
      throw new Error('Authorization failed. Check your wallet address.');
    }
    this.emit('log', `Authorized as ${workerFull}`);

    return { status: 'connected', coin: 'BTC' };
  }

  _handleNewJob(params) {
    const [jobId, prevhash, coinb1, coinb2, merkleBranches, version, nbits, ntime, cleanJobs] = params;

    this.currentJob = { jobId, prevhash, coinb1, coinb2, merkleBranches, version, nbits, ntime };

    if (cleanJobs) {
      this.extranonce2Counter = 0;
    }

    this.emit('job', { jobId, cleanJobs });
    this.emit('log', `New job: ${jobId} (clean: ${cleanJobs})`);

    // If actively mining, restart with new job
    if (this._miningActive) {
      this._mine();
    }
  }

  start() {
    if (this.isRunning) return { status: 'already_running' };
    if (!this.stratum || !this.stratum.connected) {
      throw new Error('Not connected to pool. Call connect() first.');
    }

    this.isRunning = true;
    this._miningActive = true;
    this.stats.startTime = Date.now();
    this.emit('log', 'Mining started (BTC)');

    if (this.currentJob) {
      this._mine();
    }

    return { status: 'started', coin: 'BTC' };
  }

  _mine() {
    if (this._miningTimer) {
      clearImmediate(this._miningTimer);
    }

    if (!this._miningActive || !this.currentJob) return;

    const job = this.currentJob;
    const extranonce2 = generateExtranonce2(this.extranonce2Counter++, this.extranonce2Size);

    // Build coinbase and merkle root
    const coinbase = buildCoinbase(job.coinb1, this.extranonce1, extranonce2, job.coinb2);
    const coinbaseHash = doubleSHA256(coinbase);
    const merkleRoot = calculateMerkleRoot(coinbaseHash, job.merkleBranches);

    const batchSize = 50000; // Hashes per batch
    let nonce = 0;
    const startTime = Date.now();

    const mineNextBatch = () => {
      if (!this._miningActive || this.currentJob !== job) return;

      const batchEnd = Math.min(nonce + batchSize, 0xFFFFFFFF);

      for (let n = nonce; n < batchEnd; n++) {
        const header = buildBlockHeader(job.version, job.prevhash, merkleRoot, job.ntime, job.nbits, n);
        const hash = doubleSHA256(header);
        this.stats.hashesComputed++;

        if (hashMeetsTarget(hash, this.difficulty)) {
          // Found a valid share!
          const nonceHex = Buffer.alloc(4);
          nonceHex.writeUInt32LE(n);

          this._submitShare(job.jobId, extranonce2, job.ntime, nonceHex.toString('hex'));

          const hashDisplay = reverseHex(hash.toString('hex'));
          this.emit('log', `Share found! Hash: ${hashDisplay.substring(0, 16)}... Nonce: ${n}`);
          this.emit('share', { hash: hashDisplay, nonce: n });

          // Continue mining with next extranonce2
          const nextExtranonce2 = generateExtranonce2(this.extranonce2Counter++, this.extranonce2Size);
          nonce = 0;
          return;
        }
      }

      nonce = batchEnd;

      // Update hashrate
      const elapsed = (Date.now() - startTime) / 1000;
      if (elapsed > 0) {
        this.stats.lastHashRate = Math.round(this.stats.hashesComputed / elapsed);
      }

      if (nonce >= 0xFFFFFFFF) {
        // Exhausted nonce space, get new extranonce2
        const nextExtranonce2 = generateExtranonce2(this.extranonce2Counter++, this.extranonce2Size);
        this._mine();
        return;
      }

      // Yield to event loop, then continue
      this._miningTimer = setImmediate(mineNextBatch);
    };

    this._miningTimer = setImmediate(mineNextBatch);
  }

  async _submitShare(jobId, extranonce2, ntime, nonceHex) {
    const workerFull = this.walletAddress + (this.workerName ? '.' + this.workerName : '');
    this.stats.sharesSubmitted++;

    try {
      const result = await this.stratum.call('mining.submit', [
        workerFull, jobId, extranonce2, ntime, nonceHex,
      ]);
      if (result) {
        this.stats.sharesAccepted++;
        this.stats.lastShareTime = Date.now();
        this.emit('log', `Share ACCEPTED (${this.stats.sharesAccepted} total)`);
      } else {
        this.stats.sharesRejected++;
        this.emit('log', `Share REJECTED`);
      }
    } catch (err) {
      this.stats.sharesRejected++;
      this.emit('log', `Share submit error: ${err.message}`);
    }
  }

  stop() {
    this.isRunning = false;
    this._miningActive = false;
    if (this._miningTimer) {
      clearImmediate(this._miningTimer);
      this._miningTimer = null;
    }
    this.emit('log', 'Mining stopped');
    return { status: 'stopped', stats: this.getStats() };
  }

  disconnect() {
    this.stop();
    if (this.stratum) {
      this.stratum.disconnect();
      this.stratum = null;
    }
  }

  getStats() {
    const uptime = this.stats.startTime ? Date.now() - this.stats.startTime : 0;
    return {
      coin: 'BTC',
      isRunning: this.isRunning,
      hashesComputed: this.stats.hashesComputed,
      sharesAccepted: this.stats.sharesAccepted,
      sharesRejected: this.stats.sharesRejected,
      sharesSubmitted: this.stats.sharesSubmitted,
      hashRate: this.stats.lastHashRate,
      difficulty: this.difficulty,
      uptimeMs: uptime,
      lastShareTime: this.stats.lastShareTime,
      currentJob: this.currentJob ? this.currentJob.jobId : null,
    };
  }
}

// ============================================================
// Monero Pool Miner
// ============================================================

class XmrPoolMiner extends EventEmitter {
  constructor(options = {}) {
    super();
    this.poolUrl = options.poolUrl || 'pool.supportxmr.com:3333';
    this.walletAddress = options.walletAddress || '';
    this.password = options.password || 'x';

    this.stratum = null;
    this.isRunning = false;
    this.currentJob = null;
    this.sessionId = null;

    // Stats
    this.stats = {
      hashesComputed: 0,
      sharesAccepted: 0,
      sharesRejected: 0,
      sharesSubmitted: 0,
      startTime: null,
      lastShareTime: null,
      lastHashRate: 0,
    };

    this._miningTimer = null;
    this._miningActive = false;
  }

  async connect() {
    const { host, port, useTLS } = parsePoolUrl(this.poolUrl);

    this.stratum = new StratumClient(host, port, useTLS);

    this.stratum.on('job', (params) => {
      this._handleNewJob(params);
    });

    this.stratum.on('error', (err) => {
      this.emit('error', err);
      this.emit('log', `Connection error: ${err.message}`);
    });

    this.stratum.on('disconnected', () => {
      this.emit('disconnected');
      this.emit('log', 'Disconnected from pool');
      this._miningActive = false;
    });

    await this.stratum.connect();
    this.emit('log', `Connected to ${host}:${port}`);

    // Login (Monero Stratum uses JSON-RPC 2.0 with login method)
    const loginResult = await this.stratum.callJsonRpc('login', {
      login: this.walletAddress,
      pass: this.password,
      agent: 'blockchain-miner/1.0',
    });

    this.sessionId = loginResult.id;
    this.emit('log', `Logged in. Session: ${this.sessionId}`);

    // Process initial job from login response
    if (loginResult.job) {
      this._handleNewJob(loginResult.job);
    }

    return { status: 'connected', coin: 'XMR' };
  }

  _handleNewJob(params) {
    this.currentJob = {
      blob: params.blob,
      jobId: params.job_id,
      target: params.target,
      height: params.height,
      seedHash: params.seed_hash,
    };

    this.emit('job', { jobId: params.job_id, height: params.height });
    this.emit('log', `New job: ${params.job_id} height: ${params.height}`);

    if (this._miningActive) {
      this._mine();
    }
  }

  start() {
    if (this.isRunning) return { status: 'already_running' };
    if (!this.stratum || !this.stratum.connected) {
      throw new Error('Not connected to pool. Call connect() first.');
    }

    this.isRunning = true;
    this._miningActive = true;
    this.stats.startTime = Date.now();
    this.emit('log', 'Mining started (XMR) - Note: Using simplified hashing. Install node-randomx for valid shares.');

    if (this.currentJob) {
      this._mine();
    }

    return { status: 'started', coin: 'XMR' };
  }

  _mine() {
    if (this._miningTimer) {
      clearImmediate(this._miningTimer);
    }

    if (!this._miningActive || !this.currentJob) return;

    const job = this.currentJob;
    let nonce = Math.floor(Math.random() * 0xFFFFFF); // Random starting nonce
    const batchSize = 10000;
    const startTime = Date.now();

    // Parse the compact target from pool
    const targetValue = this._parseTarget(job.target);

    const mineNextBatch = () => {
      if (!this._miningActive || this.currentJob !== job) return;

      const batchEnd = nonce + batchSize;

      for (let n = nonce; n < batchEnd; n++) {
        // Replace nonce bytes in the blob (bytes 78-85, or offset 39 in binary = 78 in hex)
        const nonceHex = n.toString(16).padStart(8, '0');
        const blobWithNonce = job.blob.substring(0, 78) + nonceHex + job.blob.substring(86);

        // Hash the blob
        // NOTE: Real Monero uses RandomX. This uses SHA-256 as a placeholder.
        // Valid shares require RandomX hashing via a native module.
        const blobBuffer = Buffer.from(blobWithNonce, 'hex');
        const hash = crypto.createHash('sha256').update(blobBuffer).digest();
        this.stats.hashesComputed++;

        // Check against target
        if (this._checkTarget(hash, targetValue)) {
          this._submitShare(job.jobId, nonceHex, hash.toString('hex'));
          this.emit('log', `Potential share found! Nonce: ${nonceHex}`);
          this.emit('share', { hash: hash.toString('hex'), nonce: n });
        }
      }

      nonce = batchEnd;

      const elapsed = (Date.now() - startTime) / 1000;
      if (elapsed > 0) {
        this.stats.lastHashRate = Math.round(this.stats.hashesComputed / elapsed);
      }

      this._miningTimer = setImmediate(mineNextBatch);
    };

    this._miningTimer = setImmediate(mineNextBatch);
  }

  _parseTarget(targetHex) {
    // Target from pool is a compact little-endian hex (typically 4 or 8 bytes)
    // Pad to 32 bytes (64 hex chars) on the right with 'ff'
    const padded = targetHex.padEnd(64, '0');
    return BigInt('0x' + padded);
  }

  _checkTarget(hashBuffer, targetValue) {
    // Interpret the last 8 bytes of the hash as a little-endian 64-bit number
    // Compare against the target
    const hashHex = hashBuffer.toString('hex');
    const hashValue = BigInt('0x' + hashHex);
    return hashValue < targetValue;
  }

  async _submitShare(jobId, nonceHex, resultHex) {
    this.stats.sharesSubmitted++;

    try {
      const result = await this.stratum.callJsonRpc('submit', {
        id: this.sessionId,
        job_id: jobId,
        nonce: nonceHex,
        result: resultHex,
      });

      if (result && result.status === 'OK') {
        this.stats.sharesAccepted++;
        this.stats.lastShareTime = Date.now();
        this.emit('log', `Share ACCEPTED (${this.stats.sharesAccepted} total)`);
      } else {
        this.stats.sharesRejected++;
        this.emit('log', `Share REJECTED`);
      }
    } catch (err) {
      this.stats.sharesRejected++;
      this.emit('log', `Share error: ${err.message}`);
    }
  }

  stop() {
    this.isRunning = false;
    this._miningActive = false;
    if (this._miningTimer) {
      clearImmediate(this._miningTimer);
      this._miningTimer = null;
    }
    this.emit('log', 'Mining stopped');
    return { status: 'stopped', stats: this.getStats() };
  }

  disconnect() {
    this.stop();
    if (this.stratum) {
      this.stratum.disconnect();
      this.stratum = null;
    }
  }

  getStats() {
    const uptime = this.stats.startTime ? Date.now() - this.stats.startTime : 0;
    return {
      coin: 'XMR',
      isRunning: this.isRunning,
      hashesComputed: this.stats.hashesComputed,
      sharesAccepted: this.stats.sharesAccepted,
      sharesRejected: this.stats.sharesRejected,
      sharesSubmitted: this.stats.sharesSubmitted,
      hashRate: this.stats.lastHashRate,
      uptimeMs: uptime,
      lastShareTime: this.stats.lastShareTime,
      currentJob: this.currentJob ? this.currentJob.jobId : null,
      height: this.currentJob ? this.currentJob.height : null,
    };
  }
}

// ============================================================
// Factory
// ============================================================

function createPoolMiner(coin, options) {
  switch (coin.toLowerCase()) {
    case 'btc':
    case 'bitcoin':
      return new BtcPoolMiner(options);
    case 'xmr':
    case 'monero':
      return new XmrPoolMiner(options);
    default:
      throw new Error(`Unsupported coin: ${coin}. Use 'btc' or 'xmr'.`);
  }
}

export { BtcPoolMiner, XmrPoolMiner, createPoolMiner };
