/** Local super-admin panel (Angular) — merged in development when missing from env. */
const DEV_ADMIN_ORIGINS = ['http://localhost:4201'];

/**
 * Parse CORS_ORIGIN as comma-separated list (e.g. main app + super admin panel).
 * Example: CORS_ORIGIN=http://localhost:4200,http://localhost:4201
 *
 * Default includes :4201 so the Angular admin panel (usually that port) can call the API locally.
 */
function getCorsOriginList() {
  const raw =
    process.env.CORS_ORIGIN ||
    process.env.FRONTEND_URL ||
    'http://localhost:4200,http://localhost:4201';
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (process.env.NODE_ENV !== 'production') {
    for (const origin of DEV_ADMIN_ORIGINS) {
      if (!list.includes(origin)) list.push(origin);
    }
  }

  return list;
}

function getCorsOriginOption() {
  const list = getCorsOriginList();
  if (list.length === 0) return true;

  // Always use a callback so each request gets its matching origin reflected
  // (a single static string breaks the admin panel on :4201 when env only lists :4200).
  return (origin, callback) => {
    if (!origin) return callback(null, true);
    if (list.includes(origin)) return callback(null, true);
    callback(null, false);
  };
}

module.exports = {
  getCorsOriginList,
  getCorsOriginOption
};
