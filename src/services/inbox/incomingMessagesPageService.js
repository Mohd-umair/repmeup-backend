'use strict';

const mongoose = require('mongoose');

/** Default page size for DM thread chunks — last N messages per request; older pages use msgBefore. */
const DEFAULT_INCOMING_MSG_LIMIT = 10;
const MAX_INCOMING_MSG_LIMIT = 300;

/**
 * Returns one page of metadata.incomingMessages without loading the interaction via
 * Interaction.find() (which would hydrate the entire embedded array in Node).
 *
 * @param {import('mongoose').Model} Interaction
 * @param {string|import('mongoose').Types.ObjectId} interactionId
 * @param {{ msgLimit?: string|number, msgBefore?: string|number|null }} [options]
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

  // ONE-PASS pipeline. The previous version chained 2–3 $project stages that each re-
  // materialized the incomingMessages array (O(N) per stage, expensive on large threads).
  // Collapsing into a single $project with inline $let keeps MongoDB on a single pass.
  /** @type {object[]} */
  let pipeline;
  if (msgBeforeNum != null && !Number.isNaN(msgBeforeNum)) {
    pipeline = [
      { $match: { _id: oid } },
      {
        $project: {
          _id: 0,
          totalMessages: { $size: { $ifNull: ['$metadata.incomingMessages', []] } },
          result: {
            $let: {
              vars: {
                filtered: {
                  $filter: {
                    input: { $ifNull: ['$metadata.incomingMessages', []] },
                    as: 'm',
                    cond: { $lt: [{ $ifNull: ['$$m.timestamp', 0] }, msgBeforeNum] }
                  }
                }
              },
              in: {
                hasOlderMessages: { $gt: [{ $size: '$$filtered' }, limit] },
                incomingMessages: { $slice: ['$$filtered', -limit] }
              }
            }
          }
        }
      }
    ];
  } else {
    pipeline = [
      { $match: { _id: oid } },
      {
        $project: {
          _id: 0,
          totalMessages: { $size: { $ifNull: ['$metadata.incomingMessages', []] } },
          result: {
            hasOlderMessages: {
              $gt: [{ $size: { $ifNull: ['$metadata.incomingMessages', []] } }, limit]
            },
            incomingMessages: { $slice: [{ $ifNull: ['$metadata.incomingMessages', []] }, -limit] }
          }
        }
      }
    ];
  }

  const rows = await Interaction.aggregate(pipeline);
  const row = rows[0];
  if (!row) {
    return {
      incomingMessages: [],
      totalMessages: 0,
      hasOlderMessages: false,
      oldestMessageTimestamp: null,
      returnedMessages: 0
    };
  }

  const resultPart = row.result || {};
  const incomingMessages = resultPart.incomingMessages || [];
  const oldestMessageTimestamp = incomingMessages.length > 0 ? incomingMessages[0].timestamp ?? null : null;

  return {
    incomingMessages,
    totalMessages: typeof row.totalMessages === 'number' ? row.totalMessages : 0,
    hasOlderMessages: !!resultPart.hasOlderMessages,
    oldestMessageTimestamp,
    returnedMessages: incomingMessages.length
  };
}

module.exports = {
  getIncomingMessagesPage,
  DEFAULT_INCOMING_MSG_LIMIT,
  MAX_INCOMING_MSG_LIMIT
};
