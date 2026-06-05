/**
 * Canonical node catalog for the unified Flow Builder.
 * Backend source of truth — frontend mirrors via GET /automation/flows/node-catalog
 */

const CHANNELS = ['whatsapp', 'instagram', 'facebook'];

const DEFAULT_PURCHASE_KEYWORDS = [
  'price', 'buy', 'cost', 'order', 'purchase', 'how much', 'interested', 'want this', 'where to buy', 'link'
];
const DEFAULT_WA_KEYWORDS = ['book', 'price', 'help', 'appointment', 'schedule'];
const DEFAULT_PUBLIC_REPLY = "Hi {{username}}! 👋 We've sent you the details in DM. 😊";
const DEFAULT_DM_TEMPLATE =
  'Hi {{username}}! 👋 Thanks for your interest.\n\n🛍️ *{{product_name}}*\n💵 Price: {{currency}} {{price}}\n📦 Sizes: {{sizes}}\n\n👉 Order here: {{payment_url}}\n\nFeel free to DM us if you have questions! 😊';
const DEFAULT_SEND_TEXT = 'Hi {{username}}! How can we help you today?';
const DEFAULT_GENERIC_TEMPLATE = {
  title: 'Thanks for your comment!',
  subtitle: 'Tap below to follow us for more updates.',
  imageUrl: '',
  buttons: [{ label: 'Follow us', type: 'web_url', url: '' }]
};
const DEFAULT_SALES_BUTTONS = [
  { label: 'Product Details', type: 'postback', payload: 'details' },
  { label: 'Pay Now', type: 'postback', payload: 'payment' },
  { label: 'Maybe later', type: 'postback', payload: 'hesitant' }
];

function node(type, category, label, channels, configSchema = {}) {
  const fields = (configSchema.fields || []).map((f) => {
    const defaultConfig = configSchema.defaultConfig || {};
    if (f.default !== undefined || defaultConfig[f.key] === undefined) return f;
    return { ...f, default: defaultConfig[f.key] };
  });

  return {
    type,
    category,
    label,
    icon: configSchema.icon || 'fas fa-circle',
    description: configSchema.description || '',
    supportedChannels: channels,
    configFields: fields,
    defaultConfig: configSchema.defaultConfig || {}
  };
}

const FLOW_NODE_CATALOG = [
  // ── Triggers ──────────────────────────────────────────────────────────────
  node('trigger.keyword', 'trigger', 'Keyword match', ['whatsapp', 'facebook'], {
    icon: 'fas fa-key',
    description: 'Starts when an inbound message contains configured keywords.',
    defaultConfig: { keywords: DEFAULT_WA_KEYWORDS },
    fields: [{
      key: 'keywords', type: 'string[]', label: 'Keywords', required: true,
      hint: 'One keyword per line. Case-insensitive partial match.',
      default: DEFAULT_WA_KEYWORDS
    }]
  }),
  node('trigger.first_message', 'trigger', 'First message', ['whatsapp'], {
    icon: 'fas fa-comment-dots',
    description: 'First inbound WhatsApp message from a contact.',
    defaultConfig: {},
    fields: []
  }),
  node('trigger.new_lead', 'trigger', 'New lead', ['whatsapp', 'instagram'], {
    icon: 'fas fa-user-plus',
    description: 'When a new lead is captured.',
    defaultConfig: {},
    fields: []
  }),
  node('trigger.order_event', 'trigger', 'Order event', ['whatsapp'], {
    icon: 'fas fa-shopping-bag',
    description: 'Commerce order lifecycle event.',
    defaultConfig: { event: 'delivered' },
    fields: [{
      key: 'event', type: 'select', label: 'Event', options: ['created', 'delivered', 'paid'],
      default: 'delivered'
    }]
  }),
  node('trigger.webhook', 'trigger', 'Webhook', CHANNELS, {
    icon: 'fas fa-plug',
    description: 'External webhook payload.',
    defaultConfig: { secret: '' },
    fields: [{ key: 'secret', type: 'string', label: 'Webhook secret', hint: 'Leave empty until you configure your webhook endpoint.', default: '' }]
  }),
  node('trigger.ig_comment', 'trigger', 'Instagram comment', ['instagram'], {
    icon: 'fab fa-instagram',
    description: 'New comment on a linked post.',
    defaultConfig: { keywords: DEFAULT_PURCHASE_KEYWORDS },
    fields: [{
      key: 'keywords', type: 'string[]', label: 'Trigger keywords',
      hint: 'Leave empty to match all comments, or add purchase-intent keywords.',
      default: DEFAULT_PURCHASE_KEYWORDS
    }]
  }),
  node('trigger.ig_story_reply', 'trigger', 'Story reply', ['instagram'], {
    icon: 'fas fa-book-open',
    description: 'User replies to your Instagram story.',
    defaultConfig: { keywords: [] },
    fields: [{
      key: 'keywords', type: 'string[]', label: 'Optional keywords',
      hint: 'Empty = all story replies qualify.',
      default: []
    }]
  }),
  node('trigger.ig_story_mention', 'trigger', 'Story mention', ['instagram'], {
    icon: 'fas fa-at',
    description: 'User mentions you in their story.',
    defaultConfig: {},
    fields: []
  }),
  node('trigger.ig_dm', 'trigger', 'Instagram DM', ['instagram'], {
    icon: 'fas fa-envelope',
    description: 'Inbound Instagram direct message.',
    defaultConfig: {},
    fields: []
  }),
  node('trigger.ig_postback', 'trigger', 'Postback click', ['instagram'], {
    icon: 'fas fa-hand-pointer',
    description: 'User taps a button in a generic template.',
    defaultConfig: { payload: 'details' },
    fields: [{ key: 'payload', type: 'string', label: 'Expected payload', default: 'details' }]
  }),
  node('trigger.manual', 'trigger', 'Manual enroll', CHANNELS, {
    icon: 'fas fa-play',
    description: 'Agent or API manually starts the flow.',
    defaultConfig: {},
    fields: []
  }),

  // ── Actions ───────────────────────────────────────────────────────────────
  node('action.send_text', 'action', 'Send text', CHANNELS, {
    icon: 'fas fa-comment',
    description: 'Send a plain text message.',
    defaultConfig: { text: DEFAULT_SEND_TEXT },
    fields: [{
      key: 'text', type: 'textarea', label: 'Message', required: true,
      hint: 'Supports {{username}}, {{product_name}}, {{price}}, {{payment_url}}',
      default: DEFAULT_SEND_TEXT
    }]
  }),
  node('action.send_template', 'action', 'Send WA template', ['whatsapp'], {
    icon: 'fab fa-whatsapp',
    description: 'Send an approved WhatsApp template.',
    defaultConfig: { templateId: '', templateName: '', templateLanguage: '', variables: {} },
    fields: [
      { key: 'templateId', type: 'template', label: 'Template', required: true, default: '', hint: 'Choose an approved WhatsApp template from your connected account.' },
      { key: 'variables', type: 'json', label: 'Variables', hint: 'JSON object of template variable values.', default: {} }
    ]
  }),
  node('action.send_generic_template', 'action', 'Send IG template', ['instagram'], {
    icon: 'fab fa-instagram',
    description: 'Send Instagram generic template card.',
    defaultConfig: { ...DEFAULT_GENERIC_TEMPLATE },
    fields: [
      { key: 'title', type: 'string', label: 'Title', default: DEFAULT_GENERIC_TEMPLATE.title },
      { key: 'subtitle', type: 'string', label: 'Subtitle', default: DEFAULT_GENERIC_TEMPLATE.subtitle },
      { key: 'imageUrl', type: 'string', label: 'Image URL', hint: 'Must be https://', default: '' },
      { key: 'buttons', type: 'json', label: 'Buttons', hint: 'JSON array of button objects.', default: DEFAULT_GENERIC_TEMPLATE.buttons }
    ]
  }),
  node('action.send_catalog_product', 'action', 'Send catalog product', ['whatsapp'], {
    icon: 'fas fa-store',
    description: 'Send a WhatsApp catalog product message.',
    defaultConfig: { productId: '' },
    fields: [{ key: 'productId', type: 'product', label: 'Product', required: true, default: '' }]
  }),
  node('action.reply_public_comment', 'action', 'Reply public comment', ['instagram'], {
    icon: 'fas fa-reply',
    description: 'Post a public comment reply stub.',
    defaultConfig: { text: DEFAULT_PUBLIC_REPLY },
    fields: [{
      key: 'text', type: 'textarea', label: 'Reply text', required: true,
      hint: 'Supports {{username}}. Never include payment links here.',
      default: DEFAULT_PUBLIC_REPLY
    }]
  }),
  node('action.ai_reply', 'action', 'AI reply', CHANNELS, {
    icon: 'fas fa-robot',
    description: 'Generate and send an AI reply.',
    defaultConfig: { tone: 'friendly' },
    fields: [{
      key: 'tone', type: 'select', label: 'Tone', options: ['professional', 'friendly', 'casual'],
      default: 'friendly'
    }]
  }),
  node('action.assign_bucket', 'action', 'Assign intent bucket', CHANNELS, {
    icon: 'fas fa-inbox',
    description: 'Route conversation to an intent bucket.',
    defaultConfig: { bucketId: '' },
    fields: [{ key: 'bucketId', type: 'bucket', label: 'Bucket', required: true, default: '' }]
  }),
  node('action.escalate_human', 'action', 'Escalate to human', CHANNELS, {
    icon: 'fas fa-user-headset',
    description: 'Hand off to a human agent.',
    defaultConfig: { reason: 'Needs human review' },
    fields: [{ key: 'reason', type: 'string', label: 'Reason', default: 'Needs human review' }]
  }),
  node('action.set_variable', 'action', 'Set variable', CHANNELS, {
    icon: 'fas fa-code',
    description: 'Store a value in flow context.',
    defaultConfig: { key: 'step', value: '1' },
    fields: [
      { key: 'key', type: 'string', label: 'Variable name', required: true, default: 'step' },
      { key: 'value', type: 'string', label: 'Value', required: true, default: '1' }
    ]
  }),
  node('action.set_stage', 'action', 'Set sales stage', ['instagram'], {
    icon: 'fas fa-flag',
    description: 'Update sales conversation stage.',
    defaultConfig: { stage: 'interested' },
    fields: [{ key: 'stage', type: 'string', label: 'Stage', required: true, default: 'interested' }]
  }),
  node('action.create_order', 'action', 'Create order', ['instagram', 'whatsapp'], {
    icon: 'fas fa-receipt',
    description: 'Create a product order record.',
    defaultConfig: { productId: '' },
    fields: [{ key: 'productId', type: 'product', label: 'Product', default: '' }]
  }),
  node('action.link_comment_thread', 'action', 'Link comment thread', ['instagram'], {
    icon: 'fas fa-link',
    description: 'Link comment interaction to DM thread.',
    defaultConfig: {},
    fields: []
  }),
  node('action.tag_contact', 'action', 'Tag contact', CHANNELS, {
    icon: 'fas fa-tag',
    description: 'Add tag to contact profile.',
    defaultConfig: { tag: 'flow-lead' },
    fields: [{ key: 'tag', type: 'string', label: 'Tag', required: true, default: 'flow-lead' }]
  }),
  node('action.webhook_out', 'action', 'Webhook out', CHANNELS, {
    icon: 'fas fa-arrow-up-right-from-square',
    description: 'POST flow context to external URL.',
    defaultConfig: { url: '', method: 'POST' },
    fields: [
      { key: 'url', type: 'string', label: 'URL', required: true, default: '' },
      { key: 'method', type: 'select', label: 'Method', options: ['POST', 'PUT'], default: 'POST' }
    ]
  }),
  node('action.http_request', 'action', 'HTTP request', CHANNELS, {
    icon: 'fas fa-globe',
    description: 'Call an external API and save the response into a flow variable.',
    defaultConfig: { url: '', method: 'GET', headers: {}, body: {}, saveAs: 'apiResult' },
    fields: [
      { key: 'url', type: 'string', label: 'URL', required: true, default: '', hint: 'https:// endpoint to call.' },
      { key: 'method', type: 'select', label: 'Method', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'GET' },
      { key: 'headers', type: 'json', label: 'Headers', hint: 'JSON object of request headers.', default: {} },
      { key: 'body', type: 'json', label: 'Body', hint: 'JSON request body (ignored for GET).', default: {} },
      { key: 'saveAs', type: 'string', label: 'Save response as', hint: 'Variable name to store the response data.', default: 'apiResult' }
    ]
  }),

  // ── Conditions ────────────────────────────────────────────────────────────
  node('condition.keyword_match', 'condition', 'Keyword match', CHANNELS, {
    icon: 'fas fa-filter',
    defaultConfig: { keywords: DEFAULT_PURCHASE_KEYWORDS },
    fields: [{
      key: 'keywords', type: 'string[]', label: 'Keywords', required: true,
      default: DEFAULT_PURCHASE_KEYWORDS
    }]
  }),
  node('condition.reply_contains', 'condition', 'Reply contains', CHANNELS, {
    icon: 'fas fa-search',
    defaultConfig: { text: 'yes' },
    fields: [{ key: 'text', type: 'string', label: 'Contains text', required: true, default: 'yes' }]
  }),
  node('condition.button_clicked', 'condition', 'Button clicked', CHANNELS, {
    icon: 'fas fa-hand-pointer',
    defaultConfig: { payload: 'details' },
    fields: [{ key: 'payload', type: 'string', label: 'Button payload', default: 'details' }]
  }),
  node('condition.product_count', 'condition', 'Product count', ['instagram', 'whatsapp'], {
    icon: 'fas fa-boxes-stacked',
    defaultConfig: { operator: 'eq', count: 1 },
    fields: [
      { key: 'operator', type: 'select', label: 'Operator', options: ['eq', 'gt', 'lt'], default: 'eq' },
      { key: 'count', type: 'number', label: 'Count', default: 1 }
    ]
  }),
  node('condition.intent_bucket', 'condition', 'Intent bucket', CHANNELS, {
    icon: 'fas fa-layer-group',
    defaultConfig: { bucketId: '' },
    fields: [{ key: 'bucketId', type: 'bucket', label: 'Bucket', default: '' }]
  }),
  node('condition.sentiment', 'condition', 'Sentiment', CHANNELS, {
    icon: 'fas fa-face-smile',
    defaultConfig: { sentiment: 'negative' },
    fields: [{
      key: 'sentiment', type: 'select', label: 'Sentiment',
      options: ['positive', 'neutral', 'negative'], default: 'negative'
    }]
  }),
  node('condition.feature_enabled', 'condition', 'Feature enabled', CHANNELS, {
    icon: 'fas fa-toggle-on',
    defaultConfig: { feature: 'auto_reply' },
    fields: [{ key: 'feature', type: 'string', label: 'Feature key', default: 'auto_reply' }]
  }),
  node('condition.dedup_rate_limit', 'condition', 'Dedup / rate limit', CHANNELS, {
    icon: 'fas fa-shield-halved',
    defaultConfig: { maxPerDay: 200 },
    fields: [{ key: 'maxPerDay', type: 'number', label: 'Max per day', default: 200 }]
  }),
  node('condition.variable', 'condition', 'Variable check', CHANNELS, {
    icon: 'fas fa-equals',
    defaultConfig: { key: 'step', operator: 'eq', value: '1' },
    fields: [
      { key: 'key', type: 'string', label: 'Variable', default: 'step' },
      { key: 'operator', type: 'select', label: 'Operator', options: ['eq', 'neq', 'contains'], default: 'eq' },
      { key: 'value', type: 'string', label: 'Value', default: '1' }
    ]
  }),
  node('condition.business_hours', 'condition', 'Business hours', CHANNELS, {
    icon: 'fas fa-business-time',
    description: 'Branch on whether the current time is within your business hours.',
    defaultConfig: { start: '09:00', end: '18:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'], timezone: 'Asia/Kolkata' },
    fields: [
      { key: 'start', type: 'string', label: 'Open time', hint: '24h HH:mm, e.g. 09:00', default: '09:00' },
      { key: 'end', type: 'string', label: 'Close time', hint: '24h HH:mm, e.g. 18:00', default: '18:00' },
      { key: 'days', type: 'string[]', label: 'Open days', hint: 'mon, tue, wed, thu, fri, sat, sun', default: ['mon', 'tue', 'wed', 'thu', 'fri'] },
      { key: 'timezone', type: 'string', label: 'Timezone', default: 'Asia/Kolkata' }
    ]
  }),

  // ── Wait / control ────────────────────────────────────────────────────────
  node('wait.delay', 'wait', 'Fixed delay', CHANNELS, {
    icon: 'fas fa-clock',
    defaultConfig: { delaySec: 3600 },
    fields: [{ key: 'delaySec', type: 'number', label: 'Delay (seconds)', required: true, default: 3600 }]
  }),
  node('wait.human_delay', 'wait', 'Human-like delay', CHANNELS, {
    icon: 'fas fa-hourglass-half',
    defaultConfig: { minSec: 30, maxSec: 120 },
    fields: [
      { key: 'minSec', type: 'number', label: 'Min seconds', default: 30 },
      { key: 'maxSec', type: 'number', label: 'Max seconds', default: 120 }
    ]
  }),
  node('wait.quiet_hours', 'wait', 'Quiet hours', CHANNELS, {
    icon: 'fas fa-moon',
    defaultConfig: {},
    fields: []
  }),
  node('wait.user_reply', 'wait', 'Wait for reply', CHANNELS, {
    icon: 'fas fa-reply',
    defaultConfig: { timeoutSec: 86400 },
    fields: [{
      key: 'timeoutSec', type: 'number', label: 'Timeout (seconds)',
      hint: 'Use a no_reply edge for timeout branch.', default: 86400
    }]
  }),
  node('control.end', 'control', 'End flow', CHANNELS, {
    icon: 'fas fa-stop-circle',
    defaultConfig: {},
    fields: []
  }),
  node('control.jump', 'control', 'Jump to node', CHANNELS, {
    icon: 'fas fa-share',
    defaultConfig: { targetNodeId: '' },
    fields: [{ key: 'targetNodeId', type: 'node', label: 'Target node', required: true, default: '' }]
  }),
  node('control.ab_split', 'control', 'A/B split', CHANNELS, {
    icon: 'fas fa-code-branch',
    description: 'Randomly send contacts down branch A or B by percentage. Label the two outgoing connections "A" and "B".',
    defaultConfig: { splitPercent: 50 },
    fields: [{
      key: 'splitPercent', type: 'number', label: '% to branch A', required: true, default: 50,
      hint: 'Probability (0–100) of taking the "A" branch; the rest go to "B".'
    }]
  }),
  node('control.random_branch', 'control', 'Random branch', CHANNELS, {
    icon: 'fas fa-shuffle',
    description: 'Pick one outgoing connection at random (useful for spreading message variants).',
    defaultConfig: {},
    fields: []
  })
];

const TRIGGER_TYPES = FLOW_NODE_CATALOG.filter((n) => n.category === 'trigger').map((n) => n.type);

function getStaticDefaultConfig(type) {
  const def = FLOW_NODE_CATALOG.find((n) => n.type === type);
  return def?.defaultConfig ? { ...def.defaultConfig } : {};
}

function getNodeCatalog(filters = {}) {
  let items = FLOW_NODE_CATALOG;
  if (filters.channels?.length) {
    const ch = filters.channels.map((c) => String(c).toLowerCase());
    items = items.filter((n) => n.supportedChannels.some((c) => ch.includes(c)));
  }
  if (filters.category) {
    items = items.filter((n) => n.category === filters.category);
  }
  return items.map((item) => ({ ...item, defaultConfig: { ...item.defaultConfig } }));
}

function getNodeDef(type) {
  const def = FLOW_NODE_CATALOG.find((n) => n.type === type);
  if (!def) return null;
  return { ...def, defaultConfig: { ...def.defaultConfig } };
}

function isTriggerType(type) {
  return TRIGGER_TYPES.includes(type);
}

module.exports = {
  FLOW_NODE_CATALOG,
  TRIGGER_TYPES,
  DEFAULT_PURCHASE_KEYWORDS,
  DEFAULT_SALES_BUTTONS,
  getNodeCatalog,
  getNodeDef,
  getStaticDefaultConfig,
  isTriggerType
};
