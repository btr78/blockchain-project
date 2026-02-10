import crypto from 'crypto';
import { Blockchain, Block, Transaction, generateKeyPair } from './blockchain.js';

class MiningMachine {
  constructor(options = {}) {
    this.minerAddress = options.minerAddress || null;
    this.keyPair = options.keyPair || null;
    this.difficulty = options.difficulty || 2;
    this.batchSize = options.batchSize || 500;
    this.miningInterval = options.miningInterval || 100;
    this.maxHashRate = options.maxHashRate || 10000;
    this.powerMode = options.powerMode || 'balanced';
    this.isRunning = false;
    this.stats = {
      blocksMinedTotal: 0,
      hashesComputed: 0,
      totalRewards: 0,
      startTime: null,
      lastBlockTime: null,
    };
    this.blockchain = null;
    this._miningTimer = null;

    this._applyPowerMode(this.powerMode);
  }

  _applyPowerMode(mode) {
    switch (mode) {
      case 'low':
        this.batchSize = 200;
        this.miningInterval = 250;
        this.maxHashRate = 3000;
        break;
      case 'balanced':
        this.batchSize = 500;
        this.miningInterval = 100;
        this.maxHashRate = 10000;
        break;
      case 'performance':
        this.batchSize = 1000;
        this.miningInterval = 50;
        this.maxHashRate = 50000;
        break;
      default:
        break;
    }
    this.powerMode = mode;
  }

  initialize(blockchain) {
    if (!this.keyPair) {
      this.keyPair = generateKeyPair();
    }
    this.minerAddress = this.keyPair.publicKey;
    this.blockchain = blockchain || new Blockchain(null);
    this.blockchain.difficulty = this.difficulty;
    return {
      minerAddress: this.minerAddress,
      difficulty: this.difficulty,
      powerMode: this.powerMode,
    };
  }

  mineBlock() {
    if (!this.blockchain) {
      throw new Error('Mining machine not initialized. Call initialize() first.');
    }

    const block = new Block(
      this.blockchain.chain.length,
      Date.now(),
      this.blockchain.pendingTransactions,
      this.blockchain.chain[this.blockchain.chain.length - 1].hash
    );

    const result = this._mineWithBatching(block, this.blockchain.difficulty);

    this.blockchain.chain.push(block);
    this.blockchain.pendingTransactions = [
      new Transaction(null, this.minerAddress, this.blockchain.reward),
    ];

    this.stats.blocksMinedTotal++;
    this.stats.totalRewards += this.blockchain.reward;
    this.stats.lastBlockTime = Date.now();

    return {
      blockIndex: block.index,
      hash: block.hash,
      nonce: block.nonce,
      hashesComputed: result.hashesComputed,
      timeMs: result.timeMs,
      reward: this.blockchain.reward,
    };
  }

  _mineWithBatching(block, difficulty) {
    const target = Array(difficulty + 1).join('0');
    const startTime = Date.now();
    let hashesComputed = 0;

    while (!block.hash.startsWith(target)) {
      const batchEnd = Math.min(block.nonce + this.batchSize, block.nonce + this.maxHashRate);
      for (let i = block.nonce; i < batchEnd; i++) {
        block.nonce = i;
        block.hash = block.calculateHash();
        hashesComputed++;
        if (block.hash.startsWith(target)) break;
      }
      if (!block.hash.startsWith(target)) {
        block.nonce = batchEnd;
      }
    }

    this.stats.hashesComputed += hashesComputed;
    const timeMs = Date.now() - startTime;

    return { hashesComputed, timeMs };
  }

  startContinuousMining() {
    if (this.isRunning) return { status: 'already_running' };
    if (!this.blockchain) {
      throw new Error('Mining machine not initialized. Call initialize() first.');
    }

    this.isRunning = true;
    this.stats.startTime = Date.now();

    const mineLoop = () => {
      if (!this.isRunning) return;

      try {
        const result = this.mineBlock();
        console.log(
          `[MiningMachine] Block #${result.blockIndex} mined | ` +
          `Hash: ${result.hash.substring(0, 16)}... | ` +
          `Nonce: ${result.nonce} | ` +
          `${result.hashesComputed} hashes in ${result.timeMs}ms`
        );
      } catch (err) {
        console.error('[MiningMachine] Mining error:', err.message);
      }

      if (this.isRunning) {
        this._miningTimer = setTimeout(mineLoop, this.miningInterval);
      }
    };

    this._miningTimer = setTimeout(mineLoop, 0);
    return { status: 'started', powerMode: this.powerMode };
  }

  stopMining() {
    this.isRunning = false;
    if (this._miningTimer) {
      clearTimeout(this._miningTimer);
      this._miningTimer = null;
    }
    return { status: 'stopped', stats: this.getStats() };
  }

  setPowerMode(mode) {
    if (!['low', 'balanced', 'performance'].includes(mode)) {
      throw new Error('Invalid power mode. Use: low, balanced, performance');
    }
    this._applyPowerMode(mode);
    return { powerMode: mode, batchSize: this.batchSize, miningInterval: this.miningInterval };
  }

  getStats() {
    const uptime = this.stats.startTime ? Date.now() - this.stats.startTime : 0;
    const hashRate = uptime > 0
      ? Math.round(this.stats.hashesComputed / (uptime / 1000))
      : 0;

    return {
      isRunning: this.isRunning,
      powerMode: this.powerMode,
      blocksMinedTotal: this.stats.blocksMinedTotal,
      hashesComputed: this.stats.hashesComputed,
      totalRewards: this.stats.totalRewards,
      hashRate,
      uptimeMs: uptime,
      balance: this.blockchain
        ? this.blockchain.getBalanceOfAddress(this.minerAddress)
        : 0,
      chainLength: this.blockchain ? this.blockchain.chain.length : 0,
      difficulty: this.difficulty,
    };
  }

  getDeviceProfile() {
    return {
      recommended: {
        low: {
          description: 'Battery saver - minimal CPU usage',
          batchSize: 200,
          interval: 250,
          maxHashRate: 3000,
        },
        balanced: {
          description: 'Default - moderate CPU and battery usage',
          batchSize: 500,
          interval: 100,
          maxHashRate: 10000,
        },
        performance: {
          description: 'Max output - higher CPU and battery drain',
          batchSize: 1000,
          interval: 50,
          maxHashRate: 50000,
        },
      },
    };
  }
}

export { MiningMachine };
