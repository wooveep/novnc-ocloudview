/**
 * WebSocket Connection Handler
 * Handles authentication and VNC connection info retrieval for WebSocket connections
 */

'use strict';

const jwt = require('jsonwebtoken');

/**
 * Extract JWT token from WebSocket request
 * @param {Object} req - HTTP request object from WebSocket upgrade
 * @returns {string|null} JWT token or null
 */
function extractToken(req) {
  // Try query parameter first
  const urlParams = new URLSearchParams(req.url.split('?')[1]);
  const queryToken = urlParams.get('token');
  if (queryToken) return queryToken;

  // Try Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  return null;
}

/**
 * Verify JWT token and get VNC connection info
 * @param {string} token - JWT token
 * @param {string} vmId - Virtual machine ID
 * @param {Object} config - Configuration object with jwt.secret
 * @param {Object} ocloudviewService - OcloudView service instance
 * @param {Object} sessionStore - Session store instance
 * @returns {Promise<Object|null>} VNC connection info or null
 */
async function verifyAndGetVNCInfo(token, vmId, config, ocloudviewService, sessionStore) {
  try {
    // Verify JWT token
    const decoded = jwt.verify(token, config.jwt.secret);

    // If it's a VNC-specific token
    if (decoded.vmId && decoded.ocloudToken) {
      return await ocloudviewService.getCompleteVNCInfo(decoded.ocloudToken, vmId);
    }

    // If it's a user token, get info from session
    if (decoded.sessionId) {
      const sessionData = sessionStore.get(decoded.sessionId);
      if (sessionData) {
        return await ocloudviewService.getCompleteVNCInfo(sessionData.ocloudToken, vmId);
      }
    }

    return null;
  } catch (error) {
    console.error('Token verification error:', error.message);
    return null;
  }
}

/**
 * Handle WebSocket connection for VNC
 * @param {WebSocket} ws - WebSocket connection
 * @param {Object} req - HTTP request object
 * @param {Object} options - Handler options
 * @param {Object} options.wsProxy - WebsockifyProxy instance
 * @param {Object} options.config - Configuration object
 * @param {Object} options.ocloudviewService - OcloudView service
 * @param {Object} options.sessionStore - Session store
 */
async function handleVNCConnection(ws, req, options) {
  const { wsProxy, config, ocloudviewService, sessionStore } = options;

  // Extract VM ID from URL
  const urlParts = req.url.split('/');
  const vmIdWithParams = urlParts[urlParts.length - 1];
  const vmId = vmIdWithParams.split('?')[0];

  if (!vmId) {
    console.error('❌ No VM ID provided in WebSocket connection');
    ws.close(1002, 'VM ID required');
    return;
  }

  console.log(`🔌 New VNC WebSocket connection for VM: ${vmId}`);

  try {
    // Extract and verify token
    const token = extractToken(req);

    if (!token) {
      console.error('❌ No authentication token provided');
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Authentication required'
      }));
      ws.close(1008, 'Authentication required');
      return;
    }

    // Get VNC connection info
    const vncInfo = await verifyAndGetVNCInfo(
      token,
      vmId,
      config,
      ocloudviewService,
      sessionStore
    );

    if (!vncInfo) {
      console.error('❌ Failed to get VNC connection info');
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Failed to connect to VM'
      }));
      ws.close(1008, 'Connection failed');
      return;
    }

    // Establish WebSocket to TCP proxy
    await wsProxy.handleConnection(ws, {
      vmId,
      host: vncInfo.host,
      port: vncInfo.port,
      password: vncInfo.password
    });

  } catch (error) {
    console.error('❌ WebSocket connection error:', error);
    ws.send(JSON.stringify({
      type: 'error',
      message: error.message
    }));
    ws.close(1011, 'Internal error');
  }
}

module.exports = {
  extractToken,
  verifyAndGetVNCInfo,
  handleVNCConnection
};
