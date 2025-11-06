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
    this.connections = new Map();
    this.heartbeatInterval = null;
    this.config = {
      heartbeatTimeout: options.heartbeatTimeout || 30000,
      connectionTimeout: options.connectionTimeout || 10000,
      maxConnections: options.maxConnections || 100,
      ...options
    };

    if (this.config.enableHeartbeat !== false) {
      this.startHeartbeat();
    }

    console.log('🚀 WebsockifyProxy initialized');
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

    console.log(`🔌 New WebSocket connection for VM ${vmId} from ${clientAddr}`);
    console.log(`📡 Target: ${host}:${port}`);

    // Check max connections limit
    if (this.connections.size >= this.config.maxConnections) {
      console.error('❌ Max connections limit reached');
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Server is at maximum capacity'
      }));
      ws.close(1008, 'Max connections reached');
      return;
    }

    try {
      // Create TCP connection to VNC server
      const target = await this.createTargetConnection(host, port);

      // Setup bidirectional proxy
      this.setupProxy(ws, target, vmId, clientAddr);

      // Store connection info
      this.connections.set(vmId, {
        ws,
        target,
        startTime: Date.now(),
        lastActivity: Date.now(),
        host,
        port,
        clientAddr
      });

      console.log(`✅ Proxy established for VM ${vmId} (${this.connections.size} active connections)`);

    } catch (error) {
      console.error(`❌ Failed to establish proxy for VM ${vmId}:`, error.message);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Failed to connect to VNC server'
      }));
      ws.close(1011, 'Connection failed');
    }
  }

  /**
   * Create TCP connection to VNC server
   * @param {string} host - VNC server host
   * @param {number} port - VNC server port
   * @returns {Promise<net.Socket>} TCP socket connection
   */
  createTargetConnection(host, port) {
    return new Promise((resolve, reject) => {
      const target = net.createConnection({
        host,
        port,
        timeout: this.config.connectionTimeout
      });

      target.on('connect', () => {
        console.log(`✅ TCP connection established to ${host}:${port}`);
        // Disable timeout after successful connection to keep VNC session alive
        target.setTimeout(0);
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
   * Setup bidirectional data forwarding between WebSocket and TCP
   * @param {WebSocket} ws - WebSocket client
   * @param {net.Socket} target - TCP target connection
   * @param {string} vmId - Virtual machine ID
   * @param {string} clientAddr - Client address
   */
  setupProxy(ws, target, vmId, clientAddr) {
    const log = (msg) => console.log(`[${vmId}] ${clientAddr}: ${msg}`);

    // Track connection health
    ws.isAlive = true;

    // WebSocket -> TCP: Forward client data to VNC server
    ws.on('message', (data) => {
      try {
        this.updateActivity(vmId);

        // Handle binary VNC protocol data
        if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
          target.write(Buffer.from(data));
        }
        // Handle text messages (control messages)
        else if (typeof data === 'string') {
          try {
            const message = JSON.parse(data);
            this.handleControlMessage(message, ws, target, vmId);
          } catch {
            // If not JSON, treat as binary data
            target.write(Buffer.from(data));
          }
        }
        else {
          target.write(Buffer.from(data));
        }
      } catch (error) {
        log(`Error forwarding WS->TCP: ${error.message}`);
      }
    });

    // TCP -> WebSocket: Forward VNC server data to client
    target.on('data', (data) => {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data, { binary: true });
          this.updateActivity(vmId);
        }
      } catch (error) {
        log(`Error forwarding TCP->WS: ${error.message}`);
      }
    });

    // Handle WebSocket pong for heartbeat
    ws.on('pong', () => {
      ws.isAlive = true;
      this.updateActivity(vmId);
    });

    // Handle WebSocket close
    ws.on('close', (code, reason) => {
      log(`WebSocket closed: ${code} [${reason}]`);
      target.end();
      this.connections.delete(vmId);
      log(`Connection cleaned up (${this.connections.size} active)`);
    });

    // Handle WebSocket error
    ws.on('error', (error) => {
      log(`WebSocket error: ${error.message}`);
      target.end();
      this.connections.delete(vmId);
    });

    // Handle TCP close
    target.on('close', () => {
      log('TCP connection closed');
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, 'VNC connection closed');
      }
      this.connections.delete(vmId);
    });

    // Handle TCP error
    target.on('error', (error) => {
      log(`TCP error: ${error.message}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1011, 'VNC connection error');
      }
      this.connections.delete(vmId);
    });
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
   * @param {string} vmId - VM identifier
   */
  updateActivity(vmId) {
    const conn = this.connections.get(vmId);
    if (conn) {
      conn.lastActivity = Date.now();
    }
  }

  /**
   * Get connection information for a VM
   * @param {string} vmId - VM identifier
   * @returns {Object|null} Connection info or null
   */
  getConnection(vmId) {
    return this.connections.get(vmId) || null;
  }

  /**
   * Get all active connections
   * @returns {Array} Array of connection info
   */
  getActiveConnections() {
    const now = Date.now();
    return Array.from(this.connections.entries()).map(([vmId, conn]) => ({
      vmId,
      host: conn.host,
      port: conn.port,
      clientAddr: conn.clientAddr,
      duration: now - conn.startTime,
      lastActivity: now - conn.lastActivity
    }));
  }

  /**
   * Close connection for a specific VM
   * @param {string} vmId - VM identifier
   */
  closeConnection(vmId) {
    const conn = this.connections.get(vmId);
    if (conn) {
      console.log(`🔌 Closing connection for VM ${vmId}`);
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.close(1000, 'Connection closed by server');
      }
      conn.target.end();
      this.connections.delete(vmId);
    }
  }

  /**
   * Close all connections and cleanup
   */
  async shutdown() {
    console.log('🛑 Shutting down WebsockifyProxy...');

    this.stopHeartbeat();

    // Close all connections
    for (const [vmId, conn] of this.connections.entries()) {
      console.log(`Closing connection for VM ${vmId}`);
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.close(1001, 'Server shutting down');
      }
      conn.target.end();
    }

    this.connections.clear();
    console.log('✅ WebsockifyProxy shutdown complete');
  }

  /**
   * Get proxy statistics
   * @returns {Object} Statistics object
   */
  getStats() {
    const now = Date.now();
    const connections = this.getActiveConnections();

    return {
      totalConnections: this.connections.size,
      maxConnections: this.config.maxConnections,
      connections: connections,
      uptime: process.uptime(),
      averageDuration: connections.length > 0
        ? connections.reduce((sum, c) => sum + c.duration, 0) / connections.length
        : 0
    };
  }
}

module.exports = WebsockifyProxy;
