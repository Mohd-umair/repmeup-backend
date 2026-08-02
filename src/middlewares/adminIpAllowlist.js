'use strict';

/**
 * Admin IP Allowlist Middleware
 *
 * Guards all super-admin routes by restricting access to a configurable set of
 * trusted IPs or CIDR ranges. Zero external dependencies — pure Node.js using
 * the built-in `net` module.
 *
 * Configuration (environment variables):
 *   ADMIN_ALLOWED_IPS          — comma-separated exact IPs or CIDR blocks
 *                                  e.g. "203.0.113.1,10.0.0.0/8,192.168.1.0/24"
 *                                  When empty the gate is open (warn in production).
 *   ADMIN_IP_ALLOWLIST_ENABLED — set to "false" to bypass entirely (dev / CI use).
 *                                  Defaults to true; always enforced in production
 *                                  when ADMIN_ALLOWED_IPS is non-empty.
 *
 * IPv4 only. IPv6-mapped IPv4 addresses (::ffff:x.x.x.x) are unwrapped
 * automatically so that requests arriving through a dual-stack proxy are handled
 * correctly.
 */

const net = require('net');

/**
 * Convert a dotted-decimal IPv4 string to a 32-bit unsigned integer.
 *
 * @param {string} ip  e.g. "192.168.1.1"
 * @returns {number}
 */
function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, octet) => ((acc << 8) + parseInt(octet, 10)) >>> 0, 0);
}

/**
 * Test whether an IPv4 address falls inside a CIDR block.
 *
 * @param {string} ip    dotted-decimal host address
 * @param {string} cidr  CIDR notation, e.g. "10.0.0.0/8"
 * @returns {boolean}
 */
function ipInCIDR(ip, cidr) {
  const slashIdx = cidr.lastIndexOf('/');
  if (slashIdx === -1) return ip === cidr;
  const range = cidr.slice(0, slashIdx);
  const bits = parseInt(cidr.slice(slashIdx + 1), 10);
  if (isNaN(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(range) & mask);
}

/**
 * Check whether a client IP is in the allowlist.
 *
 * @param {string}   clientIp  Resolved client address (after IPv6-map stripping)
 * @param {string[]} allowed   Pre-parsed allowlist entries (IPs or CIDRs)
 * @returns {boolean}
 */
function isAllowed(clientIp, allowed) {
  if (!net.isIPv4(clientIp)) {
    // IPv6 addresses that are not mapped IPv4 fall through as blocked.
    // Extend here if you need native IPv6 CIDR support.
    return false;
  }
  return allowed.some((entry) =>
    entry.includes('/') ? ipInCIDR(clientIp, entry) : clientIp === entry
  );
}

/**
 * Express middleware: reject requests from IPs not in ADMIN_ALLOWED_IPS.
 *
 * Applied as the first gate on super-admin routes so unauthenticated probes
 * are blocked before any JWT validation occurs.
 */
exports.adminIpAllowlist = (req, res, next) => {
  const enabled = process.env.ADMIN_IP_ALLOWLIST_ENABLED !== 'false';
  const raw = (process.env.ADMIN_ALLOWED_IPS || '').trim();
  const allowed = raw.split(',').map((s) => s.trim()).filter(Boolean);

  // Gate is disabled or no IPs are configured.
  if (!enabled || allowed.length === 0) {
    if (enabled && process.env.NODE_ENV === 'production' && !raw) {
      // Non-fatal warning — do not block, but alert operators via logs.
      console.warn(
        '[adminIpAllowlist] ADMIN_ALLOWED_IPS is not set in production. ' +
        'The super-admin API is reachable from any IP. ' +
        'Set ADMIN_ALLOWED_IPS to restrict access.'
      );
    }
    return next();
  }

  // Resolve the true client IP.
  // Express sets req.ip to the right-most trusted address when trust proxy is on.
  const rawIp = req.ip || req.socket?.remoteAddress || '';
  // Strip IPv6-mapped IPv4 prefix (::ffff:1.2.3.4 → 1.2.3.4)
  const clientIp = rawIp.replace(/^::ffff:/, '');

  if (!isAllowed(clientIp, allowed)) {
    console.warn('[adminIpAllowlist] Blocked admin request', {
      ip: clientIp,
      path: req.originalUrl,
      method: req.method
    });
    return res.status(403).json({ success: false, error: 'Access denied' });
  }

  next();
};
