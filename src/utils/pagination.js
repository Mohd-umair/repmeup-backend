const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Parse pagination params from req.query.
 * @param {object} query - req.query
 * @returns {{ page: number, limit: number, skip: number }}
 */
function parsePagination(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || DEFAULT_PAGE);
  let limit = parseInt(query.limit, 10) || DEFAULT_LIMIT;
  limit = Math.min(Math.max(1, limit), MAX_LIMIT);
  return { page, limit, skip: (page - 1) * limit };
}

/**
 * Build standard pagination metadata for response envelope.
 * @param {number} total - total document count
 * @param {number} page  - current page
 * @param {number} limit - page size
 * @returns {{ page: number, limit: number, total: number, pages: number }}
 */
function paginationMeta(total, page, limit) {
  return {
    page,
    limit,
    total,
    pages: Math.ceil(total / limit) || 1
  };
}

module.exports = { parsePagination, paginationMeta };
