/**
 * Converts legacy Organization growth automation settings into draft AutomationFlow graphs.
 */
const Organization = require('../../models/Organization');

function nid(prefix, i) {
  return `${prefix}_${i}`;
}

function edge(source, target, label = '') {
  return { id: `edge_${source}_${target}`, source, target, label };
}

function buildCommentToDmFlow(org) {
  const s = org.commentToDmSettings || {};
  const nodes = [
    { id: nid('n', 1), type: 'trigger.ig_comment', label: 'Instagram comment', position: { x: 80, y: 80 }, config: { keywords: s.triggerKeywords || [] }, supportedChannels: ['instagram'] },
    { id: nid('n', 2), type: 'condition.keyword_match', label: 'Keyword match', position: { x: 320, y: 80 }, config: { keywords: s.triggerKeywords || [] }, supportedChannels: ['instagram'] },
    { id: nid('n', 3), type: 'action.reply_public_comment', label: 'Public reply', position: { x: 560, y: 40 }, config: { text: s.publicReplyTemplate || '' }, supportedChannels: ['instagram'] },
    { id: nid('n', 4), type: 'action.send_text', label: 'Product DM', position: { x: 560, y: 160 }, config: { text: s.dmTemplate || '' }, supportedChannels: ['instagram'] },
    { id: nid('n', 5), type: 'control.end', label: 'End', position: { x: 800, y: 120 }, config: {}, supportedChannels: ['instagram'] }
  ];
  const edges = [
    edge(nid('n', 1), nid('n', 2)),
    edge(nid('n', 2), nid('n', 3), 'match'),
    edge(nid('n', 2), nid('n', 4), 'match'),
    edge(nid('n', 3), nid('n', 5)),
    edge(nid('n', 4), nid('n', 5))
  ];
  return { name: 'Comment to DM (imported)', description: 'Imported from Growth → Comment-to-DM settings.', channels: ['instagram'], nodes, edges, entryNodeId: nid('n', 1) };
}

function buildStoryToDmFlow(org) {
  const s = org.storyToDmSettings || {};
  const nodes = [
    { id: nid('n', 1), type: 'trigger.ig_story_reply', label: 'Story reply', position: { x: 80, y: 80 }, config: { keywords: s.triggerKeywords || [] }, supportedChannels: ['instagram'] },
    { id: nid('n', 2), type: 'action.send_generic_template', label: 'Welcome card', position: { x: 360, y: 80 }, config: { title: s.welcomeTitle || 'Thanks for replying!', subtitle: s.welcomeSubtitle || '', imageUrl: s.welcomeImageUrl || '' }, supportedChannels: ['instagram'] },
    { id: nid('n', 3), type: 'control.end', label: 'End', position: { x: 640, y: 80 }, config: {}, supportedChannels: ['instagram'] }
  ];
  const edges = [edge(nid('n', 1), nid('n', 2)), edge(nid('n', 2), nid('n', 3))];
  return { name: 'Story to DM (imported)', description: 'Imported from Growth → Story-to-DM settings.', channels: ['instagram'], nodes, edges, entryNodeId: nid('n', 1) };
}

function buildSalesFlow(org) {
  const s = org.salesFlowSettings || {};
  const nodes = [
    { id: nid('n', 1), type: 'trigger.ig_comment', label: 'Sales comment', position: { x: 80, y: 80 }, config: {}, supportedChannels: ['instagram'] },
    { id: nid('n', 2), type: 'action.send_generic_template', label: 'CTA card', position: { x: 360, y: 80 }, config: { title: s.ctaTitle || '', subtitle: s.ctaSubtitle || '', imageUrl: s.ctaImageUrl || '', buttons: s.ctaButtons || [] }, supportedChannels: ['instagram'] },
    { id: nid('n', 3), type: 'trigger.ig_dm', label: 'DM follow-up', position: { x: 360, y: 220 }, config: {}, supportedChannels: ['instagram'] },
    { id: nid('n', 4), type: 'action.send_text', label: 'WhatsApp capture', position: { x: 640, y: 220 }, config: { text: s.whatsappCaptureMessage || '' }, supportedChannels: ['instagram'] },
    { id: nid('n', 5), type: 'control.end', label: 'End', position: { x: 880, y: 160 }, config: {}, supportedChannels: ['instagram'] }
  ];
  const edges = [
    edge(nid('n', 1), nid('n', 2)),
    edge(nid('n', 2), nid('n', 5)),
    edge(nid('n', 3), nid('n', 4)),
    edge(nid('n', 4), nid('n', 5))
  ];
  return { name: 'Sales conversation (imported)', description: 'Imported from Growth → Sales flow settings.', channels: ['instagram'], nodes, edges, entryNodeId: nid('n', 1) };
}

function buildFollowInviteFlow(org) {
  const s = org.commentFollowInviteSettings || {};
  const nodes = [
    { id: nid('n', 1), type: 'trigger.ig_comment', label: 'Top-level comment', position: { x: 80, y: 80 }, config: {}, supportedChannels: ['instagram'] },
    { id: nid('n', 2), type: 'action.send_generic_template', label: 'Follow invite', position: { x: 360, y: 80 }, config: { title: s.title || '', subtitle: s.subtitle || '', imageUrl: s.imageUrl || '', buttons: [{ label: s.buttonTitle || 'Follow us', type: 'web_url', url: s.buttonUrl || '' }] }, supportedChannels: ['instagram'] },
    { id: nid('n', 3), type: 'control.end', label: 'End', position: { x: 640, y: 80 }, config: {}, supportedChannels: ['instagram'] }
  ];
  const edges = [edge(nid('n', 1), nid('n', 2)), edge(nid('n', 2), nid('n', 3))];
  return { name: 'Follow invite (imported)', description: 'Imported from Growth → Follow invite settings.', channels: ['instagram'], nodes, edges, entryNodeId: nid('n', 1) };
}

/**
 * @param {import('mongoose').Types.ObjectId} organizationId
 * @param {{ sources?: string[] }} options
 */
async function buildDraftsFromGrowthSettings(organizationId, options = {}) {
  const org = await Organization.findById(organizationId)
    .select('commentToDmSettings storyToDmSettings salesFlowSettings commentFollowInviteSettings')
    .lean();
  if (!org) throw new Error('Organization not found');

  const all = [];
  if (org.commentToDmSettings?.enabled) all.push(buildCommentToDmFlow(org));
  if (org.storyToDmSettings?.enabled) all.push(buildStoryToDmFlow(org));
  if (org.salesFlowSettings?.enabled) all.push(buildSalesFlow(org));
  if (org.commentFollowInviteSettings?.enabled) all.push(buildFollowInviteFlow(org));

  const sources = options.sources?.length ? options.sources : null;
  if (sources) {
    const map = {
      commentToDm: buildCommentToDmFlow,
      storyToDm: buildStoryToDmFlow,
      salesFlow: buildSalesFlow,
      followInvite: buildFollowInviteFlow
    };
    return sources.map((key) => map[key]?.(org)).filter(Boolean);
  }
  return all;
}

module.exports = {
  buildDraftsFromGrowthSettings,
  buildCommentToDmFlow,
  buildStoryToDmFlow,
  buildSalesFlow,
  buildFollowInviteFlow
};
