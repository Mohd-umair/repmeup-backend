const Lead = require('../../models/Lead');
const LeadActivity = require('../../models/LeadActivity');
const ContactInquiry = require('../../models/ContactInquiry');
const GrowthAudit = require('../../models/GrowthAudit');
const logger = require('../../config/logger');

const SOURCE_LABELS = {
  website_contact: 'website contact form',
  demo_booking: 'demo booking',
  growth_audit: 'growth audit'
};

/**
 * Dedup lookup: email wins over phone. Only live leads are candidates —
 * a re-submission after soft delete becomes a fresh lead.
 */
async function findExisting({ email, phone }) {
  if (email) {
    const byEmail = await Lead.findOne({ isDeleted: false, email });
    if (byEmail) return byEmail;
  }
  if (phone) {
    return Lead.findOne({ isDeleted: false, phone });
  }
  return null;
}

/**
 * Core capture: merge into an existing lead (by email/phone) or create a new
 * one. Idempotent per source doc — a refId already present in `captures` is
 * skipped, which makes backfill safely re-runnable.
 *
 * Never throws: callers on public endpoints fire-and-forget and must not be
 * blocked or failed by CRM issues.
 */
async function capture({
  name,
  email,
  phone,
  company,
  source,
  kind,
  refId,
  meta = {},
  initialStatus = 'new'
}) {
  try {
    const normalizedEmail = (email || '').trim().toLowerCase();
    const normalizedPhone = (phone || '').trim();
    if (!normalizedEmail && !normalizedPhone) return { outcome: 'skipped' };

    const existing = await findExisting({ email: normalizedEmail, phone: normalizedPhone });

    if (existing) {
      if (refId && existing.captures.some((c) => c.refId && c.refId.equals(refId))) {
        return { outcome: 'skipped', leadId: existing._id };
      }

      existing.captures.push({ kind, refId: refId || null, source, at: new Date() });
      // Fill gaps only — never overwrite contact info the team may have curated
      if (!existing.email && normalizedEmail) existing.email = normalizedEmail;
      if (!existing.phone && normalizedPhone) existing.phone = normalizedPhone;
      if (!existing.company && company) existing.company = company;
      existing.meta = { ...existing.meta, ...meta };
      existing.lastActivityAt = new Date();
      await existing.save();

      await LeadActivity.create({
        lead: existing._id,
        type: 'system',
        body: `New ${SOURCE_LABELS[source] || source} submission — merged into existing lead`,
        meta: { source, refId: refId || null }
      });

      return { outcome: 'merged', leadId: existing._id };
    }

    const lead = await Lead.create({
      name: name || normalizedEmail || normalizedPhone,
      email: normalizedEmail,
      phone: normalizedPhone,
      company: company || '',
      source,
      status: initialStatus,
      meta,
      captures: [{ kind, refId: refId || null, source, at: new Date() }]
    });

    await LeadActivity.create({
      lead: lead._id,
      type: 'system',
      body: `Auto-captured from ${SOURCE_LABELS[source] || source}`,
      meta: { source, refId: refId || null, initialStatus }
    });

    return { outcome: 'created', leadId: lead._id };
  } catch (err) {
    logger.error('CRM lead capture failed', { error: err.message, source, refId });
    return { outcome: 'error' };
  }
}

async function captureFromContactInquiry(inquiry) {
  return capture({
    name: inquiry.name,
    email: inquiry.email,
    phone: inquiry.phone,
    company: inquiry.company,
    source: 'website_contact',
    kind: 'ContactInquiry',
    refId: inquiry._id,
    meta: {
      subject: inquiry.subject,
      intent: inquiry.intent,
      messageExcerpt: (inquiry.message || '').slice(0, 300)
    }
  });
}

async function captureFromDemoBooking(inquiry) {
  return capture({
    name: inquiry.name,
    email: inquiry.email,
    phone: inquiry.phone,
    company: inquiry.company,
    source: 'demo_booking',
    kind: 'ContactInquiry',
    refId: inquiry._id,
    meta: {
      demoDate: inquiry.demoDate,
      demoTime: inquiry.demoTime,
      timezone: inquiry.timezone
    },
    // A booked demo is already past the cold stages
    initialStatus: 'demo_scheduled'
  });
}

async function captureFromGrowthAudit(audit) {
  const lead = audit.lead || {};
  return capture({
    name: lead.name,
    email: lead.email,
    phone: lead.phone,
    company: lead.business,
    source: 'growth_audit',
    kind: 'GrowthAudit',
    refId: audit._id,
    meta: {
      auditScore: audit.score,
      auditGrade: audit.grade,
      revenueLeak: audit.modules?.revenueLeak?.number,
      auditId: audit._id
    }
  });
}

function isDemoBooking(inquiry) {
  return inquiry.intent === 'book-demo' || inquiry.source === 'book-demo';
}

/**
 * One-time / re-runnable backfill from historical ContactInquiry and
 * GrowthAudit docs. Idempotent via the captures.refId skip in capture().
 */
async function backfill() {
  const counts = { created: 0, merged: 0, skipped: 0, error: 0 };
  const tally = (result) => {
    counts[result.outcome] = (counts[result.outcome] || 0) + 1;
  };

  const inquiryCursor = ContactInquiry.find().sort({ createdAt: 1 }).lean().cursor();
  for await (const inquiry of inquiryCursor) {
    tally(
      isDemoBooking(inquiry)
        ? await captureFromDemoBooking(inquiry)
        : await captureFromContactInquiry(inquiry)
    );
  }

  const auditCursor = GrowthAudit.find({ leadCaptured: true })
    .sort({ createdAt: 1 })
    .lean()
    .cursor();
  for await (const audit of auditCursor) {
    tally(await captureFromGrowthAudit(audit));
  }

  return counts;
}

module.exports = {
  capture,
  findExisting,
  captureFromContactInquiry,
  captureFromDemoBooking,
  captureFromGrowthAudit,
  backfill
};
