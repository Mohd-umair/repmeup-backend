/**
 * socketEmitter — process-agnostic realtime emitter.
 *
 * Two modes, depending on which process we're in:
 *
 *   API process (server.js):
 *     setIO(io) is called once at startup. io has the @socket.io/redis-adapter
 *     attached, so io.to(room).emit() reaches clients connected to ANY API
 *     instance (pm2 cluster mode), not just this one.
 *
 *   Worker processes (worker.js, campaignWorker.js):
 *     initRedisEmitter(redisClient) is called once after Redis connects. Jobs
 *     hold no Socket.IO server — the @socket.io/redis-emitter publishes through
 *     the same adapter protocol, and the API instances deliver to their local
 *     sockets exactly once.
 *
 * Call emitToOrg() from any module without caring which process you're in.
 * Before this bridge existed, every emit from a worker job was silently
 * dropped in production (the _io null-check ate them).
 */

const logger = require('../config/logger');

let _io = null;       // API process: Socket.IO server (redis-adapter attached)
let _emitter = null;  // Worker processes: @socket.io/redis-emitter instance
let _warnedNoTransport = false;

/**
 * Store the Socket.IO server instance. Called once in server.js (API process).
 */
function setIO(io) {
  _io = io;
}

/**
 * Create the Redis-backed emitter for processes that have no Socket.IO server.
 * Called once in worker.js / campaignWorker.js after Redis connects.
 * @param {import('redis').RedisClientType} redisClient connected node-redis v4 client
 */
function initRedisEmitter(redisClient) {
  const { Emitter } = require('@socket.io/redis-emitter');
  _emitter = new Emitter(redisClient);
}

/**
 * Emit an event to all sockets in a specific organisation room — from any process.
 * @param {string} organizationId
 * @param {string} event   - socket event name
 * @param {any}    data
 */
function emitToOrg(organizationId, event, data) {
  const transport = _io || _emitter;
  if (!transport) {
    // Misconfigured process (neither setIO nor initRedisEmitter ran) — warn once
    // instead of silently eating realtime events.
    if (!_warnedNoTransport) {
      _warnedNoTransport = true;
      logger.warn('[socketEmitter] emitToOrg called but no transport initialized — realtime events are being dropped. Call setIO() (API) or initRedisEmitter() (worker) at startup.');
    }
    return;
  }
  transport.to(`org-${organizationId}`).emit(event, data);
}

module.exports = { setIO, initRedisEmitter, emitToOrg };
