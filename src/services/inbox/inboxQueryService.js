/**
 * Inbox Query Service
 *
 * Pure, testable filter/query builders for the Inbox endpoints.
 *
 * Responsibilities
 * ────────────────
 *   - Translate HTTP query params into a Mongo filter for Interaction.find()
 *   - Translate HTTP query params into an aggregation $match stage for stats
 *   - Compute the deterministic cache key payload for the inbox list
 *   - Provide the stats $facet aggregation pipeline factory
 *
 * Non-responsibilities (kept OUT of this service on purpose)
 * ──────────────────────────────────────────────────────────
 *   - No Mongoose calls (no `.find()`, no `.aggregate()`) – controllers run them.
 *   - No `req` / `res` coupling – functions take plain `user` + `query` objects.
 *   - No response shaping / HTTP concerns.
 *
 * Error contract
 * ──────────────
 *   Pure builders throw `InboxQueryError` with `statusCode`, `code` for any
 *   400-class validation failure. Controllers translate to HTTP responses.
 *
 * Constants are exported so tests can assert behavior without magic numbers.
 */

'use strict';

// ─── constants ──────────────────────────────────────────────────────────────

const SLA_HOURS = 24;
const SLA_THRESHOLD_MS = SLA_HOURS * 60 * 60 * 1000;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_SORT_FIELD = 'platformCreatedAt';

class InboxQueryError extends Error {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {number} [opts.statusCode=400]
   * @param {string} [opts.code]
   */
  constructor(message, { statusCode = 400, code = null } = {}) {
    super(message);
    this.name = 'InboxQueryError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

// ─── pure helpers ───────────────────────────────────────────────────────────

/**
 * Normalize a query value that may arrive as:
 *   "a,b,c"              → ['a', 'b', 'c']
 *   ["a", "b,c"]         → ['a', 'b', 'c']
 *   ""  | null | undef   → []
 * Empty and whitespace-only tokens are dropped.
 */
function parseQueryCsv(val) {
  if (val == null || val === '') return [];
  if (Array.isArray(val)) {
    return val.flatMap((s) => String(s).split(',')).map((x) => x.trim()).filter(Boolean);
  }
  return String(val).split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Assign a single scalar or `$in` operator onto a Mongo filter for a field,
 * depending on how many CSV values were provided. No-op when value is empty.
 */
function setQueryFieldInOrEquals(queryObj, field, rawVal) {
  const parts = parseQueryCsv(rawVal);
  if (parts.length === 0) return;
  if (parts.length === 1) queryObj[field] = parts[0];
  else queryObj[field] = { $in: parts };
}

/**
 * Escape user-supplied text for safe use inside a Mongo `$regex` filter.
 * Emojis / unicode pass through (Mongo handles UTF-8 natively).
 */
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse & clamp pagination params.
 * Invalid numbers fall back to defaults; `limit` is capped at MAX_PAGE_SIZE.
 */
function resolvePagination({ page, limit }) {
  const safeLimit = Math.min(
    Math.max(parseInt(limit, 10) || DEFAULT_PAGE_SIZE, 1),
    MAX_PAGE_SIZE
  );
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  return { safePage, safeLimit, skip: (safePage - 1) * safeLimit };
}

/**
 * Build the platform-connection visibility filter.
 *
 * Rules:
 *   - only platforms with at least one active/connected row are visible;
 *   - interactions whose platformConnection is missing/null (legacy) are kept;
 *   - interactions whose platformConnection is stale (not active anymore) are
 *     also kept because the user reconnected under a new row.
 *
 * When there are zero active connections, returns a filter that always
 * evaluates to empty (`_id: { $in: [] }`) so no rows leak from prior orgs.
 */
function buildVisibilityFilter(activeConnections) {
  const list = Array.isArray(activeConnections) ? activeConnections : [];
  const activeConnectionIds = list.map((c) => c._id);
  const activePlatforms = [...new Set(list.map((c) => c.platform))];
  if (!activeConnectionIds.length || !activePlatforms.length) {
    return { _id: { $in: [] } };
  }
  return {
    $and: [
      { platform: { $in: activePlatforms } },
      {
        $or: [
          { platformConnection: { $in: activeConnectionIds } },
          { platformConnection: { $exists: false } },
          { platformConnection: null },
          {
            platformConnection: {
              $exists: true,
              $ne: null,
              $nin: activeConnectionIds
            }
          }
        ]
      }
    ]
  };
}

/**
 * Build a case-insensitive $or search condition against content + author fields.
 * Returns null when the search term is empty/whitespace.
 */
function buildSearchCondition(rawSearch) {
  const searchTerm = rawSearch ? String(rawSearch).trim() : '';
  if (!searchTerm) return null;
  const escaped = escapeRegex(searchTerm);
  return {
    $or: [
      { content: { $regex: escaped, $options: 'i' } },
      { 'author.name': { $regex: escaped, $options: 'i' } },
      { 'author.username': { $regex: escaped, $options: 'i' } }
    ]
  };
}

/**
 * Resolve view-mode overrides. Some view modes force sort + status filters:
 *   - assigned       → only chats assigned to me
 *   - needs_response → status = unread, oldest first
 *   - overdue        → status ∉ [replied, resolved], platformCreatedAt < SLA cutoff, oldest first
 *   - archived       → status = archived (the only way to see archived)
 *
 * For any non-archived view without an explicit status filter, archived is
 * hidden from the list.
 *
 * Mutates `query` in place (caller owns it); returns the effective sort fields.
 */
function applyViewMode({ query, user, rawStatus, viewMode, sortBy, sortOrder, slaCutoff }) {
  let effectiveSortBy = sortBy;
  let effectiveSortOrder = sortOrder;

  if (viewMode === 'assigned') {
    query.assignedTo = user._id;
  } else if (viewMode === 'needs_response') {
    query.status = 'unread';
    effectiveSortBy = 'platformCreatedAt';
    effectiveSortOrder = 'asc';
  } else if (viewMode === 'overdue') {
    query.status = { $nin: ['replied', 'resolved'] };
    query.platformCreatedAt = { $lt: slaCutoff };
    effectiveSortBy = 'platformCreatedAt';
    effectiveSortOrder = 'asc';
  } else if (viewMode === 'archived') {
    query.status = 'archived';
  }

  // Hide archived from every non-archived view that hasn't explicitly filtered by status.
  if (viewMode !== 'archived' && !rawStatus) {
    if (query.status && typeof query.status === 'object' && Array.isArray(query.status.$nin)) {
      query.status.$nin.push('archived');
    } else if (!query.status) {
      query.status = { $ne: 'archived' };
    }
  }

  return { effectiveSortBy, effectiveSortOrder };
}

// ─── list query builder (getInteractions) ───────────────────────────────────

/**
 * Build the full Mongo filter + sort for `GET /api/inbox`.
 *
 * @param {object} args
 * @param {object} args.user              Auth user (expects `_id`, `role`, `organization._id`)
 * @param {object} args.query             Parsed req.query
 * @param {Array}  args.activeConnections Pre-fetched active PlatformConnection rows
 *
 * @returns {{
 *   mongoQuery: object,
 *   effectiveSort: Record<string, 1|-1>,
 *   safePage: number,
 *   safeLimit: number,
 *   skip: number,
 *   searchTerm: string,
 *   cacheFilters: object
 * }}
 */
function buildListFilter({ user, query = {}, activeConnections = [] }) {
  if (!user || !user.organization || !user.organization._id) {
    throw new InboxQueryError('Missing organization context', { code: 'NO_ORG_CONTEXT' });
  }

  const {
    platform,
    type,
    sentiment,
    status,
    search,
    assignedTo,
    label,
    intentBucket,
    viewMode,
    postId,
    dateFrom,
    dateTo,
    chatOpen,
    page = 1,
    limit = DEFAULT_PAGE_SIZE,
    sortBy = DEFAULT_SORT_FIELD,
    sortOrder = 'desc'
  } = query;

  const { safePage, safeLimit, skip } = resolvePagination({ page, limit });

  const mongo = { organization: user.organization._id };

  // Multiselect sends CSV or repeated params → OR via $in (single value stays equality)
  setQueryFieldInOrEquals(mongo, 'platform', platform);
  setQueryFieldInOrEquals(mongo, 'type', type);
  if (postId) mongo['metadata.postId'] = postId;
  setQueryFieldInOrEquals(mongo, 'sentiment', sentiment);
  setQueryFieldInOrEquals(mongo, 'status', status);
  if (assignedTo) mongo.assignedTo = assignedTo;

  if (dateFrom || dateTo) {
    mongo.platformCreatedAt = {};
    if (dateFrom) mongo.platformCreatedAt.$gte = new Date(dateFrom);
    if (dateTo) {
      const end = new Date(dateTo);
      end.setHours(23, 59, 59, 999);
      mongo.platformCreatedAt.$lte = end;
    }
  }

  setQueryFieldInOrEquals(mongo, 'labels', label);

  // intentBucket === 'none' is injected into conditionsToAnd below (the old
  // inline-push into `mongo.$and` was overwritten by the final assignment —
  // fixed here so the "no intent bucket" filter actually takes effect).
  let intentBucketNoneCondition = null;
  if (intentBucket) {
    if (intentBucket === 'none') {
      intentBucketNoneCondition = {
        $or: [{ intentBucket: { $exists: false } }, { intentBucket: null }]
      };
    } else {
      mongo.intentBucket = intentBucket;
    }
  }

  const slaCutoff = new Date(Date.now() - SLA_THRESHOLD_MS);
  const { effectiveSortBy, effectiveSortOrder } = applyViewMode({
    query: mongo,
    user,
    rawStatus: status,
    viewMode,
    sortBy,
    sortOrder,
    slaCutoff
  });

  // Build ancillary conditions for the top-level $and.
  const visibilityFilter = buildVisibilityFilter(activeConnections);
  const searchCondition = buildSearchCondition(search);

  const agentCondition = user.role === 'agent'
    ? {
        $or: [
          { assignedTo: user._id },
          { 'assignmentHistory.assignedTo': user._id }
        ]
      }
    : null;

  const conditionsToAnd = [
    // Exclude replies — only parent interactions are listed.
    {
      $or: [
        { parentId: { $exists: false } },
        { parentId: null },
        { parentId: '' }
      ]
    },
    visibilityFilter
  ];

  if (intentBucketNoneCondition) conditionsToAnd.push(intentBucketNoneCondition);
  if (searchCondition) conditionsToAnd.push(searchCondition);
  if (agentCondition) conditionsToAnd.push(agentCondition);

  const chatOpenStr = chatOpen != null ? String(chatOpen).toLowerCase() : '';
  if (chatOpenStr === 'true' || chatOpenStr === '1') {
    conditionsToAnd.push({
      $or: [{ chatOpen: true }, { chatOpen: { $exists: false } }]
    });
  } else if (chatOpenStr === 'false' || chatOpenStr === '0') {
    conditionsToAnd.push({ chatOpen: false });
  }

  mongo.$and = conditionsToAnd;

  const effectiveSort = { [effectiveSortBy]: effectiveSortOrder === 'desc' ? -1 : 1 };

  // Cache key payload — must be deterministic across equivalent requests.
  const cacheSearchKey = search ? String(search).trim().toLowerCase() : '';
  const effectiveAssignedTo = viewMode === 'assigned'
    ? String(user._id)
    : (assignedTo || '');
  const activeConnectionIds = Array.isArray(activeConnections)
    ? activeConnections.map((c) => String(c._id)).sort()
    : [];

  const cacheFilters = {
    platform: platform || '',
    type: type || '',
    sentiment: sentiment || '',
    status: status || '',
    label: label || '',
    postId: postId || '',
    viewMode: viewMode || '',
    search: cacheSearchKey,
    page: safePage,
    limit: safeLimit,
    assignedTo: user.role === 'agent' ? String(user._id) : effectiveAssignedTo,
    activeConnections: activeConnectionIds.join(','),
    dateFrom: dateFrom ? String(dateFrom) : '',
    dateTo: dateTo ? String(dateTo) : '',
    intentBucket: intentBucket ? String(intentBucket) : '',
    chatOpen: chatOpen != null && chatOpen !== '' ? String(chatOpen) : ''
  };

  return {
    mongoQuery: mongo,
    effectiveSort,
    safePage,
    safeLimit,
    skip,
    searchTerm: search ? String(search).trim() : '',
    cacheFilters
  };
}

// ─── stats builder (getStats) ───────────────────────────────────────────────

/**
 * Build the $match stage for the stats aggregation.
 * Mirrors the list's visibility + parent-only rules.
 */
function buildStatsMatchStage({ orgId, platform, activeConnections = [] }) {
  if (!orgId) {
    throw new InboxQueryError('Missing organization context', { code: 'NO_ORG_CONTEXT' });
  }
  const visibilityFilter = buildVisibilityFilter(activeConnections);
  const matchStage = {
    organization: orgId,
    $and: [
      { $or: [{ parentId: { $exists: false } }, { parentId: null }, { parentId: '' }] },
      visibilityFilter
    ]
  };
  setQueryFieldInOrEquals(matchStage, 'platform', platform);
  return matchStage;
}

/**
 * Build the full stats aggregation pipeline ($match + $facet + reduce).
 * Returns counts per status, counts per sentiment, response rate, avg response
 * time, and overdue count — in one round-trip.
 */
function buildStatsAggregationPipeline({ matchStage, slaCutoff }) {
  if (!(slaCutoff instanceof Date) || Number.isNaN(slaCutoff.getTime())) {
    throw new InboxQueryError('Invalid SLA cutoff', { code: 'BAD_SLA_CUTOFF' });
  }
  return [
    { $match: matchStage },
    {
      $facet: {
        counts: [
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              unread: { $sum: { $cond: [{ $eq: ['$status', 'unread'] }, 1, 0] } },
              assigned: { $sum: { $cond: [{ $eq: ['$status', 'assigned'] }, 1, 0] } },
              replied: { $sum: { $cond: [{ $eq: ['$status', 'replied'] }, 1, 0] } },
              resolved: { $sum: { $cond: [{ $eq: ['$status', 'resolved'] }, 1, 0] } },
              positive: { $sum: { $cond: [{ $eq: ['$sentiment', 'positive'] }, 1, 0] } },
              negative: { $sum: { $cond: [{ $eq: ['$sentiment', 'negative'] }, 1, 0] } },
              neutral: { $sum: { $cond: [{ $eq: ['$sentiment', 'neutral'] }, 1, 0] } }
            }
          },
          {
            $addFields: {
              responseRate: {
                $cond: [
                  { $gt: ['$total', 0] },
                  { $round: [{ $multiply: [{ $divide: [{ $add: ['$replied', '$resolved'] }, '$total'] }, 100] }, 0] },
                  0
                ]
              }
            }
          }
        ],
        avgResponse: [
          {
            $match: {
              respondedAt: { $exists: true, $ne: null },
              platformCreatedAt: { $exists: true, $ne: null }
            }
          },
          {
            $group: {
              _id: null,
              avgMs: { $avg: { $subtract: ['$respondedAt', '$platformCreatedAt'] } }
            }
          }
        ],
        overdue: [
          {
            $match: {
              status: { $nin: ['replied', 'resolved'] },
              platformCreatedAt: { $lt: slaCutoff }
            }
          },
          { $count: 'count' }
        ]
      }
    },
    {
      $addFields: {
        _counts: { $arrayElemAt: ['$counts', 0] },
        _avgResp: { $arrayElemAt: ['$avgResponse', 0] },
        _overdue: { $arrayElemAt: ['$overdue', 0] }
      }
    },
    {
      $replaceRoot: {
        newRoot: {
          $mergeObjects: [
            { $ifNull: ['$_counts', {}] },
            {
              avgResponseTimeMinutes: {
                $cond: [
                  { $and: [{ $ne: ['$_avgResp.avgMs', null] }, { $gt: ['$_avgResp.avgMs', 0] }] },
                  { $round: [{ $divide: ['$_avgResp.avgMs', 60000] }, 0] },
                  null
                ]
              },
              overdueCount: { $ifNull: ['$_overdue.count', 0] }
            }
          ]
        }
      }
    },
    {
      $addFields: {
        total: { $ifNull: ['$total', 0] },
        unread: { $ifNull: ['$unread', 0] },
        assigned: { $ifNull: ['$assigned', 0] },
        replied: { $ifNull: ['$replied', 0] },
        resolved: { $ifNull: ['$resolved', 0] },
        responseRate: { $ifNull: ['$responseRate', 0] },
        positive: { $ifNull: ['$positive', 0] },
        negative: { $ifNull: ['$negative', 0] },
        neutral: { $ifNull: ['$neutral', 0] },
        overdueCount: { $ifNull: ['$overdueCount', 0] }
      }
    }
  ];
}

// ─── exports ────────────────────────────────────────────────────────────────

module.exports = {
  // constants
  SLA_HOURS,
  SLA_THRESHOLD_MS,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  DEFAULT_SORT_FIELD,

  // error class
  InboxQueryError,

  // pure helpers (exported for tests + reuse)
  parseQueryCsv,
  setQueryFieldInOrEquals,
  escapeRegex,
  resolvePagination,
  buildVisibilityFilter,
  buildSearchCondition,
  applyViewMode,

  // high-level builders
  buildListFilter,
  buildStatsMatchStage,
  buildStatsAggregationPipeline
};
