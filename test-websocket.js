#!/usr/bin/env node
/**
 * WebSocket Connection Tester
 * Tests WebSocket connection to the VNC server
 *
 * Usage:
 *   node test-websocket.js <vmId> <token>
 */

const WebSocket = require('ws');

// Get command line arguments
const vmId = process.argv[2] || '25ea8373-f9f2-4cb9-8108-3e2b49fe55c9';
const token = process.argv[3] || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJsaXl1bnRpYW4iLCJ1c2VybmFtZSI6ImxpeXVudGlhbiIsInNlc3Npb25JZCI6InNlc3Npb25fMTc2MjM5ODE3MzE3NV9mMGlrODg3ZDIiLCJpYXQiOjE3NjIzOTgxNzMsImV4cCI6MTc2MjQ4NDU3M30.3rhwBOWy78x-Ig8uYt4o9vTvuTE_fK076bZV_BWxOlU';

const wsUrl = `ws://localhost:3000/vnc/${vmId}?token=${token}`;

console.log('🧪 WebSocket Connection Test');
console.log('═══════════════════════════════════════════');
console.log(`VM ID: ${vmId}`);
console.log(`Token: ${token.substring(0, 30)}...`);
console.log(`URL: ${wsUrl}`);
console.log('═══════════════════════════════════════════\n');

// Create WebSocket connection
const ws = new WebSocket(wsUrl);

ws.on('open', () => {
  console.log('✅ WebSocket connection opened successfully!');
  console.log(`   State: ${ws.readyState} (OPEN)`);

  // Send a test message
  console.log('\n📤 Sending test ping...');
  ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));

  // Close after 2 seconds
  setTimeout(() => {
    console.log('\n👋 Closing connection...');
    ws.close();
  }, 2000);
});

ws.on('message', (data) => {
  console.log('📥 Received message:');
  try {
    const parsed = JSON.parse(data.toString());
    console.log('   Type:', parsed.type);
    console.log('   Data:', JSON.stringify(parsed, null, 2));
  } catch (e) {
    console.log('   Binary data, length:', data.length);
    console.log('   First 50 bytes:', data.toString('hex').substring(0, 100));
  }
});

ws.on('error', (error) => {
  console.error('❌ WebSocket error:');
  console.error('   Message:', error.message);
  console.error('   Code:', error.code);
  console.error('   Stack:', error.stack);
});

ws.on('close', (code, reason) => {
  console.log('\n🔌 WebSocket connection closed');
  console.log(`   Code: ${code}`);
  console.log(`   Reason: ${reason || 'No reason provided'}`);
  console.log(`   State: ${ws.readyState} (CLOSED)`);

  if (code === 1002) {
    console.log('\n💡 Code 1002 = VM ID required');
  } else if (code === 1008) {
    console.log('\n💡 Code 1008 = Authentication failed or connection info not available');
  } else if (code === 1011) {
    console.log('\n💡 Code 1011 = Internal server error');
  } else if (code === 1006) {
    console.log('\n💡 Code 1006 = Abnormal closure (connection lost or rejected)');
  }

  process.exit(code === 1000 ? 0 : 1);
});

// Handle script termination
process.on('SIGINT', () => {
  console.log('\n\n⚠️  Interrupted by user');
  ws.close();
  process.exit(0);
});
