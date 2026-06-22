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

// ── WhatsApp interactive defaults ────────────────────────────────────────────
const DEFAULT_WA_REPLY_BUTTONS = [
  { id: 'yes', title: 'Yes' },
  { id: 'no', title: 'No' }
];
const DEFAULT_WA_LIST_SECTIONS = [
  {
    title: 'Options',
    rows: [
      { id: 'option_1', title: 'Option 1', description: '' }
    ]
  }
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

  // ── WhatsApp interactive messages (Meta Cloud API) ─────────────────────────
  node('action.send_media', 'action', 'Send media', ['whatsapp'], {
    icon: 'fas fa-photo-film',
    description: 'Send an image, video, audio, document, or sticker by public URL.',
    defaultConfig: { mediaType: 'image', mediaUrl: '', caption: '', filename: '' },
    fields: [
      {
        key: 'mediaType', type: 'select', label: 'Media type', required: true,
        options: ['image', 'video', 'audio', 'document', 'sticker'], default: 'image'
      },
      {
        key: 'mediaUrl', type: 'media_url', label: 'Media file', required: true, default: '',
        hint: 'Pick from your media library or upload a new file. Must be publicly accessible.'
      },
      {
        key: 'caption', type: 'textarea', label: 'Caption', default: '',
        hint: 'Optional. Shown with image / video / document only. Max 1024 chars.'
      },
      {
        key: 'filename', type: 'string', label: 'Document filename', default: '',
        hint: 'Customer-visible filename (documents only), e.g. invoice.pdf'
      }
    ]
  }),
  node('action.send_location', 'action', 'Send location', ['whatsapp'], {
    icon: 'fas fa-location-dot',
    description: 'Send a pinned location with optional name and address.',
    defaultConfig: { latitude: '', longitude: '', name: '', address: '' },
    fields: [
      { key: 'latitude', type: 'string', label: 'Latitude', required: true, default: '', hint: 'Decimal degrees, e.g. 19.0760' },
      { key: 'longitude', type: 'string', label: 'Longitude', required: true, default: '', hint: 'Decimal degrees, e.g. 72.8777' },
      { key: 'name', type: 'string', label: 'Location name', default: '', hint: 'Optional label, e.g. Our Store' },
      { key: 'address', type: 'textarea', label: 'Address', default: '', hint: 'Optional full address shown under the name.' }
    ]
  }),
  node('action.send_buttons', 'action', 'Send reply buttons', ['whatsapp'], {
    icon: 'fas fa-square-check',
    description: 'Interactive message with up to 3 quick-reply buttons.',
    defaultConfig: {
      bodyText: 'How can we help you today?',
      headerText: '',
      footerText: '',
      buttons: DEFAULT_WA_REPLY_BUTTONS
    },
    fields: [
      { key: 'bodyText', type: 'textarea', label: 'Body', required: true, default: 'How can we help you today?', hint: 'Main message text. Max 1024 chars.' },
      { key: 'headerText', type: 'string', label: 'Header', default: '', hint: 'Optional bold header. Max 60 chars.' },
      { key: 'footerText', type: 'string', label: 'Footer', default: '', hint: 'Optional footer. Max 60 chars.' },
      {
        key: 'buttons', type: 'reply_buttons', label: 'Buttons', required: true,
        default: DEFAULT_WA_REPLY_BUTTONS,
        hint: 'Up to 3 buttons. Each title max 20 chars. Tapping a button can drive the matching outgoing connection (label it with the button id).'
      }
    ]
  }),
  node('action.send_list', 'action', 'Send list message', ['whatsapp'], {
    icon: 'fas fa-list-ul',
    description: 'Interactive list menu with sections and selectable rows.',
    defaultConfig: {
      bodyText: 'Choose an option:',
      buttonText: 'View options',
      headerText: '',
      footerText: '',
      sections: DEFAULT_WA_LIST_SECTIONS
    },
    fields: [
      { key: 'bodyText', type: 'textarea', label: 'Body', required: true, default: 'Choose an option:', hint: 'Main message text. Max 4096 chars.' },
      { key: 'buttonText', type: 'string', label: 'List button text', required: true, default: 'View options', hint: 'Label that opens the list. Max 20 chars.' },
      { key: 'headerText', type: 'string', label: 'Header', default: '', hint: 'Optional header. Max 60 chars.' },
      { key: 'footerText', type: 'string', label: 'Footer', default: '', hint: 'Optional footer. Max 60 chars.' },
      {
        key: 'sections', type: 'list_sections', label: 'Sections', required: true,
        default: DEFAULT_WA_LIST_SECTIONS,
        hint: 'Up to 10 rows total across all sections. Row title max 24 chars, description max 72 chars.'
      }
    ]
  }),
  node('action.send_product', 'action', 'Send single product', ['whatsapp'], {
    icon: 'fas fa-box',
    description: 'Send one catalog product as an interactive product card.',
    defaultConfig: { productId: '', bodyText: '' },
    fields: [
      { key: 'productId', type: 'product', label: 'Product', required: true, default: '' },
      { key: 'bodyText', type: 'textarea', label: 'Message', default: '', hint: 'Optional text shown above the product card. Max 1024 chars.' }
    ]
  }),
  node('action.send_product_list', 'action', 'Send multi-product', ['whatsapp'], {
    icon: 'fas fa-boxes-stacked',
    description: 'Send a catalog product list (multi-product) message grouped into sections.',
    defaultConfig: {
      headerText: 'Our products',
      bodyText: 'Browse our catalog and tap to add items.',
      footerText: '',
      productSections: [{ title: 'Featured', productIds: [] }]
    },
    fields: [
      { key: 'headerText', type: 'string', label: 'Header', required: true, default: 'Our products', hint: 'Required for product lists. Max 60 chars.' },
      { key: 'bodyText', type: 'textarea', label: 'Body', required: true, default: 'Browse our catalog and tap to add items.', hint: 'Main message text. Max 1024 chars.' },
      { key: 'footerText', type: 'string', label: 'Footer', default: '', hint: 'Optional footer. Max 60 chars.' },
      {
        key: 'productSections', type: 'product_sections', label: 'Product sections', required: true,
        default: [{ title: 'Featured', productIds: [] }],
        hint: 'Up to 30 products total across all sections. Each section needs a title.'
      }
    ]
  }),
  node('action.send_catalog', 'action', 'Send full catalog', ['whatsapp'], {
    icon: 'fas fa-store',
    description: 'Send your entire linked WhatsApp catalog as a "View catalog" message.',
    defaultConfig: { bodyText: 'Browse our full catalog 🛍️', footerText: '', thumbnailProductId: '' },
    fields: [
      { key: 'bodyText', type: 'textarea', label: 'Body', required: true, default: 'Browse our full catalog 🛍️', hint: 'Main message text shown above the catalog button. Max 1024 chars.' },
      { key: 'footerText', type: 'string', label: 'Footer', default: '', hint: 'Optional footer. Max 60 chars.' },
      { key: 'thumbnailProductId', type: 'product', label: 'Cover product', default: '', hint: 'Optional. The product shown as the catalog cover thumbnail. Defaults to the first catalog item.' }
    ]
  }),
  // ── Appointment booking ────────────────────────────────────────────────────
  node('trigger.appointment_event', 'trigger', 'Appointment event', ['whatsapp', 'instagram'], {
    icon: 'fas fa-calendar-check',
    description: 'Fires on an appointment lifecycle event (booked / reminder / cancelled). Use for confirmations & reminders.',
    defaultConfig: { event: 'reminder' },
    fields: [{
      key: 'event', type: 'select', label: 'Event', options: ['booked', 'reminder', 'cancelled'], default: 'reminder'
    }]
  }),
  node('action.offer_services', 'action', 'Ask which service', ['whatsapp', 'instagram'], {
    icon: 'fas fa-list-ul',
    description: "List ALL your services and ask the customer to pick one — so a single flow handles every service. Follow with 'Wait for reply' → 'Offer appointment slots' (leave its Service empty).",
    defaultConfig: { bodyText: 'Which service would you like to book?', noServicesText: '' },
    fields: [
      { key: 'bodyText', type: 'textarea', label: 'Question text', default: 'Which service would you like to book?', hint: 'Shown above the numbered service list.' },
      { key: 'noServicesText', type: 'textarea', label: 'No-services text', default: '', hint: 'Sent when no services are available.' }
    ]
  }),
  node('action.offer_slots', 'action', 'Offer appointment slots', ['whatsapp', 'instagram'], {
    icon: 'fas fa-clock',
    description: "DM the customer the next available slots for a service. Pair with a 'Wait for reply' + 'Book appointment'. Leave Service empty to use the one the customer picked in 'Ask which service'.",
    defaultConfig: { serviceId: '', providerId: '', bodyText: '', maxSlots: 6, days: 7 },
    fields: [
      { key: 'serviceId', type: 'service', label: 'Service', default: '', hint: 'Leave empty for a multi-service flow (uses the service picked in "Ask which service"). Set it to lock this flow to one service.' },
      { key: 'providerId', type: 'provider', label: 'Provider', default: '', hint: 'Optional — leave empty to offer any available provider.' },
      { key: 'maxSlots', type: 'number', label: 'Max slots', default: 6, hint: 'How many slots to list (1–10).' },
      { key: 'days', type: 'number', label: 'Days ahead', default: 7, hint: 'How far ahead to search for slots.' },
      { key: 'bodyText', type: 'textarea', label: 'Intro text', default: '', hint: 'Shown above the numbered slot list.' },
      { key: 'noSlotsText', type: 'textarea', label: 'No-slots text', default: '', hint: 'Sent when nothing is available.' }
    ]
  }),
  node('action.book_appointment', 'action', 'Book appointment', ['whatsapp', 'instagram'], {
    icon: 'fas fa-calendar-plus',
    description: "Book the slot the customer picked from 'Offer slots' (reads their numbered reply). Records it in Appointment Management. Branches: booked / failed.",
    defaultConfig: { confirmMode: 'auto', serviceId: '' },
    fields: [
      { key: 'confirmMode', type: 'select', label: 'Confirmation', options: ['auto', 'manual'], default: 'auto', hint: '“auto” confirms instantly; “manual” marks it Requested for staff to confirm.' },
      { key: 'serviceId', type: 'service', label: 'Service (fallback)', default: '', hint: 'Optional — used only if no service was captured by Offer slots.' }
    ]
  }),
  node('action.reschedule_appointment', 'action', 'Reschedule appointment', ['whatsapp', 'instagram'], {
    icon: 'fas fa-calendar-day',
    description: "Move the customer's active appointment to the slot they picked from 'Offer slots'. Branches: done / failed / none.",
    defaultConfig: {},
    fields: []
  }),
  node('action.cancel_appointment', 'action', 'Cancel appointment', ['whatsapp', 'instagram'], {
    icon: 'fas fa-calendar-xmark',
    description: "Cancel the customer's active appointment on this conversation. Branches: done / none.",
    defaultConfig: { reason: 'Cancelled by customer' },
    fields: [
      { key: 'reason', type: 'string', label: 'Cancellation reason', default: 'Cancelled by customer' }
    ]
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
  node('action.send_post_products', 'action', "Send post's products", ['instagram'], {
    icon: 'fas fa-box-open',
    description: "DM the commenter the product(s) linked to this post — one product sends its detail/CTA, multiple send a carousel. Auto-resolves from the post; no setup needed. Use after an Instagram comment trigger.",
    defaultConfig: {},
    fields: []
  }),
  node('action.ai_reply', 'action', 'AI reply', CHANNELS, {
    icon: 'fas fa-robot',
    description: 'Generate and send a Reppy reply.',
    defaultConfig: { tone: 'friendly' },
    fields: [{
      key: 'tone', type: 'select', label: 'Tone', options: ['professional', 'friendly', 'casual'],
      default: 'friendly'
    }]
  }),
  node('action.ai_detect_intent', 'action', 'AI detect intent', CHANNELS, {
    icon: 'fas fa-wand-magic-sparkles',
    description: 'Classify the customer message into an intent and save it to a flow variable. Branch on it with a "Variable check" node.',
    defaultConfig: { saveAs: 'intent', intents: [] },
    fields: [
      {
        key: 'intents', type: 'string[]', label: 'Possible intents',
        hint: 'Optional candidate labels, e.g. sales, support, complaint. Leave empty for open-ended detection.',
        default: []
      },
      {
        key: 'saveAs', type: 'string', label: 'Save intent as', required: true, default: 'intent',
        hint: 'Variable name to store the detected intent. Reference it later as {{intent}}.'
      }
    ]
  }),
  node('action.ai_extract', 'action', 'AI extract data', CHANNELS, {
    icon: 'fas fa-table-list',
    description: 'Extract structured fields from the customer message into flow variables. Each field is also saved individually.',
    defaultConfig: { fields: ['business_type', 'service', 'budget'], saveAs: 'extracted' },
    fields: [
      {
        key: 'fields', type: 'string[]', label: 'Fields to extract', required: true,
        hint: 'One field name per line, e.g. business_type, service, budget. The AI fills these from the message.',
        default: ['business_type', 'service', 'budget']
      },
      {
        key: 'saveAs', type: 'string', label: 'Save object as', default: 'extracted',
        hint: 'Variable name for the full extracted object. Each field is also saved individually (e.g. {{budget}}).'
      }
    ]
  }),
  node('action.assign_bucket', 'action', 'Assign intent bucket', CHANNELS, {
    icon: 'fas fa-inbox',
    description: 'Route conversation to an intent bucket.',
    defaultConfig: { bucketId: '' },
    fields: [{ key: 'bucketId', type: 'bucket', label: 'Bucket', required: true, default: '' }]
  }),
  node('action.escalate_human', 'action', 'Escalate to human', CHANNELS, {
    icon: 'fas fa-user-headset',
    description: 'Send a handoff message to the customer and hand the chat to a human agent.',
    defaultConfig: { reason: 'Needs human review', message: '' },
    fields: [
      { key: 'message', type: 'textarea', label: 'Handoff message (to customer)', default: '', hint: "Sent to the customer, e.g. \"A team member will get back to you shortly.\" Leave blank to use your Escalation settings' handoff message." },
      { key: 'reason', type: 'string', label: 'Reason (internal)', default: 'Needs human review', hint: 'Shown to agents — not sent to the customer.' }
    ]
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
  node('action.save_shipping_address', 'action', 'Save shipping address', ['whatsapp', 'instagram'], {
    icon: 'fas fa-location-dot',
    description: "Save the customer's replied address onto their order (and remember it on their contact for next time).",
    defaultConfig: { addressVar: 'delivery_address' },
    fields: [
      { key: 'addressVar', type: 'string', label: 'Address variable', default: 'delivery_address', hint: "Flow variable holding the captured address. Falls back to the customer's latest reply." }
    ]
  }),
  node('action.save_payment_method', 'action', 'Save payment method', ['whatsapp'], {
    icon: 'fas fa-credit-card',
    description: 'Capture the customer\'s chosen payment method from their button tap or reply and save it on the order.',
    defaultConfig: { methodVar: 'payment_method' },
    fields: [
      { key: 'methodVar', type: 'string', label: 'Payment variable', default: 'payment_method', hint: 'Flow variable to store the resolved method (cod, upi, razorpay). Auto-detected from button payload when blank.' }
    ]
  }),
  node('action.send_order_details', 'action', 'Send order details (Meta)', ['whatsapp'], {
    icon: 'fas fa-file-invoice-dollar',
    description: 'Sends Meta Review & Pay order_details. Requires WhatsApp Payments (India) + Razorpay linked in Business Manager — UPI is chosen by the customer inside WhatsApp, not via a VPA field here.',
    defaultConfig: {
      bodyText: 'Review your order {{order_ref}} and complete payment.',
      headerText: 'Order summary',
      footerText: '',
      goodsType: 'physical-goods',
      gatewayType: 'razorpay',
      configurationName: 'default'
    },
    fields: [
      { key: 'bodyText', type: 'textarea', label: 'Body', required: true, default: 'Review your order {{order_ref}} and complete payment.', hint: 'Supports {{order_ref}}, {{order_total}}, {{delivery_address}}.' },
      { key: 'headerText', type: 'string', label: 'Header', default: 'Order summary', hint: 'Optional. Max 60 chars.' },
      { key: 'footerText', type: 'string', label: 'Footer', default: '', hint: 'Optional. Max 60 chars.' },
      { key: 'goodsType', type: 'select', label: 'Goods type', options: ['physical-goods', 'digital-goods'], default: 'physical-goods' },
      { key: 'gatewayType', type: 'select', label: 'Payment gateway', options: ['razorpay'], default: 'razorpay', hint: 'Must match the gateway linked in Meta Business Manager → Payments.' },
      { key: 'configurationName', type: 'string', label: 'Gateway config name', required: true, default: 'default', hint: 'Exact payment configuration name from WhatsApp Manager → Payments (India). UPI VPA is configured there — not in this field.' }
    ]
  }),
  node('action.load_saved_address', 'action', 'Load saved address', ['whatsapp', 'instagram'], {
    icon: 'fas fa-address-book',
    description: 'Load the customer\'s remembered delivery address into {{saved_address}} (empty if none on file).',
    defaultConfig: {},
    fields: []
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
  DEFAULT_WA_REPLY_BUTTONS,
  DEFAULT_WA_LIST_SECTIONS,
  getNodeCatalog,
  getNodeDef,
  getStaticDefaultConfig,
  isTriggerType
};
