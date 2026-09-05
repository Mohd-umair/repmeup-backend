'use strict';

/**
 * Flow Blueprint Catalog
 * ----------------------
 * Code-defined, version-controlled flow blueprints seeded as GLOBAL blueprints
 * (`organization: null`, `isBlueprint: true`). Global blueprints surface in every
 * org's "Blueprints" tab (automationFlowController.listFlows) and any org imports one
 * via duplicateFlow, then publishes it to run.
 *
 * Checkout — fires on the `whatsapp.order` event the instant a customer places a
 * WhatsApp native-cart order (workflow-only path; no AI). It:
 *   1. thanks the customer + shows what they ordered
 *   2. loads any address remembered on their contact
 *      • returning customer → one-tap "confirm your saved address?" buttons
 *          - Yes  → reuse the saved address
 *          - New  → ask for a fresh address
 *      • first-time customer → ask for the address
 *   3. saves the chosen address onto the order AND remembers it on the contact
 *      (action.save_shipping_address) so the next order is one tap.
 *   4. asks how they want to pay (COD / UPI / Online)
 *   5. sends the official Meta order_details message (Review & Pay) for UPI/online,
 *      or a formatted text order summary for COD.
 *
 * Interpolation tokens at run time (flowTemplateService + flowTriggerRouter):
 *   {{name}} {{first_name}} {{message}}
 *   {{order_ref}} {{order_summary}} {{order_total}} {{order_summary_line}}
 *   {{saved_address}} {{delivery_address}} {{payment_method}} {{payment_method_label}}
 */

const CONFIRM_TEXT =
  'Perfect! ✅ Your order {{order_ref}} is confirmed.\n\n'
  + '📦 Deliver to:\n{{delivery_address}}\n\n'
  + '💳 Payment: {{payment_method_label}}\n\n'
  + 'Thank you for shopping with us — we’ll notify you as soon as it ships! 🙌';

const ASK_ADDRESS_TEXT =
  'Please reply with your full delivery address — house/flat no., area & landmark, '
  + 'city, and pincode. 🏠';

const CHECKOUT_BLUEPRINT = {
  name: 'Checkout — confirm order & collect address',
  description:
    'Fires the instant a customer places a WhatsApp catalog order. Thanks them, '
    + 'collects/confirms delivery address, asks for payment method (COD / UPI / Online), '
    + 'sends the Meta order_details message for online pay, and confirms the order.',
  channels: ['whatsapp'],
  entryNodeId: 't1',
  nodes: [
    { id: 't1', type: 'trigger.order_event', label: 'On order placed', position: { x: 320, y: 20 }, config: { event: 'created' } },

    { id: 'A0', type: 'action.send_text', label: 'Thank you', position: { x: 320, y: 140 },
      config: { text: 'Thank you for your order! 🛒 {{order_summary_line}}' } },

    { id: 'L1', type: 'action.load_saved_address', label: 'Load saved address', position: { x: 320, y: 250 }, config: {} },

    { id: 'C1', type: 'condition.variable', label: 'Has saved address?', position: { x: 320, y: 360 },
      config: { key: 'saved_address', operator: 'neq', value: '' } },

    // ── Returning customer: confirm the saved address ────────────────────────
    { id: 'CB1', type: 'action.send_buttons', label: 'Confirm saved address', position: { x: 120, y: 480 },
      config: {
        bodyText: 'Deliver this order to your saved address?\n\n{{saved_address}}',
        headerText: '', footerText: '',
        buttons: [
          { id: 'addr_yes', title: '✅ Yes, ship here' },
          { id: 'addr_new', title: '✏️ New address' }
        ]
      } },
    { id: 'CB2', type: 'wait.user_reply', label: 'Wait for choice', position: { x: 120, y: 600 }, config: { timeoutSec: 86400 } },
    { id: 'CB3', type: 'condition.reply_contains', label: 'Chose "Yes"?', position: { x: 120, y: 720 },
      config: { keywords: ['yes', 'ship here', 'correct', 'confirm', '✅', '👍'] } },
    { id: 'CB4', type: 'action.set_variable', label: 'Use saved address', position: { x: 40, y: 840 },
      config: { key: 'delivery_address', value: '{{saved_address}}' } },

    // ── New / first-time: ask for the address ────────────────────────────────
    { id: 'A1', type: 'action.send_text', label: 'Ask for address', position: { x: 520, y: 480 },
      config: { text: ASK_ADDRESS_TEXT } },
    { id: 'A2', type: 'wait.user_reply', label: 'Wait for address', position: { x: 520, y: 600 }, config: { timeoutSec: 86400 } },
    { id: 'A3', type: 'action.set_variable', label: 'Capture address', position: { x: 520, y: 720 },
      config: { key: 'delivery_address', value: '{{message}}' } },

    // ── Shared: persist address → payment → order details → confirm ─────────
    { id: 'S1', type: 'action.save_shipping_address', label: 'Save address', position: { x: 280, y: 960 },
      config: { addressVar: 'delivery_address' } },

    { id: 'P1', type: 'action.send_buttons', label: 'Ask payment method', position: { x: 280, y: 1080 },
      config: {
        bodyText: 'How would you like to pay for order {{order_ref}}? (Total {{order_total}})',
        headerText: 'Payment method',
        footerText: '',
        buttons: [
          { id: 'pay_cod', title: '💵 Cash on Delivery' },
          { id: 'pay_upi', title: '📱 UPI' },
          { id: 'pay_online', title: '💳 Pay online' }
        ]
      } },
    { id: 'P2', type: 'wait.user_reply', label: 'Wait for payment choice', position: { x: 280, y: 1200 },
      config: { timeoutSec: 86400 } },
    { id: 'P3', type: 'action.save_payment_method', label: 'Save payment method', position: { x: 280, y: 1320 },
      config: { methodVar: 'payment_method' } },
    { id: 'P4', type: 'action.send_order_details', label: 'Send Meta order details', position: { x: 280, y: 1440 },
      config: {
        headerText: 'Order {{order_ref}}',
        bodyText: 'Review your items and complete payment for {{order_total}}.',
        footerText: 'Tap Review & Pay to continue',
        goodsType: 'physical-goods',
        gatewayType: 'razorpay',
        configurationName: 'default'
      } },

    { id: 'F1', type: 'action.send_text', label: 'Confirm order', position: { x: 280, y: 1560 },
      config: { text: CONFIRM_TEXT } },
    { id: 'e1', type: 'control.end', label: 'Done', position: { x: 280, y: 1680 }, config: {} },

    // ── Timeout: gentle reminder ─────────────────────────────────────────────
    { id: 'R1', type: 'action.send_text', label: 'Address reminder', position: { x: 760, y: 720 },
      config: { text: 'No rush! 😊 Whenever you’re ready, just reply here with your delivery address and we’ll complete your order.' } },
    { id: 'R2', type: 'action.send_text', label: 'Payment reminder', position: { x: 760, y: 1200 },
      config: { text: 'Still there? 😊 Tap a payment option above (COD, UPI, or Pay online) whenever you’re ready.' } },
    { id: 'e2', type: 'control.end', label: 'Done (no reply)', position: { x: 760, y: 1320 }, config: {} }
  ],
  edges: [
    { id: 't1-A0', source: 't1', target: 'A0' },
    { id: 'A0-L1', source: 'A0', target: 'L1' },
    { id: 'L1-C1', source: 'L1', target: 'C1' },

    { id: 'C1-CB1', source: 'C1', target: 'CB1', label: 'yes' },
    { id: 'C1-A1',  source: 'C1', target: 'A1',  label: 'no' },

    { id: 'CB1-CB2', source: 'CB1', target: 'CB2' },
    { id: 'CB2-CB3', source: 'CB2', target: 'CB3', label: 'reply' },
    { id: 'CB2-R1',  source: 'CB2', target: 'R1',  label: 'timeout' },
    { id: 'CB3-CB4', source: 'CB3', target: 'CB4', label: 'yes' },
    { id: 'CB3-A1',  source: 'CB3', target: 'A1',  label: 'no' },
    { id: 'CB4-S1',  source: 'CB4', target: 'S1' },

    { id: 'A1-A2', source: 'A1', target: 'A2' },
    { id: 'A2-A3', source: 'A2', target: 'A3', label: 'reply' },
    { id: 'A2-R1', source: 'A2', target: 'R1', label: 'timeout' },
    { id: 'A3-S1', source: 'A3', target: 'S1' },

    { id: 'S1-F1', source: 'S1', target: 'P1', label: 'saved' },
    { id: 'S1-A1', source: 'S1', target: 'A1', label: 'invalid' },

    { id: 'P1-P2', source: 'P1', target: 'P2' },
    { id: 'P2-P3', source: 'P2', target: 'P3', label: 'reply' },
    { id: 'P2-R2', source: 'P2', target: 'R2', label: 'timeout' },
    { id: 'P3-P4', source: 'P3', target: 'P4', label: 'saved' },
    { id: 'P3-P1', source: 'P3', target: 'P1', label: 'invalid' },
    { id: 'P4-F1', source: 'P4', target: 'F1' },
    { id: 'F1-e1', source: 'F1', target: 'e1' },

    { id: 'R1-e2', source: 'R1', target: 'e2' },
    { id: 'R2-e2', source: 'R2', target: 'e2' }
  ]
};

/**
 * Comment-to-DM — fires when someone comments on a product-linked Instagram post
 * (workflow-only path; no AI). It:
 *   1. posts a short public reply on the comment ("sent you a DM 📩")
 *   2. DMs the commenter the product(s) linked to that post — one product sends its
 *      detail/CTA, multiple send a carousel picker (action.send_post_products).
 *
 * The DM goes out as a private reply (allowed once per comment), and the product(s)
 * are auto-resolved from the post — no per-flow product config needed. When the
 * customer commits to a product, an order is recorded in the OMS automatically.
 *
 * Requires: the org's Instagram automation mode = workflow_only (or hybrid), the
 * post linked to at least one Product, and Comment-to-DM enabled in settings.
 */
const COMMENT_TO_DM_BLUEPRINT = {
  name: 'Comment to DM — send post products',
  description:
    'Fires when someone comments on a product-linked Instagram post. Posts a public '
    + 'reply, then DMs the commenter the post’s product(s) — single product detail '
    + 'or a multi-product carousel — and records the order in the OMS.',
  channels: ['instagram'],
  entryNodeId: 't1',
  nodes: [
    { id: 't1', type: 'trigger.ig_comment', label: 'On post comment', position: { x: 320, y: 20 },
      // Empty keywords = trigger on every comment. Add purchase words (price, buy, link…) to narrow it.
      config: { keywords: [] } },

    { id: 'r1', type: 'action.reply_public_comment', label: 'Public reply', position: { x: 320, y: 150 },
      config: { text: 'Thanks {{username}}! 🙌 Just sent you a DM with the details 📩' } },

    { id: 'p1', type: 'action.send_post_products', label: "DM post's products", position: { x: 320, y: 280 },
      config: {} },

    { id: 'e1', type: 'control.end', label: 'Done', position: { x: 320, y: 410 }, config: {} }
  ],
  edges: [
    { id: 't1-r1', source: 't1', target: 'r1' },
    { id: 'r1-p1', source: 'r1', target: 'p1' },
    { id: 'p1-e1', source: 'p1', target: 'e1' }
  ]
};

/**
 * Appointment Booking — a WhatsApp keyword-triggered booking flow for service
 * businesses (clinics, spas, salons). It greets the customer, offers the next
 * available slots for a service, books the one they pick, and confirms — all
 * recorded in Appointment Management (and synced to Google Calendar when set up).
 *
 * AFTER IMPORTING: open the "Offer slots" node and pick your Service (and,
 * optionally, a specific Provider). Requires Instagram/WhatsApp automation mode =
 * workflow_only or hybrid, plus at least one Service + Provider configured.
 */
const APPOINTMENT_BOOKING_BLUEPRINT = {
  name: 'Book appointment — clinic/spa',
  description:
    'One WhatsApp flow for ALL services: greet → ask which service → offer that '
    + 'service’s available slots → book the customer’s pick → confirm. No per-service '
    + 'flow needed — it reads your services automatically. Bookings appear in '
    + 'Appointment Management.',
  channels: ['whatsapp'],
  entryNodeId: 't1',
  nodes: [
    { id: 't1', type: 'trigger.keyword', label: 'On "book"', position: { x: 320, y: 20 },
      config: { keywords: ['book', 'appointment', 'booking', 'slot', 'schedule', 'appt'] } },

    { id: 'a0', type: 'action.send_text', label: 'Greet', position: { x: 320, y: 130 },
      config: { text: 'Happy to help you book! 📅' } },

    { id: 's1', type: 'action.offer_services', label: 'Ask which service', position: { x: 320, y: 240 },
      config: { bodyText: 'Which service would you like to book?',
        noServicesText: 'Sorry, no services are available to book right now. Please try again later. 🙏' } },
    { id: 'ws', type: 'wait.user_reply', label: 'Wait for service', position: { x: 320, y: 350 },
      config: { timeoutSec: 3600 } },

    { id: 'o1', type: 'action.offer_slots', label: 'Offer slots', position: { x: 320, y: 460 },
      // serviceId empty → uses the service the customer picked above (multi-service).
      config: { serviceId: '', providerId: '', maxSlots: 6, days: 7,
        bodyText: 'Here are the next available times — reply with the number you’d like:',
        noSlotsText: 'Sorry, we’re fully booked for that service right now. Please check back soon! 🙏' } },
    { id: 'w1', type: 'wait.user_reply', label: 'Wait for slot', position: { x: 320, y: 570 },
      config: { timeoutSec: 3600 } },

    { id: 'b1', type: 'action.book_appointment', label: 'Book', position: { x: 320, y: 680 },
      config: { confirmMode: 'auto' } },

    { id: 'c1', type: 'action.send_text', label: 'Confirm', position: { x: 200, y: 790 },
      config: { text: '✅ You’re booked! {{appointment_ref}}\n\n🗓️ {{service_name}} on {{appointment_when}}\nWe’ll send you a reminder. See you then! 🙌' } },
    { id: 'e1', type: 'control.end', label: 'Done', position: { x: 200, y: 900 }, config: {} },

    // Fired only when book_appointment returns branch:'failed' (invalid reply or slot taken).
    // Re-offers the same slot list instead of asking which service again.
    { id: 'f1', type: 'action.send_text', label: 'Booking failed — retry slots', position: { x: 480, y: 790 },
      config: { text: 'Sorry, I couldn\'t book that. 🙏 Here are the available times again — tap one:' } },

    { id: 'n1', type: 'action.send_text', label: 'Nothing available', position: { x: 560, y: 350 },
      config: { text: 'No problem — reply here anytime and we’ll get you booked. 🙏' } },
    { id: 'e2', type: 'control.end', label: 'Done (no booking)', position: { x: 560, y: 460 }, config: {} },

    { id: 'r1', type: 'action.send_text', label: 'Reminder', position: { x: 120, y: 460 },
      config: { text: 'Still there? 😊 Reply with a number above whenever you’re ready.' } }
  ],
  edges: [
    { id: 't1-a0', source: 't1', target: 'a0' },
    { id: 'a0-s1', source: 'a0', target: 's1' },
    { id: 's1-ws', source: 's1', target: 'ws', label: 'offered' },
    { id: 's1-n1', source: 's1', target: 'n1', label: 'none' },
    { id: 'ws-o1', source: 'ws', target: 'o1', label: 'reply' },
    { id: 'ws-r1', source: 'ws', target: 'r1', label: 'timeout' },
    { id: 'o1-w1', source: 'o1', target: 'w1', label: 'offered' },
    // Fallback: invalid service reply / no slots → re-ask which service.
    { id: 'o1-s1', source: 'o1', target: 's1', label: 'none' },
    { id: 'w1-b1', source: 'w1', target: 'b1', label: 'reply' },
    { id: 'w1-r1', source: 'w1', target: 'r1', label: 'timeout' },
    { id: 'b1-c1', source: 'b1', target: 'c1', label: 'booked' },
    { id: 'b1-f1', source: 'b1', target: 'f1', label: 'failed' },
    { id: 'c1-e1', source: 'c1', target: 'e1' },
    { id: 'f1-o1', source: 'f1', target: 'o1' },
    { id: 'n1-e2', source: 'n1', target: 'e2' },
    { id: 'r1-e2', source: 'r1', target: 'e2' }
  ]
};

/** All global blueprints to seed. Add future blueprints here. */
const BLUEPRINTS = [CHECKOUT_BLUEPRINT, COMMENT_TO_DM_BLUEPRINT, APPOINTMENT_BOOKING_BLUEPRINT];

module.exports = { BLUEPRINTS, CHECKOUT_BLUEPRINT, COMMENT_TO_DM_BLUEPRINT, APPOINTMENT_BOOKING_BLUEPRINT };
