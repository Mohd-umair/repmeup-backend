'use strict';

/**
 * Campaign outbound messages that failed to send or deliver must not appear in inbox.
 */

function isCampaignOutboundReply(reply) {
  return Boolean(reply?.whatsappTemplatePreview?.campaignId);
}

/**
 * A campaign template reply that was accepted by Meta (has wamid) and not failed/deleted.
 */
function isSuccessfulCampaignReply(reply) {
  if (!isCampaignOutboundReply(reply)) return false;
  if (reply.status === 'failed' || reply.status === 'deleted') return false;
  if (reply.deliveryStatus === 'failed') return false;
  return Boolean(reply.platformResponseId);
}

/**
 * Hide failed/unsent campaign replies from inbox thread rendering.
 */
function filterInboxReplies(replies) {
  return (replies || []).filter((reply) => {
    if (reply.status === 'deleted') return false;
    if (isCampaignOutboundReply(reply) && !isSuccessfulCampaignReply(reply)) return false;
    return true;
  });
}

/**
 * Hide inbox list rows that exist only because a campaign send failed (ghost threads).
 * Successful sends replace list preview content with template body text, not [Campaign]…
 */
function isCampaignOnlyFailedThread(interaction) {
  if (!interaction || interaction.source !== 'campaign') return false;

  const incoming = interaction.metadata?.incomingMessages || [];
  if (incoming.length > 0) return false;

  const content = String(interaction.content || '');
  if (!content.startsWith('[Campaign]')) return false;

  const replies = interaction.replies || [];
  if (replies.some(isSuccessfulCampaignReply)) return false;
  if (replies.some((r) => !isCampaignOutboundReply(r) && r.status !== 'deleted')) return false;

  return true;
}

module.exports = {
  isCampaignOutboundReply,
  isSuccessfulCampaignReply,
  filterInboxReplies,
  isCampaignOnlyFailedThread
};
