/**
 * Parse CORS_ORIGIN as comma-separated list (e.g. main app + super admin panel).
 * Example: CORS_ORIGIN=http://localhost:4200,http://localhost:4201
 */
function getCorsOriginList() {
  const raw =
    process.env.CORS_ORIGIN || process.env.FRONTEND_URL || 'http://localhost:4200';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Express `cors` package `origin` option: string | RegExp | (origin, cb) | true */
function getCorsOriginOption() {
  const list = getCorsOriginList();
  if (list.length === 0) return true;
  if (list.length === 1) return list[0];
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
