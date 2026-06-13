'use strict';

/**
 * Flow Blueprint Catalog
 * ----------------------
 * Code-defined, version-controlled flow blueprints seeded as GLOBAL blueprints
 * (`organization: null`, `isBlueprint: true`). Global blueprints surface in every
 * org's "Blueprints" tab (see automationFlowController.listFlows) and any org can
 * import one via `duplicateFlow`, then publish it to make it run.
 *
 * These run through the same engine as user flows (flowTriggerRouter →
 * flowExecutorService → flowNodeHandlers). The Checkout blueprint fires on the
 * `whatsapp.order` event (trigger.order_event, event: 'created') — i.e. the moment
 * a customer places a WhatsApp native-cart order — which makes it the workflow-only
 * counterpart to the AI order acknowledgement.
 *
 * Interpolation tokens available at run time (see flowTemplateService + the order
 * enrichment in flowTriggerRouter):
 *   {{name}} {{first_name}} {{message}}            — author + latest inbound text
 *   {{order_ref}} {{order_summary}} {{order_total}} {{order_summary_line}}
 */

const CHECKOUT_BLUEPRINT = {
  name: 'Checkout — confirm order & collect address',
  description:
    'Fires the instant a customer places a WhatsApp catalog order: thanks them, '
    + 'shows what they ordered, asks for their delivery address, captures it, and '
    + 'confirms. The workflow-only checkout path — no AI required.',
  channels: ['whatsapp'],
  entryNodeId: 't1',
  nodes: [
    {
      id: 't1', type: 'trigger.order_event', label: 'On order placed',
      position: { x: 280, y: 40 }, config: { event: 'created' }
    },
    {
      id: 'a1', type: 'action.send_text', label: 'Thank you + ask address',
      position: { x: 280, y: 180 },
      config: {
        text:
          'Thank you for your order! 🛒 {{order_summary_line}}\n\n'
          + 'To get it delivered, please reply with your full delivery address — '
          + 'house/flat no., area & landmark, city, and pincode. 🏠'
      }
    },
    {
      id: 'w1', type: 'wait.user_reply', label: 'Wait for address',
      position: { x: 280, y: 320 }, config: { timeoutSec: 86400 }
    },
    {
      id: 's1', type: 'action.set_variable', label: 'Capture address',
      position: { x: 140, y: 460 }, config: { key: 'delivery_address', value: '{{message}}' }
    },
    {
      id: 's2', type: 'action.save_shipping_address', label: 'Save address to order',
      position: { x: 140, y: 600 }, config: { addressVar: 'delivery_address' }
    },
    {
      id: 'a2', type: 'action.send_text', label: 'Confirm order',
      position: { x: 140, y: 740 },
      config: {
        text:
          'Perfect! ✅ Your order {{order_ref}} is confirmed and will be dispatched to:\n'
          + '{{delivery_address}}\n\n'
          + 'Thank you for shopping with us — we’ll notify you as soon as it ships! 🙌'
      }
    },
    {
      id: 'e1', type: 'control.end', label: 'Done',
      position: { x: 140, y: 880 }, config: {}
    },
    {
      id: 'a3', type: 'action.send_text', label: 'Address reminder',
      position: { x: 440, y: 460 },
      config: {
        text:
          'No rush! 😊 Whenever you’re ready, just reply here with your delivery '
          + 'address and we’ll complete your order.'
      }
    },
    {
      id: 'e2', type: 'control.end', label: 'Done (no reply)',
      position: { x: 440, y: 600 }, config: {}
    }
  ],
  edges: [
    { id: 't1-a1', source: 't1', target: 'a1' },
    { id: 'a1-w1', source: 'a1', target: 'w1' },
    { id: 'w1-s1', source: 'w1', target: 's1', label: 'reply' },
    { id: 'w1-a3', source: 'w1', target: 'a3', label: 'timeout' },
    { id: 's1-s2', source: 's1', target: 's2' },
    { id: 's2-a2', source: 's2', target: 'a2' },
    { id: 'a2-e1', source: 'a2', target: 'e1' },
    { id: 'a3-e2', source: 'a3', target: 'e2' }
  ]
};

/** All global blueprints to seed. Add future blueprints here. */
const BLUEPRINTS = [CHECKOUT_BLUEPRINT];

module.exports = { BLUEPRINTS, CHECKOUT_BLUEPRINT };
