'use strict';

const mongoose = require('mongoose');

/** Default DM thread chunks — semantic “latest N inbound” after global chronological sort */
const DEFAULT_INCOMING_MSG_LIMIT = 10;
const MAX_INCOMING_MSG_LIMIT = 300;

/** Match frontend `normalizeTimestampMs`: unix *seconds* are below this cutoff */
const SECONDS_MS_CUTOFF = 10_000_000_000;

/**
 * Server-side heuristic for timestamps stored as unix seconds vs ms on DM rows (same units as Angular).
 */
function normalizeTimestampJs(raw) {
  if (raw == null || Number.isNaN(Number(raw))) return null;
  const n = Number(raw);
  return n > 0 && n < SECONDS_MS_CUTOFF ? n * 1000 : n;
}

/** Aggregation subtree: coerce `$$mx.timestamp` to canonical ms (`__sortTs` on augmented rows). */
const sortKeyFromMx = {
  $let: {
    vars: {
      raw: {
        $ifNull: [{ $convert: { input: '$$mx.timestamp', to: 'double', onError: 0 } }, 0]
      }
    },
    in: {
      $cond: [
        { $lte: ['$$raw', 0] },
        0,
        {
          $cond: [
            { $lt: ['$$raw', SECONDS_MS_CUTOFF] },
            { $multiply: ['$$raw', 1000] },
            '$$raw'
          ]
        }
      ]
    }
  }
};

/** Strip augmentation field before returning over HTTP */
function stripAugmentedRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows || [];
  return rows.map((m) => {
    if (!m || typeof m !== 'object') return m;
    const { __sortTs, ...rest } = m;
    return rest;
  });
}

/**
 * One chronological page over `metadata.incomingMessages`:
 * - Builds **canonical ms sort key** (`__sortTs`), sort ascending, slice **tail** ⇒ **latest page** regardless of malformed array insertion order (e.g. IG sync newest-first bursts).
 * - **msgBefore**: raw BSON `timestamp` of the oldest message currently displayed; filter `__sortTs &lt; normalize(msgBefore)`, then slice tail ⇒ next block going **backward** in chat time.
 *
 * Returns original message objects (sans `__sortTs`).
 */
async function getIncomingMessagesPage(Interaction, interactionId, options = {}) {
  const limit = Math.min(
    Math.max(parseInt(String(options.msgLimit || DEFAULT_INCOMING_MSG_LIMIT), 10) || DEFAULT_INCOMING_MSG_LIMIT, 1),
    MAX_INCOMING_MSG_LIMIT
  );

  const rawBefore = options.msgBefore;
  const msgBeforeNum =
    rawBefore !== undefined && rawBefore !== null && rawBefore !== ''
      ? Number(rawBefore)
      : null;

  const oid = new mongoose.Types.ObjectId(interactionId);

  const msgCursorNormJs =
    msgBeforeNum != null && !Number.isNaN(msgBeforeNum)
      ? normalizeTimestampJs(msgBeforeNum)
      : null;

  const annotatedRows = {
    $map: {
      input: { $ifNull: ['$metadata.incomingMessages', []] },
      as: 'mx',
      in: {
        $mergeObjects: [
          '$$mx',
          { __sortTs: sortKeyFromMx }
        ]
      }
    }
  };

  const sortedRows = {
    $sortArray: {
      input: annotatedRows,
      sortBy: { __sortTs: 1 }
    }
  };

  const pooledRows =
    msgCursorNormJs != null
      ? {
          $filter: {
            input: sortedRows,
            as: 'r',
            cond: {
              $lt: ['$$r.__sortTs', { $literal: msgCursorNormJs }]
            }
          }
        }
      : sortedRows;

  const aggResultExpr = {
    $let: {
      vars: {
        pool: pooledRows,
        lim: limit
      },
      in: {
        page: { $slice: ['$$pool', { $multiply: [-1, '$$lim'] }] },
        poolSize: { $size: '$$pool' }
      }
    }
  };

  const pipeline = [
    { $match: { _id: oid } },
    {
      $project: {
        _id: 0,
        totalMessages: { $size: { $ifNull: ['$metadata.incomingMessages', []] } },
        agg: aggResultExpr
      }
    }
  ];

  const rows = await Interaction.aggregate(pipeline);
  const doc = rows[0];
  if (!doc) {
    return {
      incomingMessages: [],
      totalMessages: 0,
      hasOlderMessages: false,
      oldestMessageTimestamp: null,
      returnedMessages: 0
    };
  }

  const totalMessages = typeof doc.totalMessages === 'number' ? doc.totalMessages : 0;
  const agg = doc.agg || {};
  const pageArr = Array.isArray(agg.page) ? agg.page : [];
  const poolSize = typeof agg.poolSize === 'number' ? agg.poolSize : 0;

  const incomingMessages = stripAugmentedRows(pageArr);
  const returnedMessages = incomingMessages.length;

  let hasOlderMessages;
  if (msgCursorNormJs != null) {
    hasOlderMessages = poolSize > limit;
  } else {
    hasOlderMessages = totalMessages > returnedMessages;
  }

  const oldestMessageTimestamp =
    incomingMessages.length > 0 ? incomingMessages[0].timestamp ?? null : null;

  return {
    incomingMessages,
    totalMessages,
    hasOlderMessages,
    oldestMessageTimestamp,
    returnedMessages
  };
}

module.exports = {
  getIncomingMessagesPage,
  DEFAULT_INCOMING_MSG_LIMIT,
  MAX_INCOMING_MSG_LIMIT
};
