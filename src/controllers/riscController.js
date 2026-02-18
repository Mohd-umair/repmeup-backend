const riscService = require('../integrations/google/riscService');

/**
 * POST /api/auth/risc/receiver
 *
 * Google Cross-Account Protection (RISC) event receiver.
 * Accepts Security Event Tokens (SETs) as raw JWT strings in the request body
 * with Content-Type: application/secevent+jwt.
 *
 * Spec: https://developers.google.com/identity/protocols/risc
 */
exports.receiveSecurityEvent = async (req, res) => {
  try {
    // Google sends the SET as a raw JWT string body
    // Express raw body middleware parses it as Buffer or the body-parser
    // reads it as text when content-type is application/secevent+jwt
    let rawToken = req.body;

    if (Buffer.isBuffer(rawToken)) {
      rawToken = rawToken.toString('utf-8');
    }

    if (typeof rawToken !== 'string' || !rawToken.trim()) {
      return res.status(400).json({ error: 'Missing or invalid security event token' });
    }

    rawToken = rawToken.trim();

    const result = await riscService.processSecurityEventToken(rawToken);

    // Per RISC spec, respond with 202 Accepted on success
    return res.status(202).json(result);
  } catch (error) {
    // Return 400 for validation failures (bad token, bad signature, etc.)
    const isValidationError =
      error.name === 'JsonWebTokenError' ||
      error.name === 'NotBeforeError' ||
      (error.message && (
        error.message.includes('Malformed') ||
        error.message.includes('invalid') ||
        error.message.includes('signature')
      ));

    if (isValidationError) {
      return res.status(400).json({ error: 'Invalid security event token', detail: error.message });
    }

    // Server-side errors → 500 (Google will retry)
    return res.status(500).json({ error: 'Internal server error processing security event' });
  }
};

/**
 * GET /api/auth/risc/status
 *
 * Returns the current RISC stream registration status.
 * Protected — admin only.
 */
exports.getStatus = async (req, res) => {
  res.json({
    success: true,
    data: {
      receiverEndpoint: `${process.env.BACKEND_URL || process.env.API_URL}/api/auth/risc/receiver`,
      configured: !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
      clientId: process.env.GOOGLE_CLIENT_ID ? '***configured***' : 'NOT SET',
    },
  });
};
