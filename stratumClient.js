import net from 'net';
import tls from 'tls';
import { EventEmitter } from 'events';

class StratumClient extends EventEmitter {
  constructor(host, port, useTLS = false) {
    super();
    this.host = host;
    this.port = port;
    this.useTLS = useTLS;
    this.socket = null;
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.buffer = '';
    this.connected = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const onConnect = () => {
        this.connected = true;
        this.emit('connected');
        resolve();
      };

      if (this.useTLS) {
        this.socket = tls.connect(this.port, this.host, { rejectUnauthorized: false }, onConnect);
      } else {
        this.socket = net.createConnection(this.port, this.host, onConnect);
      }

      this.socket.setEncoding('utf8');
      this.socket.setKeepAlive(true, 30000);

      this.socket.on('data', (data) => this._handleData(data));

      this.socket.on('error', (err) => {
        this.connected = false;
        this.emit('error', err);
        reject(err);
      });

      this.socket.on('close', () => {
        this.connected = false;
        this.emit('disconnected');
      });

      // Timeout after 15 seconds
      this.socket.setTimeout(15000, () => {
        this.socket.destroy();
        reject(new Error('Connection timed out'));
      });
    });
  }

  _handleData(data) {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop(); // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        this._handleMessage(message);
      } catch (e) {
        // Ignore malformed JSON
      }
    }
  }

  _handleMessage(message) {
    // Response to a request we made
    if (message.id != null && this.pendingRequests.has(message.id)) {
      const { resolve, reject } = this.pendingRequests.get(message.id);
      this.pendingRequests.delete(message.id);
      if (message.error) {
        reject(new Error(message.error[1] || JSON.stringify(message.error)));
      } else {
        resolve(message.result);
      }
      return;
    }

    // Server notification (no id or id is null)
    if (message.method) {
      this.emit(message.method, message.params || message.result);
      this.emit('notification', { method: message.method, params: message.params || message.result });
    }
  }

  call(method, params = []) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.socket) {
        return reject(new Error('Not connected'));
      }

      const id = ++this.requestId;
      this.pendingRequests.set(id, { resolve, reject });

      const message = JSON.stringify({ id, method, params }) + '\n';
      this.socket.write(message, (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          reject(err);
        }
      });

      // Timeout for individual requests
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }
      }, 30000);
    });
  }

  // For Monero-style JSON-RPC 2.0
  callJsonRpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.socket) {
        return reject(new Error('Not connected'));
      }

      const id = ++this.requestId;
      this.pendingRequests.set(id, { resolve, reject });

      const message = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      this.socket.write(message, (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          reject(err);
        }
      });

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }
      }, 30000);
    });
  }

  disconnect() {
    this.connected = false;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.pendingRequests.clear();
  }
}

// Parse a pool URL like "stratum+tcp://host:port" or "host:port"
function parsePoolUrl(url) {
  let useTLS = false;
  let cleaned = url.trim();

  if (cleaned.startsWith('stratum+ssl://') || cleaned.startsWith('stratum+tls://')) {
    useTLS = true;
    cleaned = cleaned.replace(/^stratum\+(ssl|tls):\/\//, '');
  } else if (cleaned.startsWith('stratum+tcp://')) {
    cleaned = cleaned.replace(/^stratum\+tcp:\/\//, '');
  }

  const [host, portStr] = cleaned.split(':');
  const port = parseInt(portStr, 10);

  if (!host || !port) {
    throw new Error('Invalid pool URL. Use format: host:port or stratum+tcp://host:port');
  }

  return { host, port, useTLS };
}

export { StratumClient, parsePoolUrl };
