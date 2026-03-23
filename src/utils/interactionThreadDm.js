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

module.exports = { isThreadStyleDm };
