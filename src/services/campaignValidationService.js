'use strict';

const Campaign = require('../models/Campaign');
const AudienceSnapshot = require('../models/AudienceSnapshot');
const AudienceMember = require('../models/AudienceMember');
const PlatformConnection = require('../models/PlatformConnection');
const WhatsAppTemplate = require('../models/WhatsAppTemplate');
const campaignConfig = require('../config/campaignConfig');

async function validateCampaign(orgId, campaignId) {
  const campaign = await Campaign.findOne({ _id: campaignId, organization: orgId }).lean();
  if (!campaign) throw Object.assign(new Error('Campaign not found'), { status: 404 });

  const checks = [];
  const warnings = [];

  checks.push({ key: 'audience', ok: Boolean(campaign.audienceSnapshot), label: 'Audience selected' });

  let eligible = 0;
  let excluded = 0;
  if (campaign.audienceSnapshot) {
    const snapshot = await AudienceSnapshot.findOne({
      _id: campaign.audienceSnapshot,
      organization: orgId
    }).lean();
    checks.push({
      key: 'materialized',
      ok: snapshot?.materializationStatus === 'ready',
      label: snapshot?.materializationStatus === 'ready'
        ? 'Audience snapshot is ready'
        : 'Audience snapshot is still being prepared'
    });
    const channel = campaign.channel;
    eligible = snapshot?.channelEligibility?.[channel]?.eligible || 0;
    excluded = snapshot?.channelEligibility?.[channel]?.ineligible || 0;
    if (!eligible) {
      eligible = await AudienceMember.countDocuments({
        organization: orgId,
        audienceSnapshot: campaign.audienceSnapshot,
        channel,
        eligible: true
      });
      excluded = await AudienceMember.countDocuments({
        organization: orgId,
        audienceSnapshot: campaign.audienceSnapshot,
        channel,
        eligible: false
      });
    }
  }
  checks.push({ key: 'eligible', ok: eligible > 0, label: `${eligible} ${campaign.channel} contacts eligible` });
  if (excluded > 0) warnings.push(`${excluded} contacts cannot receive ${campaign.channel}`);

  if (campaign.channel === 'whatsapp' && eligible > campaignConfig.maxRecipientsPerCampaign) {
    const cap = campaignConfig.maxRecipientsPerCampaign;
    warnings.push(
      `${eligible.toLocaleString()} WhatsApp contacts match, but only ${cap.toLocaleString()} can be sent per campaign. Extra contacts will be skipped.`
    );
  }

  const connection = campaign.connection
    ? await PlatformConnection.findOne({
      _id: campaign.connection,
      organization: orgId,
      platform: campaign.channel,
      isActive: true
    }).lean()
    : null;
  checks.push({ key: 'connection', ok: Boolean(connection), label: 'Channel is connected' });

  if (campaign.channel === 'whatsapp') {
    const templateId = campaign.content?.templateId;
    const tpl = templateId
      ? await WhatsAppTemplate.findOne({
        _id: templateId,
        organization: orgId,
        connection: campaign.connection
      }).lean()
      : null;
    const approved = String(tpl?.status || '').toUpperCase() === 'APPROVED';
    checks.push({ key: 'template', ok: approved, label: 'Template approved' });
  } else {
    const body = String(campaign.content?.body || '').trim();
    checks.push({ key: 'content', ok: Boolean(body), label: 'Message content is valid' });
    warnings.push('Only contacts with an active 24-hour conversation can receive this.');
  }

  const missingName = campaign.content?.body && /\{\{\s*first_name\s*\}\}/i.test(campaign.content.body);
  if (missingName) warnings.push('Some contacts may be missing first name');

  const ok = checks.every((c) => c.ok);
  return {
    ok,
    checks,
    warnings,
    sendable: eligible,
    excluded,
    matched: campaign.stats?.matched || 0
  };
}

module.exports = { validateCampaign };
