/**
 * SPICE WebSocket Connection Handler
 * Handles authentication and SPICE connection info retrieval for WebSocket connections
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
 * Verify JWT token and get SPICE connection info
 * @param {string} token - JWT token
 * @param {string} vmId - Virtual machine ID
 * @param {Object} config - Configuration object with jwt.secret
 * @param {Object} ocloudviewService - OcloudView service instance
 * @param {Object} sessionStore - Session store instance
 * @returns {Promise<Object|null>} SPICE connection info or null
 */
async function verifyAndGetSPICEInfo(token, vmId, config, ocloudviewService, sessionStore) {
  try {
    console.log('   [Auth] Verifying JWT token for SPICE...');
    // Verify JWT token
    const decoded = jwt.verify(token, config.jwt.secret);
    console.log('   [Auth] Token decoded:', {
      userId: decoded.userId,
      sessionId: decoded.sessionId,
      vmId: decoded.vmId,
      hasOcloudToken: !!decoded.ocloudToken
    });

    // If it's a VNC-specific token (reuse for SPICE)
    if (decoded.vmId && decoded.ocloudToken) {
      console.log('   [Auth] Using VM-specific token');
      const vncInfo = await ocloudviewService.getCompleteVNCInfo(decoded.ocloudToken, vmId);
      // Return SPICE port instead of VNC port
      return {
        host: vncInfo.host,
        port: vncInfo.spicePort || vncInfo.port,
        password: vncInfo.password
      };
    }

    // If it's a user token, get info from session
    if (decoded.sessionId) {
      console.log('   [Auth] Looking up session:', decoded.sessionId);
      const sessionData = sessionStore.get(decoded.sessionId);
      if (sessionData) {
        console.log('   [Auth] Session found');

        // Check session cache for SPICE connections
        if (sessionData.spiceConnections && sessionData.spiceConnections.has(vmId)) {
          const cachedInfo = sessionData.spiceConnections.get(vmId);
          console.log('   [Auth] ✅ Using cached SPICE info from session');
          return {
            host: cachedInfo.host,
            port: cachedInfo.port,
            password: cachedInfo.password
          };
        } else {
          console.log('   [Auth] ⚠️ SPICE info not cached, fetching from API');
          const vncInfo = await ocloudviewService.getCompleteVNCInfo(sessionData.ocloudToken, vmId);
          return {
            host: vncInfo.host,
            port: vncInfo.spicePort || vncInfo.port,
            password: vncInfo.password
          };
        }
      } else {
        console.error('   [Auth] Session not found in store');
      }
    } else {
      console.error('   [Auth] Token missing sessionId and vmId fields');
    }

    return null;
  } catch (error) {
    console.error('   [Auth] Token verification error:', error.message);
    if (error.name === 'TokenExpiredError') {
      console.error('   [Auth] Token expired at:', error.expiredAt);
    }
    return null;
  }
}

/**
 * Handle WebSocket connection for SPICE
 * @param {WebSocket} ws - WebSocket connection
 * @param {Object} req - HTTP request object
 * @param {Object} options - Handler options
 * @param {Object} options.wsProxy - WebsockifyProxy instance
 * @param {Object} options.config - Configuration object
 * @param {Object} options.ocloudviewService - OcloudView service
 * @param {Object} options.sessionStore - Session store
 */
async function handleSPICEConnection(ws, req, options) {
  const { wsProxy, config, ocloudviewService, sessionStore } = options;

  console.log(`🔌 New SPICE WebSocket connection request`);
  console.log(`   URL: ${req.url}`);
  console.log(`   Origin: ${req.headers.origin || 'none'}`);

  // Validate path format: should be /spice/{vmId}?token=xxx
  const urlPath = req.url.split('?')[0];
  console.log(`   Path: ${urlPath}`);

  if (!urlPath.startsWith('/spice/')) {
    console.error(`❌ Invalid WebSocket path: ${urlPath}`);
    console.error(`   Expected format: /spice/{vmId}?token=xxx`);
    ws.close(1002, 'Invalid path');
    return;
  }

  // Extract VM ID from URL
  const urlParts = urlPath.split('/');
  const vmId = urlParts[2]; // /spice/{vmId}

  console.log(`   VM ID: ${vmId}`);

  if (!vmId || vmId.trim() === '') {
    console.error('❌ No VM ID provided in WebSocket connection');
    ws.close(1002, 'VM ID required');
    return;
  }

  try {
    // Extract and verify token
    const token = extractToken(req);
    console.log(`   Token: ${token ? token.substring(0, 20) + '...' : 'null'}`);

    if (!token) {
      console.error('❌ No authentication token provided');
      ws.close(1008, 'Authentication required');
      return;
    }

    // Get SPICE connection info
    console.log(`   Verifying token and getting SPICE info...`);
    const spiceInfo = await verifyAndGetSPICEInfo(
      token,
      vmId,
      config,
      ocloudviewService,
      sessionStore
    );

    if (!spiceInfo) {
      console.error('❌ Failed to get SPICE connection info');
      console.error('   Check: Token validity, session data, OcloudView API');
      ws.close(1008, 'Connection failed');
      return;
    }

    console.log(`✅ SPICE info retrieved: ${spiceInfo.host}:${spiceInfo.port}`);

    // Establish WebSocket to TCP proxy
    await wsProxy.handleConnection(ws, {
      vmId,
      host: spiceInfo.host,
      port: spiceInfo.port,
      password: spiceInfo.password
    });

  } catch (error) {
    console.error('❌ SPICE WebSocket connection error:', error);
    console.error('   Stack:', error.stack);
    ws.close(1011, 'Internal error');
  }
}

module.exports = {
  extractToken,
  verifyAndGetSPICEInfo,
  handleSPICEConnection
};
