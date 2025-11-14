/**
 * WebSocket-to-TCP Proxy for noVNC
 * Based on websockify-js architecture and design principles
 * Supports dynamic target routing for multiple VNC servers
 */

'use strict';

const net = require('net');
const WebSocket = require('ws');

/**
 * WebSocket Proxy Class
 * Bridges WebSocket clients to VNC TCP servers
 */
class WebsockifyProxy {
  constructor(options = {}) {
    this.wss = options.wss;
    this.connections = new Map(); // connectionId -> connection info
    this.vmConnections = new Map(); // vmId -> Set of connectionIds
    this.heartbeatInterval = null;
    this.connectionIdCounter = 0;
    this.config = {
      heartbeatTimeout: options.heartbeatTimeout || 30000,
      connectionTimeout: options.connectionTimeout || 10000,
      maxConnections: options.maxConnections || 100,
      maxConnectionsPerVM: options.maxConnectionsPerVM || 20, // SPICE needs up to 17+ channels (display, inputs, cursor, playback, record, usbredir x10, webdav)
      // Network resilience settings
      tcpKeepaliveEnable: options.tcpKeepaliveEnable !== false, // Enable TCP keepalive by default
      tcpKeepaliveInitialDelay: options.tcpKeepaliveInitialDelay || 60000, // 60s before first keepalive probe
      tcpKeepaliveInterval: options.tcpKeepaliveInterval || 10000, // 10s between keepalive probes
      bufferMaxSize: options.bufferMaxSize || 1024 * 1024, // 1MB max buffer per connection
      readyTimeout: options.readyTimeout || 5000, // 5s timeout for connection to become ready
      // Connection retry settings for high-latency scenarios
      maxRetries: options.maxRetries !== undefined ? options.maxRetries : 3, // Maximum number of retry attempts
      retryDelay: options.retryDelay || 1000, // Initial retry delay in ms (exponential backoff)
      retryBackoffMultiplier: options.retryBackoffMultiplier || 2, // Backoff multiplier for each retry
      ...options
    };

    if (this.config.enableHeartbeat !== false) {
      this.startHeartbeat();
    }

    console.log('🚀 WebsockifyProxy initialized');
    console.log(`   Max connections per VM: ${this.config.maxConnectionsPerVM}`);
    console.log(`   TCP Keepalive: ${this.config.tcpKeepaliveEnable ? 'enabled' : 'disabled'}`);
    console.log(`   Buffer max size: ${this.config.bufferMaxSize} bytes`);
    console.log(`   Connection retry: max ${this.config.maxRetries} attempts, initial delay ${this.config.retryDelay}ms`);
  }

  /**
   * Start heartbeat mechanism to detect dead connections
   */
  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          console.log('💔 Terminating dead connection');
          return ws.terminate();
        }

        ws.isAlive = false;
        ws.ping();
      });
    }, this.config.heartbeatTimeout);

    console.log('💓 Heartbeat mechanism started');
  }

  /**
   * Stop heartbeat mechanism
   */
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      console.log('💔 Heartbeat mechanism stopped');
    }
  }

  /**
   * Handle new WebSocket connection
   * @param {WebSocket} ws - WebSocket client
   * @param {Object} connectionInfo - Connection information including vmId, host, port
   */
  async handleConnection(ws, connectionInfo) {
    const { vmId, host, port, password } = connectionInfo;
    const clientAddr = ws._socket?.remoteAddress || 'unknown';

    // Generate unique connection ID
    const connectionId = `${vmId}_${++this.connectionIdCounter}_${Date.now()}`;

    console.log(`🔌 New WebSocket connection for VM ${vmId} from ${clientAddr}`);
    console.log(`   Connection ID: ${connectionId}`);
    console.log(`📡 Target: ${host}:${port}`);

    // Check global max connections limit
    if (this.connections.size >= this.config.maxConnections) {
      console.error('❌ Global max connections limit reached');
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Server is at maximum capacity'
      }));
      ws.close(1008, 'Max connections reached');
      return;
    }

    // Check per-VM max connections limit
    const vmConns = this.vmConnections.get(vmId) || new Set();
    if (vmConns.size >= this.config.maxConnectionsPerVM) {
      console.error(`❌ Max connections limit reached for VM ${vmId} (${vmConns.size}/${this.config.maxConnectionsPerVM})`);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Too many connections for this VM'
      }));
      ws.close(1008, 'Too many connections');
      return;
    }

    // Buffer for messages received before TCP connection is established
    const messageBuffer = [];
    let isProxyReady = false;

    // Register message handler immediately to buffer early messages
    // SPICE clients send handshake data immediately after WebSocket connection
    console.log(`🎯 [Early Handler] Registering temporary message buffer for VM ${vmId}`);
    const tempMessageHandler = (data) => {
      if (!isProxyReady) {
        console.log(`📦 [Buffer] Buffering message (${data.length || data.byteLength || 0} bytes) while waiting for TCP connection`);
        messageBuffer.push(data);
      }
    };
    ws.on('message', tempMessageHandler);

    try {
      // Create TCP connection to VNC/SPICE server
      const target = await this.createTargetConnection(host, port);

      // Mark proxy as ready and remove temporary handler
      isProxyReady = true;
      ws.removeListener('message', tempMessageHandler);
      console.log(`✅ [Buffer] TCP connection ready, buffered ${messageBuffer.length} message(s)`);

      // Setup bidirectional proxy
      this.setupProxy(ws, target, vmId, connectionId, clientAddr);

      // Forward buffered messages to TCP server
      if (messageBuffer.length > 0) {
        console.log(`📤 [Buffer] Forwarding ${messageBuffer.length} buffered message(s) to TCP server`);
        for (const data of messageBuffer) {
          const buffer = Buffer.from(data);
          console.log(`   → Forwarding ${buffer.length} bytes`);
          if (target.writable) {
            target.write(buffer);
          }
        }
      }

      // Store connection info
      this.connections.set(connectionId, {
        vmId,
        ws,
        target,
        startTime: Date.now(),
        lastActivity: Date.now(),
        host,
        port,
        clientAddr
      });

      // Track VM connections
      if (!this.vmConnections.has(vmId)) {
        this.vmConnections.set(vmId, new Set());
      }
      this.vmConnections.get(vmId).add(connectionId);

      const vmConnCount = this.vmConnections.get(vmId).size;
      console.log(`✅ Proxy established for VM ${vmId}`);
      console.log(`   Total connections: ${this.connections.size}`);
      console.log(`   VM ${vmId} connections: ${vmConnCount}/${this.config.maxConnectionsPerVM}`);

    } catch (error) {
      console.error(`❌ Failed to establish proxy for VM ${vmId}:`, error.message);

      // Clean up temporary message handler
      if (!isProxyReady) {
        ws.removeListener('message', tempMessageHandler);
        console.log(`🧹 [Buffer] Cleaned up temporary message handler (${messageBuffer.length} buffered messages discarded)`);
      }

      ws.send(JSON.stringify({
        type: 'error',
        message: 'Failed to connect to server'
      }));
      ws.close(1011, 'Connection failed');
    }
  }

  /**
   * Attempt a single TCP connection (internal method)
   * @param {string} host - VNC/SPICE server host
   * @param {number} port - VNC/SPICE server port
   * @param {number} attemptNumber - Current attempt number (for logging)
   * @returns {Promise<net.Socket>} TCP socket connection
   * @private
   */
  _attemptConnection(host, port, attemptNumber) {
    return new Promise((resolve, reject) => {
      const target = net.createConnection({
        host,
        port,
        timeout: this.config.connectionTimeout
      });

      target.on('connect', () => {
        console.log(`✅ TCP connection established to ${host}:${port}${attemptNumber > 1 ? ` (attempt ${attemptNumber})` : ''}`);

        // Disable initial connection timeout after successful connection
        target.setTimeout(0);

        // Enable TCP keepalive to detect dead connections
        if (this.config.tcpKeepaliveEnable) {
          target.setKeepAlive(true, this.config.tcpKeepaliveInitialDelay);
          console.log(`   TCP Keepalive enabled: initial delay ${this.config.tcpKeepaliveInitialDelay}ms`);
        }

        // Disable Nagle's algorithm for lower latency (important for interactive sessions)
        target.setNoDelay(true);
        console.log(`   TCP NoDelay enabled for low latency`);

        resolve(target);
      });

      target.on('error', (error) => {
        console.error(`❌ TCP connection error to ${host}:${port}:`, error.message);
        reject(error);
      });

      target.on('timeout', () => {
        console.error(`⏱️ TCP connection timeout to ${host}:${port}`);
        target.destroy();
        reject(new Error('Connection timeout'));
      });
    });
  }

  /**
   * Create TCP connection to VNC/SPICE server with automatic retry
   * @param {string} host - VNC/SPICE server host
   * @param {number} port - VNC/SPICE server port
   * @returns {Promise<net.Socket>} TCP socket connection
   */
  async createTargetConnection(host, port) {
    let lastError;
    const maxAttempts = this.config.maxRetries + 1; // Total attempts = retries + initial attempt

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Log attempt info
        if (attempt > 1) {
          const delay = this.config.retryDelay * Math.pow(this.config.retryBackoffMultiplier, attempt - 2);
          console.log(`🔄 Retry attempt ${attempt - 1}/${this.config.maxRetries} for ${host}:${port} after ${delay}ms delay`);
        }

        // Attempt connection
        const target = await this._attemptConnection(host, port, attempt);

        // Success! Return the connection
        if (attempt > 1) {
          console.log(`✅ Connection successful after ${attempt - 1} retry(ies)`);
        }
        return target;

      } catch (error) {
        lastError = error;

        // If this is not the last attempt, wait before retrying
        if (attempt < maxAttempts) {
          const delay = this.config.retryDelay * Math.pow(this.config.retryBackoffMultiplier, attempt - 1);
          console.log(`⏳ Connection failed (${error.message}), waiting ${delay}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    // All attempts failed
    console.error(`❌ All ${maxAttempts} connection attempts failed for ${host}:${port}`);
    console.error(`   Last error: ${lastError.message}`);
    throw lastError;
  }

  /**
   * Setup bidirectional data forwarding between WebSocket and TCP
   * @param {WebSocket} ws - WebSocket client
   * @param {net.Socket} target - TCP target connection
   * @param {string} vmId - Virtual machine ID
   * @param {string} connectionId - Unique connection ID
   * @param {string} clientAddr - Client address
   */
  setupProxy(ws, target, vmId, connectionId, clientAddr) {
    const log = (msg) => console.log(`[${vmId}/${connectionId}] ${clientAddr}: ${msg}`);

    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🔧 [Proxy Setup] Setting up bidirectional proxy for VM ${vmId}`);
    console.log(`   Connection ID: ${connectionId}`);
    console.log(`   Client address: ${clientAddr}`);
    console.log(`   WebSocket readyState: ${ws.readyState} (1=OPEN)`);
    console.log(`   WebSocket protocol: ${ws.protocol || 'none'}`);
    console.log(`   TCP socket connected: ${target.writable}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    // Track connection health
    ws.isAlive = true;

    // WebSocket -> TCP: Forward client data to server
    console.log(`📝 [Proxy Setup] Registering 'message' event handler for VM ${vmId}`);
    ws.on('message', (data) => {
      console.log(`🎯 [Event] 'message' event fired for VM ${vmId}`);
      console.log(`   Data type: ${typeof data}`);
      console.log(`   Is Buffer: ${Buffer.isBuffer(data)}`);
      console.log(`   Is ArrayBuffer: ${data instanceof ArrayBuffer}`);
      console.log(`   Length: ${data.length || data.byteLength || 'unknown'}`);

      try {
        this.updateActivity(connectionId);

        // Handle binary protocol data
        if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
          const buffer = Buffer.from(data);
          console.log(`📤 [WS→TCP] ${vmId}: Sending ${buffer.length} bytes to SPICE server`);
          // Hex dump first 64 bytes for SPICE protocol debugging
          if (buffer.length > 0) {
            const hexDump = buffer.slice(0, Math.min(64, buffer.length))
              .toString('hex').match(/.{1,2}/g).join(' ');
            console.log(`   Data (hex): ${hexDump}`);
          }

          if (target.writable) {
            target.write(buffer);
          } else {
            log(`⚠️ TCP socket not writable, cannot send data`);
          }
        }
        // Handle text messages (control messages)
        else if (typeof data === 'string') {
          try {
            const message = JSON.parse(data);
            this.handleControlMessage(message, ws, target, vmId);
          } catch {
            // If not JSON, treat as binary data
            const buffer = Buffer.from(data);
            console.log(`📤 [WS→TCP] ${vmId}: Sending ${buffer.length} bytes (text->binary) to SPICE server`);
            if (target.writable) {
              target.write(buffer);
            } else {
              log(`⚠️ TCP socket not writable, cannot send data`);
            }
          }
        }
        else {
          const buffer = Buffer.from(data);
          console.log(`📤 [WS→TCP] ${vmId}: Sending ${buffer.length} bytes (unknown type) to SPICE server`);
          if (target.writable) {
            target.write(buffer);
          } else {
            log(`⚠️ TCP socket not writable, cannot send data`);
          }
        }
      } catch (error) {
        log(`Error forwarding WS->TCP: ${error.message}`);
        console.error(`❌ [WS→TCP] ${vmId}: Error details:`, error);
      }
    });

    // TCP -> WebSocket: Forward server data to client
    console.log(`📝 [Proxy Setup] Registering 'data' event handler for TCP connection`);
    target.on('data', (data) => {
      try {
        console.log(`📥 [TCP→WS] ${vmId}: Received ${data.length} bytes from SPICE server`);
        // Hex dump first 64 bytes for SPICE protocol debugging
        if (data.length > 0) {
          const hexDump = data.slice(0, Math.min(64, data.length))
            .toString('hex').match(/.{1,2}/g).join(' ');
          console.log(`   Data (hex): ${hexDump}`);
        }

        if (ws.readyState === WebSocket.OPEN) {
          console.log(`   → Forwarding to WebSocket client (state: OPEN)`);
          ws.send(data, { binary: true });
          this.updateActivity(connectionId);
        } else {
          console.error(`   ❌ Cannot forward: WebSocket state is ${ws.readyState} (not OPEN)`);
        }
      } catch (error) {
        log(`Error forwarding TCP->WS: ${error.message}`);
        console.error(`❌ [TCP→WS] ${vmId}: Error details:`, error);
      }
    });

    // Handle WebSocket pong for heartbeat
    ws.on('pong', () => {
      ws.isAlive = true;
      this.updateActivity(connectionId);
    });

    // Handle WebSocket close
    ws.on('close', (code, reason) => {
      log(`WebSocket closed: ${code} [${reason}]`);
      target.end();
      this.cleanupConnection(connectionId, vmId);
      log(`Connection cleaned up (${this.connections.size} total, ${this.getVMConnectionCount(vmId)} for this VM)`);
    });

    // Handle WebSocket error
    ws.on('error', (error) => {
      log(`WebSocket error: ${error.message}`);
      target.end();
      this.cleanupConnection(connectionId, vmId);
    });

    // Handle TCP close
    target.on('close', () => {
      log('TCP connection closed');
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, 'Server connection closed');
      }
      this.cleanupConnection(connectionId, vmId);
    });

    // Handle TCP error
    target.on('error', (error) => {
      log(`TCP error: ${error.message}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1011, 'Server connection error');
      }
      this.cleanupConnection(connectionId, vmId);
    });
  }

  /**
   * Clean up a connection
   * @param {string} connectionId - Connection ID
   * @param {string} vmId - VM ID
   */
  cleanupConnection(connectionId, vmId) {
    // Remove from connections map
    this.connections.delete(connectionId);

    // Remove from VM connections
    const vmConns = this.vmConnections.get(vmId);
    if (vmConns) {
      vmConns.delete(connectionId);
      if (vmConns.size === 0) {
        this.vmConnections.delete(vmId);
        console.log(`🧹 All connections closed for VM ${vmId}`);
      }
    }
  }

  /**
   * Get connection count for a VM
   * @param {string} vmId - VM ID
   * @returns {number} Connection count
   */
  getVMConnectionCount(vmId) {
    const vmConns = this.vmConnections.get(vmId);
    return vmConns ? vmConns.size : 0;
  }

  /**
   * Handle control messages from WebSocket client
   * @param {Object} message - Control message
   * @param {WebSocket} ws - WebSocket client
   * @param {net.Socket} target - TCP target
   * @param {string} vmId - VM identifier
   */
  handleControlMessage(message, ws, target, vmId) {
    switch (message.type) {
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        break;

      case 'resize':
        console.log(`[${vmId}] Screen resize: ${message.width}x${message.height}`);
        break;

      case 'quality':
        console.log(`[${vmId}] Quality adjustment: ${message.quality}`);
        break;

      case 'clipboard':
        console.log(`[${vmId}] Clipboard sync: ${message.text?.substring(0, 50)}...`);
        break;

      default:
        console.log(`[${vmId}] Unknown control message: ${message.type}`);
    }
  }

  /**
   * Update last activity timestamp for a connection
   * @param {string} connectionId - Connection identifier
   */
  updateActivity(connectionId) {
    const conn = this.connections.get(connectionId);
    if (conn) {
      conn.lastActivity = Date.now();
    }
  }

  /**
   * Get all connections for a VM
   * @param {string} vmId - VM identifier
   * @returns {Array} Array of connection info
   */
  getVMConnections(vmId) {
    const connIds = this.vmConnections.get(vmId);
    if (!connIds) return [];

    return Array.from(connIds)
      .map(id => this.connections.get(id))
      .filter(conn => conn !== undefined);
  }

  /**
   * Get all active connections
   * @returns {Array} Array of connection info
   */
  getActiveConnections() {
    const now = Date.now();
    return Array.from(this.connections.entries()).map(([connectionId, conn]) => ({
      connectionId,
      vmId: conn.vmId,
      host: conn.host,
      port: conn.port,
      clientAddr: conn.clientAddr,
      duration: now - conn.startTime,
      lastActivity: now - conn.lastActivity
    }));
  }

  /**
   * Close all connections for a specific VM
   * @param {string} vmId - VM identifier
   */
  closeVMConnections(vmId) {
    const connIds = this.vmConnections.get(vmId);
    if (!connIds || connIds.size === 0) {
      console.log(`No connections to close for VM ${vmId}`);
      return;
    }

    console.log(`🔌 Closing ${connIds.size} connection(s) for VM ${vmId}`);

    connIds.forEach(connectionId => {
      const conn = this.connections.get(connectionId);
      if (conn) {
        if (conn.ws.readyState === WebSocket.OPEN) {
          conn.ws.close(1000, 'Connection closed by server');
        }
        conn.target.end();
        this.cleanupConnection(connectionId, vmId);
      }
    });
  }

  /**
   * Close all connections and cleanup
   */
  async shutdown() {
    console.log('🛑 Shutting down WebsockifyProxy...');

    this.stopHeartbeat();

    // Close all connections
    for (const [connectionId, conn] of this.connections.entries()) {
      console.log(`Closing connection ${connectionId} for VM ${conn.vmId}`);
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.close(1001, 'Server shutting down');
      }
      conn.target.end();
    }

    this.connections.clear();
    this.vmConnections.clear();
    console.log('✅ WebsockifyProxy shutdown complete');
  }

  /**
   * Get proxy statistics
   * @returns {Object} Statistics object
   */
  getStats() {
    const now = Date.now();
    const connections = this.getActiveConnections();

    // Get per-VM connection stats
    const vmStats = {};
    for (const [vmId, connIds] of this.vmConnections.entries()) {
      vmStats[vmId] = {
        connectionCount: connIds.size,
        maxAllowed: this.config.maxConnectionsPerVM
      };
    }

    return {
      totalConnections: this.connections.size,
      maxConnections: this.config.maxConnections,
      totalVMs: this.vmConnections.size,
      maxConnectionsPerVM: this.config.maxConnectionsPerVM,
      vmStats: vmStats,
      connections: connections,
      uptime: process.uptime(),
      averageDuration: connections.length > 0
        ? connections.reduce((sum, c) => sum + c.duration, 0) / connections.length
        : 0
    };
  }
}

module.exports = WebsockifyProxy;
