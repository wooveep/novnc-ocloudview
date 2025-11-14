/**
 * WebSocket Connection Handler
 * Handles authentication and VNC connection info retrieval for WebSocket connections
 */

'use strict';

const jwt = require('jsonwebtoken');
const logger = require('./logger');

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
    logger.debug('   [Auth] Verifying JWT token...');
    // Verify JWT token
    const decoded = jwt.verify(token, config.jwt.secret);
    logger.debug('   [Auth] Token decoded:', {
      userId: decoded.userId,
      sessionId: decoded.sessionId,
      vmId: decoded.vmId,
      hasOcloudToken: !!decoded.ocloudToken
    });

    // If it's a VNC-specific token
    if (decoded.vmId && decoded.ocloudToken) {
      logger.debug('   [Auth] Using VNC-specific token');
      return await ocloudviewService.getCompleteVNCInfo(decoded.ocloudToken, vmId);
    }

    // If it's a user token, get info from session
    if (decoded.sessionId) {
      logger.debug('   [Auth] Looking up session:', decoded.sessionId);
      const sessionData = sessionStore.get(decoded.sessionId);
      if (sessionData) {
        logger.debug('   [Auth] Session found');

        // IMPORTANT: Check session cache first to use same password as frontend
        // OcloudView API returns different passwords on each call
        if (sessionData.vncConnections && sessionData.vncConnections.has(vmId)) {
          const cachedInfo = sessionData.vncConnections.get(vmId);
          logger.debug('   [Auth] ✅ Using cached VNC info from session');
          logger.debug('   [Auth] Password preview:', cachedInfo.password ? cachedInfo.password.substring(0, 3) + '***' : 'null');
          logger.debug('   [Auth] Cached at:', new Date(cachedInfo.timestamp).toISOString());
          return {
            host: cachedInfo.host,
            port: cachedInfo.port,
            password: cachedInfo.password
          };
        } else {
          logger.debug('   [Auth] ⚠️ VNC info not cached, fetching from API');
          logger.debug('   [Auth] Note: Frontend should call /api/vnc/connect/:vmId first to cache password');
          logger.debug('   [Auth] OcloudToken:', sessionData.ocloudToken ? sessionData.ocloudToken.substring(0, 20) + '...' : 'null');
          return await ocloudviewService.getCompleteVNCInfo(sessionData.ocloudToken, vmId);
        }
      } else {
        logger.error('   [Auth] Session not found in store');
        logger.error('   [Auth] Available sessions:', Array.from(sessionStore.keys()));
      }
    } else {
      logger.error('   [Auth] Token missing sessionId and vmId fields');
    }

    return null;
  } catch (error) {
    logger.error('   [Auth] Token verification error:', error.message);
    if (error.name === 'TokenExpiredError') {
      logger.error('   [Auth] Token expired at:', error.expiredAt);
    }
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

  logger.debug(`🔌 New WebSocket connection request`);
  logger.debug(`   URL: ${req.url}`);
  logger.debug(`   Origin: ${req.headers.origin || 'none'}`);

  // Validate path format: should be /vnc/{vmId}?token=xxx
  const urlPath = req.url.split('?')[0];
  logger.debug(`   Path: ${urlPath}`);

  if (!urlPath.startsWith('/vnc/')) {
    logger.error(`❌ Invalid WebSocket path: ${urlPath}`);
    logger.error(`   Expected format: /vnc/{vmId}?token=xxx`);
    ws.close(1002, 'Invalid path');
    return;
  }

  // Extract VM ID from URL
  const urlParts = urlPath.split('/');
  const vmId = urlParts[2]; // /vnc/{vmId}

  logger.debug(`   VM ID: ${vmId}`);

  if (!vmId || vmId.trim() === '') {
    logger.error('❌ No VM ID provided in WebSocket connection');
    ws.close(1002, 'VM ID required');
    return;
  }

  try {
    // Extract and verify token
    const token = extractToken(req);
    logger.debug(`   Token: ${token ? token.substring(0, 20) + '...' : 'null'}`);

    if (!token) {
      logger.error('❌ No authentication token provided');
      ws.close(1008, 'Authentication required');
      return;
    }

    // Get VNC connection info
    logger.debug(`   Verifying token and getting VNC info...`);
    const vncInfo = await verifyAndGetVNCInfo(
      token,
      vmId,
      config,
      ocloudviewService,
      sessionStore
    );

    if (!vncInfo) {
      logger.error('❌ Failed to get VNC connection info');
      logger.error('   Check: Token validity, session data, OcloudView API');
      ws.close(1008, 'Connection failed');
      return;
    }

    logger.debug(`✅ VNC info retrieved: ${vncInfo.host}:${vncInfo.port}`);

    // Establish WebSocket to TCP proxy
    await wsProxy.handleConnection(ws, {
      vmId,
      host: vncInfo.host,
      port: vncInfo.port,
      password: vncInfo.password
    });

  } catch (error) {
    logger.error('❌ WebSocket connection error:', error);
    logger.error('   Stack:', error.stack);
    ws.close(1011, 'Internal error');
  }
}

module.exports = {
  extractToken,
  verifyAndGetVNCInfo,
  handleVNCConnection
};
