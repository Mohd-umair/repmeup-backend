/**
 * socketEmitter — thin singleton that holds the Socket.IO server instance.
 * Call setIO(io) once at server startup, then use emitToOrg() from any module
 * (jobs, controllers, services) without needing to pass io around manually.
 */

let _io = null;

/**
 * Store the Socket.IO server instance. Called once in server.js.
 */
function setIO(io) {
  _io = io;
}

/**
 * Emit an event to all sockets in a specific organisation room.
 * @param {string} organizationId
 * @param {string} event   - socket event name
 * @param {any}    data
 */
function emitToOrg(organizationId, event, data) {
  if (!_io) return;
  _io.to(`org-${organizationId}`).emit(event, data);
}

module.exports = { setIO, emitToOrg };
