import crypto from 'crypto';

// Generate a key pair for transaction signing
function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  return {
    publicKey: publicKey.export({ type: 'pkcs1', format: 'pem' }),
    privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }),
  };
}

// Sign a transaction
function sign(data, privateKey) {
  const sign = crypto.createSign('SHA256');
  sign.update(data);
  return sign.sign(privateKey, 'hex');
}

// Verify the signature of a transaction
function verify(data, signature, publicKey) {
  const verify = crypto.createVerify('SHA256');
  verify.update(data);
  return verify.verify(publicKey, signature, 'hex');
}

class Transaction {
  constructor(sender, recipient, amount) {
    this.sender = sender;
    this.recipient = recipient;
    this.amount = amount;
    this.timestamp = Date.now();
    this.signature = null;
    this.transactionId = null;
  }

  async generateId() {
    const data = `${this.sender}${this.recipient}${this.amount}${this.timestamp}`;
    this.transactionId = crypto.createHash('sha256').update(data).digest('hex');
  }

  signTransaction(privateKey) {
    if (this.sender === null) {
      throw new Error('Transaction must have a sender address.');
    }

    const data = `${this.transactionId}${this.sender}${this.recipient}${this.amount}`;
    this.signature = sign(data, privateKey);
  }

  validate(blockchain) {
    const data = `${this.transactionId}${this.sender}${this.recipient}${this.amount}`;
    return verify(data, this.signature, this.sender) && blockchain.isValidSender(this.sender, this.amount);
  }
}

class Blockchain {
  constructor(aiLayer) {
    this.chain = [];
    this.pendingTransactions = [];
    this.difficulty = 3;
    this.reward = 100;
    this.aiLayer = aiLayer;
    this.createGenesisBlock();
  }

  createGenesisBlock() {
    const genesisBlock = new Block(0, Date.now(), [], '0');
    this.chain.push(genesisBlock);
  }

  addTransaction(transaction) {
    if (!transaction.sender || !transaction.recipient || !transaction.amount) {
      throw new Error('Transaction must contain sender, recipient, and amount.');
    }

    if (!transaction.transactionId) {
      throw new Error('Transaction ID is required.');
    }

    this.pendingTransactions.push(transaction);
  }

  minePendingTransactions(minerAddress) {
    const block = new Block(
      this.chain.length,
      Date.now(),
      this.pendingTransactions,
      this.chain[this.chain.length - 1].hash
    );
    block.mineBlock(this.difficulty);
    this.chain.push(block);

    this.pendingTransactions = [
      new Transaction(null, minerAddress, this.reward), // Reward for mining
    ];
  }

  getBalanceOfAddress(address) {
    let balance = 0;
    for (const block of this.chain) {
      for (const tx of block.transactions) {
        if (tx.recipient === address) {
          balance += tx.amount;
        }
        if (tx.sender === address) {
          balance -= tx.amount;
        }
      }
    }
    return balance;
  }

  isValidSender(sender, amount) {
    return this.getBalanceOfAddress(sender) >= amount;
  }

  isValidChain() {
    let isValid = true;

    for (let i = 1; i < this.chain.length; i++) {
      const currentBlock = this.chain[i];
      const previousBlock = this.chain[i - 1];

      if (currentBlock.previousHash !== previousBlock.hash) {
        isValid = false;
      }

      if (!currentBlock.hasValidTransactions()) {
        isValid = false;
      }
    }

    return isValid;
  }
}

class Block {
  constructor(index, timestamp, transactions, previousHash = '') {
    this.index = index;
    this.timestamp = timestamp;
    this.transactions = transactions;
    this.previousHash = previousHash;
    this.hash = this.calculateHash();
    this.nonce = 0;
  }

  calculateHash() {
    return crypto
      .createHash('sha256')
      .update(
        `${this.index}${this.timestamp}${JSON.stringify(this.transactions)}${this.previousHash}${this.nonce}`
      )
      .digest('hex');
  }

  mineBlock(difficulty) {
    while (!this.hash.startsWith(Array(difficulty + 1).join('0'))) {
      this.nonce++;
      this.hash = this.calculateHash();
    }
    console.log('Block mined: ' + this.hash);
  }

  hasValidTransactions() {
    return this.transactions.every(tx => tx.validate());
  }
}

export { Blockchain, Transaction, generateKeyPair, sign, verify, Block };
