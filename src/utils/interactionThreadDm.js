'use strict';

/**
 * Instagram & Facebook Messenger webhooks store each *conversation thread* as one Interaction
 * with platformId `dm_<igOrPageId>_<senderId>`. The `replies` array is the outbound thread
 * history — not "this one inbound message was already answered".
 *
 * For these threads we must still run AI / auto-reply on each new customer message.
 */
function isThreadStyleDm(interaction) {
  if (!interaction || interaction.type !== 'dm') return false;
  const pid = interaction.platformId;
  return typeof pid === 'string' && pid.startsWith('dm_');
}

/**
 * Reset the per-thread auto-reply hard-stop counters because a genuinely new
 * inbound customer message arrived (the customer is actively re-engaging).
 *
 * Thread-style DMs are one Interaction per conversation, so `autoReplyCount`
 * climbs for the whole conversation lifetime and would permanently lock the
 * thread out of auto-reply once it crosses `maxAutoReplies`. The cap is meant to
 * stop AI-to-AI loops (consecutive auto-replies with no human in between), so we
 * reset it whenever the human actually replies. Bot loops never trigger this
 * because they have no inbound message between replies.
 *
 * Call this only when a NEW message was appended (not a webhook retry).
 *
 * @param {import('mongoose').Model} InteractionModel
 * @param {object} query  Selector for the thread Interaction (e.g. { platformId, organization })
 * @returns {Promise<void>}
 */
async function resetAutoReplyCountersForNewInbound(InteractionModel, query) {
  await InteractionModel.updateOne(query, {
    $set: {
      autoReplyCount: 0,
      'escalationMetadata.sameTopicReplies': 0
    }
  });
}

module.exports = { isThreadStyleDm, resetAutoReplyCountersForNewInbound };
