const Contact = require('../models/Contact');
const Interaction = require('../models/Interaction');
const AutomationFlow = require('../models/AutomationFlow');
const KnowledgeBase = require('../models/KnowledgeBase');
const ResponseTemplate = require('../models/ResponseTemplate');
const PlatformConnection = require('../models/PlatformConnection');
const WhatsAppCampaign = require('../models/WhatsAppCampaign');
const Organization = require('../models/Organization');
const logger = require('../config/logger');

/**
 * DemoSeederService — populates a fresh demo workspace with realistic, display-only
 * data so a prospect immediately sees an active product (Inbox, Analytics, Flows,
 * AI/KB, Campaigns).
 *
 * Safety guarantees:
 *  - Every doc is tagged `metadata.seeded = true` so it can be identified/purged.
 *  - Seeding is IDEMPOTENT: re-running on an already-seeded org is a no-op.
 *  - NOTHING here triggers external API calls:
 *      • Interactions/Contacts/Flows/KB/Templates are pure data.
 *      • The demo WhatsApp connection is created `isActive:false, status:'disconnected'`
 *        — every recurring poller filters on `isActive:true, status:'connected'`, so it
 *        is ignored by all background jobs.
 *      • Campaigns are seeded `status:'completed'` (never 'scheduled'/'running'), so
 *        processCampaign (which picks up `status:'scheduled'`) never sends anything.
 *  - Interactions are backdated across the last 30 days so Analytics charts are non-empty.
 */
class DemoSeederService {
  /**
   * Seed all demo data for an organization.
   * @param {import('mongoose').Types.ObjectId|string} organizationId
   * @param {import('mongoose').Types.ObjectId|string} adminUserId  Owner of seeded flows/templates/campaigns.
   * @returns {Promise<{ seeded: boolean, counts?: object }>}
   */
  async seedAll(organizationId, adminUserId) {
    // Idempotency guard: if any seeded interaction exists, assume already seeded.
    const already = await Interaction.exists({ organization: organizationId, 'metadata.seeded': true });
    if (already) {
      logger.info('[DemoSeeder] already seeded, skipping', { orgId: String(organizationId) });
      return { seeded: false };
    }

    try {
      const contacts = await this._seedContactsAndInteractions(organizationId);
      const flows = await this._seedFlows(organizationId, adminUserId);
      const kb = await this._seedKnowledgeBase(organizationId, adminUserId);
      const templates = await this._seedResponseTemplates(organizationId, adminUserId);
      const campaigns = await this._seedCampaign(organizationId, adminUserId);

      await Organization.updateOne(
        { _id: organizationId },
        { $set: { 'demo.seededAt': new Date() } }
      );

      const counts = {
        contacts: contacts.contactCount,
        interactions: contacts.interactionCount,
        flows,
        knowledgeBase: kb,
        responseTemplates: templates,
        campaigns
      };
      logger.info('[DemoSeeder] done', { orgId: String(organizationId), counts });
      return { seeded: true, counts };
    } catch (error) {
      // Seeding is best-effort — a demo workspace is still usable without sample data.
      logger.error('[DemoSeeder] failed (workspace still usable)', { orgId: String(organizationId), error: error.message });
      return { seeded: false, error: error.message };
    }
  }

  /** Backdated date helper: `daysAgo` days before now, at a given hour. */
  _daysAgo(days, hour = 10) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    d.setHours(hour, Math.floor(Math.random() * 59), 0, 0);
    return d;
  }

  /**
   * Seed unified Contacts + their inbound Interactions (DMs/comments/reviews)
   * across the last 30 days, with sentiment/intent set so Analytics looks alive.
   */
  async _seedContactsAndInteractions(organizationId) {
    const samples = [
      { name: 'Aarav Sharma',   platform: 'whatsapp',  type: 'dm',      sentiment: 'positive', intent: 'inquiry',   content: 'Hi! Do you offer same-day delivery in Mumbai?', daysAgo: 1,  hour: 9,  status: 'replied' },
      { name: 'Priya Patel',    platform: 'instagram', type: 'comment', sentiment: 'positive', intent: 'praise',    content: 'Absolutely love the new collection! 😍',        daysAgo: 2,  hour: 14, status: 'replied', postId: 'demo_post_001' },
      { name: 'Rohan Mehta',    platform: 'whatsapp',  type: 'dm',      sentiment: 'neutral',  intent: 'support',   content: 'I need help tracking my order #4521.',          daysAgo: 3,  hour: 11, status: 'resolved' },
      { name: 'Sneha Reddy',    platform: 'facebook',  type: 'comment', sentiment: 'negative', intent: 'complaint', content: 'My package arrived damaged. Very disappointed.', daysAgo: 4,  hour: 16, status: 'assigned', postId: 'demo_post_002' },
      { name: 'Karan Singh',    platform: 'instagram', type: 'dm',      sentiment: 'positive', intent: 'inquiry',   content: 'What sizes are available for the blue jacket?', daysAgo: 6,  hour: 10, status: 'replied' },
      { name: 'Ananya Iyer',    platform: 'google',    type: 'review',  sentiment: 'positive', intent: 'praise',    content: 'Great service and fast support. 5 stars!',      daysAgo: 8,  hour: 13, status: 'read',  rating: 5 },
      { name: 'Vikram Nair',    platform: 'whatsapp',  type: 'dm',      sentiment: 'neutral',  intent: 'inquiry',   content: 'Do you have a loyalty / rewards program?',      daysAgo: 11, hour: 15, status: 'replied' },
      { name: 'Meera Joshi',    platform: 'facebook',  type: 'comment', sentiment: 'positive', intent: 'feedback',  content: 'The new app update is so much smoother!',        daysAgo: 14, hour: 12, status: 'read',  postId: 'demo_post_001' },
      { name: 'Arjun Kapoor',   platform: 'instagram', type: 'comment', sentiment: 'negative', intent: 'complaint', content: 'Been waiting 3 days for a reply on my refund.',  daysAgo: 18, hour: 17, status: 'assigned', postId: 'demo_post_003' },
      { name: 'Divya Menon',    platform: 'google',    type: 'review',  sentiment: 'neutral',  intent: 'feedback',  content: 'Decent products but checkout could be faster.',  daysAgo: 22, hour: 9,  status: 'read',  rating: 3 },
      { name: 'Rahul Verma',    platform: 'whatsapp',  type: 'dm',      sentiment: 'positive', intent: 'inquiry',   content: 'Can I customize an order for a corporate gift?', daysAgo: 26, hour: 14, status: 'replied' },
      { name: 'Ishita Banerjee',platform: 'instagram', type: 'dm',      sentiment: 'positive', intent: 'praise',    content: 'Your team is amazing, thank you so much! 🙏',    daysAgo: 29, hour: 11, status: 'resolved' }
    ];

    let contactCount = 0;
    let interactionCount = 0;
    let idSeq = 0;

    for (const s of samples) {
      const platformUserId = `demo_user_${Date.now()}_${idSeq++}`;
      const when = this._daysAgo(s.daysAgo, s.hour);

      const contact = await Contact.create({
        organization: organizationId,
        primaryName: s.name,
        channels: [{
          platform: s.platform,
          platformUserId,
          name: s.name,
          username: s.name.toLowerCase().replace(/\s+/g, '_')
        }],
        tags: ['demo'],
        aiInsights: { intent: s.intent, sentiment: s.sentiment, priority: s.sentiment === 'negative' ? 'high' : 'medium', updatedAt: when },
        lastInteractionAt: when
      });
      contactCount++;

      const isReplied = ['replied', 'resolved'].includes(s.status);
      await Interaction.create({
        organization: organizationId,
        platform: s.platform,
        type: s.type,
        platformId: `demo_int_${platformUserId}`,
        content: s.content,
        author: { platformId: platformUserId, name: s.name, username: s.name.toLowerCase().replace(/\s+/g, '_') },
        contact: contact._id,
        status: s.status,
        isRead: s.status !== 'unread',
        sentiment: s.sentiment,
        sentimentScore: s.sentiment === 'positive' ? 0.8 : s.sentiment === 'negative' ? -0.7 : 0.05,
        intent: s.intent,
        urgency: s.sentiment === 'negative' ? 'high' : 'medium',
        requiresHumanResponse: s.status === 'assigned',
        engagement: {
          likes: Math.floor(Math.random() * 40),
          views: Math.floor(Math.random() * 500),
          shares: Math.floor(Math.random() * 10)
        },
        replies: isReplied ? [{
          content: 'Thanks for reaching out! Our team is on it. 🙌',
          sentAt: new Date(when.getTime() + 30 * 60 * 1000),
          wasAutoGenerated: false,
          status: 'sent'
        }] : [],
        responseCount: isReplied ? 1 : 0,
        hasReplies: isReplied,
        firstResponseTime: isReplied ? 30 * 60 * 1000 : undefined,
        platformCreatedAt: when,
        metadata: {
          seeded: true,
          ...(s.postId ? { postId: s.postId, postUrl: `https://example.com/${s.postId}` } : {}),
          ...(s.rating ? { rating: s.rating } : {})
        },
        createdAt: when
      });
      interactionCount++;
    }

    return { contactCount, interactionCount };
  }

  /** Seed two ready-to-show automation flows (a welcome flow + an FAQ auto-reply). */
  async _seedFlows(organizationId, adminUserId) {
    // Node types + config keys mirror config/flowNodeCatalog.js exactly so the
    // flow builder renders these seeded flows without "unknown node" errors.
    const flows = [
      {
        name: 'Welcome New Customer',
        description: 'Greets first-time WhatsApp contacts and offers quick options.',
        channels: ['whatsapp'],
        nodes: [
          { id: 'n1', type: 'trigger.keyword', label: 'On "hi/hello"', position: { x: 80, y: 80 }, config: { keywords: ['hi', 'hello', 'hey'] } },
          { id: 'n2', type: 'action.send_text', label: 'Welcome message', position: { x: 80, y: 220 }, config: { text: 'Welcome to our store! 👋 How can we help you today?' } },
          { id: 'n3', type: 'action.send_buttons', label: 'Quick options', position: { x: 80, y: 360 }, config: { bodyText: 'What would you like to do?', buttons: [{ id: 'track', title: 'Track Order' }, { id: 'browse', title: 'Browse Products' }, { id: 'support', title: 'Talk to Support' }] } }
        ],
        edges: [
          { id: 'e1', source: 'n1', target: 'n2' },
          { id: 'e2', source: 'n2', target: 'n3' }
        ],
        entryNodeId: 'n1'
      },
      {
        name: 'FAQ Auto-Reply (AI)',
        description: 'Answers common questions using the knowledge base, escalates if unsure.',
        channels: ['whatsapp', 'instagram'],
        nodes: [
          { id: 'm1', type: 'trigger.first_message', label: 'On first message', position: { x: 80, y: 80 }, config: {} },
          { id: 'm2', type: 'action.ai_reply', label: 'AI answer from KB', position: { x: 80, y: 220 }, config: { tone: 'friendly' } },
          { id: 'm3', type: 'control.end', label: 'End', position: { x: 80, y: 360 }, config: {} }
        ],
        edges: [
          { id: 'em1', source: 'm1', target: 'm2' },
          { id: 'em2', source: 'm2', target: 'm3' }
        ],
        entryNodeId: 'm1'
      }
    ];

    let count = 0;
    for (const f of flows) {
      await AutomationFlow.create({
        organization: organizationId,
        createdBy: adminUserId,
        name: f.name,
        description: f.description,
        channels: f.channels,
        status: 'active',
        entryNodeId: f.entryNodeId,
        nodes: f.nodes,
        edges: f.edges,
        stats: { triggered: Math.floor(Math.random() * 50) + 10, completed: Math.floor(Math.random() * 30) + 5, converted: Math.floor(Math.random() * 10), failed: 0 },
        seeded: true
      });
      count++;
    }
    return count;
  }

  /** Seed knowledge base entries so AI replies have material to draw from. */
  async _seedKnowledgeBase(organizationId, adminUserId) {
    const entries = [
      { type: 'faq',          category: 'Shipping',  title: 'Shipping & Delivery',  content: 'We offer free standard shipping (3–5 business days) on all orders above ₹999. Same-day delivery is available in Mumbai, Delhi, and Bangalore for orders placed before 12 PM.' },
      { type: 'policy',       category: 'Returns',   title: 'Returns & Refunds',    content: 'Items can be returned within 14 days of delivery in original condition. Refunds are processed to the original payment method within 5–7 business days of receiving the return.' },
      { type: 'product_info', category: 'Products',  title: 'Product Care',         content: 'All apparel is machine-washable on a gentle cycle. We recommend air-drying to preserve fabric quality. Detailed care labels are included with every item.' },
      { type: 'faq',          category: 'Support',   title: 'Order Tracking',       content: 'You can track your order using the tracking link sent via WhatsApp and email after dispatch, or by sharing your order number with our support team.' }
    ];

    let count = 0;
    for (const e of entries) {
      await KnowledgeBase.create({
        organization: organizationId,
        createdBy: adminUserId,
        source: 'manual',
        type: e.type,
        category: e.category,
        title: e.title,
        content: e.content,
        tags: ['demo'],
        keywords: e.title.toLowerCase().split(/\s+/),
        priority: 5,
        isActive: true,
        metadata: { seeded: true }
      });
      count++;
    }
    return count;
  }

  /** Seed quick-reply response templates for the inbox. */
  async _seedResponseTemplates(organizationId, adminUserId) {
    const templates = [
      { name: 'Greeting',        category: 'general',  content: 'Hi {{name}}! Thanks for reaching out. How can we help you today?' },
      { name: 'Order Status',    category: 'support',  content: 'Hi {{name}}, your order is on the way and should arrive within 2–3 business days. 📦' },
      { name: 'Apology + Resolve', category: 'support', content: 'We’re really sorry for the inconvenience, {{name}}. We’ve escalated this and will resolve it within 24 hours.' }
    ];

    let count = 0;
    for (const t of templates) {
      await ResponseTemplate.create({
        organization: organizationId,
        createdBy: adminUserId,
        name: t.name,
        category: t.category,
        content: t.content,
        isActive: true,
        seeded: true
      });
      count++;
    }
    return count;
  }

  /**
   * Seed one COMPLETED WhatsApp campaign for display (no sending).
   * Requires a connection ref → we create a display-only demo connection that is
   * isActive:false/status:'disconnected', so no background job ever uses it.
   */
  async _seedCampaign(organizationId, adminUserId) {
    let demoConnection;
    try {
      demoConnection = await PlatformConnection.create({
        organization: organizationId,
        platform: 'whatsapp',
        platformUserId: `demo_wa_${Date.now()}`,
        accessToken: 'demo-disabled-token',   // never used: connection is disconnected
        isActive: false,
        status: 'disconnected',
        createdBy: adminUserId,
        seeded: true
      });
    } catch (err) {
      logger.warn('[DemoSeeder] demo connection create failed, skipping campaign', { error: err.message });
      return 0;
    }

    const finishedAt = this._daysAgo(5, 12);
    await WhatsAppCampaign.create({
      organization: organizationId,
      connection: demoConnection._id,
      createdBy: adminUserId,
      name: 'Diwali Festive Offer 🎇',
      templateSnapshot: {
        name: 'festive_offer',
        languageCode: 'en',
        parameterFormat: 'POSITIONAL',
        components: []
      },
      status: 'completed',                    // never 'scheduled' → worker won't send
      scheduledAt: null,
      startedAt: this._daysAgo(5, 11),
      finishedAt,
      stats: { total: 250, sent: 244, failed: 6, pending: 0 },
      seeded: true
    });
    return 1;
  }
}

module.exports = new DemoSeederService();
