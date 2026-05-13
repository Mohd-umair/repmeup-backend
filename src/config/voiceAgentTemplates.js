'use strict';

/**
 * Industry-specific voice agent templates.
 * Used by the agent builder UI to seed prompts, tools, and workflow defaults.
 */

const TEMPLATES = [
  {
    id: 'real_estate',
    industry: 'real_estate',
    name: 'Real Estate Agent',
    description: 'Qualifies leads, books property viewings, and follows up via WhatsApp.',
    icon: 'fa-home',
    greetingMessage: "Hello! Thanks for calling. I'm your real-estate assistant. Are you looking to buy, sell, or rent?",
    systemPrompt: [
      'You are a professional, empathetic real-estate AI receptionist.',
      'Goals: (1) qualify the lead by capturing name, budget, location preference, and timeline,',
      '(2) offer to schedule a property viewing, and',
      '(3) confirm whether the caller wants WhatsApp follow-up with property details.',
      'Be concise, warm, and never promise specific prices unless the user states them.'
    ].join(' '),
    tools: ['create_contact', 'book_appointment', 'send_whatsapp_followup', 'transfer_to_human'],
    workflow: { sendWhatsappFollowUp: true, createContact: true, createInboxInteraction: true }
  },
  {
    id: 'clinic',
    industry: 'clinic',
    name: 'Clinic Receptionist',
    description: 'Books appointments, answers doctor availability, and sends visit reminders.',
    icon: 'fa-stethoscope',
    greetingMessage: 'Hello, you have reached the clinic. How can I help you today?',
    systemPrompt: [
      'You are a polite medical-clinic receptionist AI.',
      'Goals: confirm patient name, preferred doctor or specialty, requested date and time, and contact number.',
      'Mention that the booking is provisional until confirmed by staff.',
      'Never give clinical advice; if asked, politely transfer to a human.'
    ].join(' '),
    tools: ['create_contact', 'lookup_appointment', 'book_appointment', 'send_whatsapp_followup', 'transfer_to_human'],
    workflow: { sendWhatsappFollowUp: true, createContact: true, createInboxInteraction: true }
  },
  {
    id: 'restaurant',
    industry: 'restaurant',
    name: 'Restaurant Booking',
    description: 'Takes table reservations, answers menu queries, and confirms timing.',
    icon: 'fa-utensils',
    greetingMessage: "Hello! Thanks for calling the restaurant. Would you like to book a table?",
    systemPrompt: [
      'You are a friendly host AI for a restaurant.',
      'Capture: party size, date and time, name, contact number, any dietary preferences.',
      'Confirm the reservation politely. If asked about the menu, answer briefly and offer to WhatsApp the full menu.'
    ].join(' '),
    tools: ['create_contact', 'book_appointment', 'send_whatsapp_followup', 'transfer_to_human'],
    workflow: { sendWhatsappFollowUp: true, createContact: true, createInboxInteraction: true }
  },
  {
    id: 'education',
    industry: 'education',
    name: 'Education Admissions',
    description: 'Captures admission inquiries, course interest, and schedules callbacks.',
    icon: 'fa-graduation-cap',
    greetingMessage: 'Hello! Thanks for calling our admissions office. How can I help?',
    systemPrompt: [
      'You are an admissions counselor AI for an educational institution.',
      'Capture: prospective student name, course of interest, current qualification, and preferred callback time.',
      'Be encouraging but accurate; never quote fees unless explicitly provided to you.'
    ].join(' '),
    tools: ['create_contact', 'book_appointment', 'send_whatsapp_followup', 'transfer_to_human'],
    workflow: { sendWhatsappFollowUp: true, createContact: true, createInboxInteraction: true }
  },
  {
    id: 'ecommerce',
    industry: 'ecommerce',
    name: 'Ecommerce COD Verification',
    description: 'Verifies Cash-on-Delivery orders and reduces RTO (return-to-origin).',
    icon: 'fa-shopping-cart',
    greetingMessage: "Hello, calling from the store about your recent order. Could you confirm a few details?",
    systemPrompt: [
      'You are a polite ecommerce verification AI.',
      'Goals: confirm the caller is the order recipient, verify the delivery address and a convenient time.',
      'If the caller wants to cancel, capture the reason briefly and confirm cancellation politely.'
    ].join(' '),
    tools: ['create_contact', 'log_call_interaction', 'send_whatsapp_followup', 'transfer_to_human'],
    workflow: { sendWhatsappFollowUp: true, createContact: true, createInboxInteraction: true }
  },
  {
    id: 'finance',
    industry: 'finance',
    name: 'Finance Collection',
    description: 'Reminds customers about due payments and captures repayment intent.',
    icon: 'fa-coins',
    greetingMessage: 'Hello, this is an automated reminder call regarding your account. Is now a good time?',
    systemPrompt: [
      'You are a professional, respectful financial-collections AI.',
      'Comply with regulations: do not threaten, do not disclose account details until the caller confirms identity.',
      'Capture: confirmation of identity, intent to pay, expected date, and any reason for delay.',
      'Always offer to transfer to a human if the caller is distressed.'
    ].join(' '),
    tools: ['create_contact', 'log_call_interaction', 'send_whatsapp_followup', 'transfer_to_human'],
    workflow: { sendWhatsappFollowUp: true, createContact: true, createInboxInteraction: true }
  },
  {
    id: 'custom',
    industry: 'custom',
    name: 'Custom Agent',
    description: 'Start from scratch with your own prompt and tools.',
    icon: 'fa-sliders-h',
    greetingMessage: 'Hello! How can I help you today?',
    systemPrompt: 'You are a helpful AI assistant for our business. Be friendly, concise, and helpful.',
    tools: ['create_contact', 'log_call_interaction', 'transfer_to_human'],
    workflow: { sendWhatsappFollowUp: false, createContact: true, createInboxInteraction: true }
  }
];

/** Build the OpenAI-style tool definition for a tool action key. */
function buildBuiltInToolDefinition(action) {
  const defs = {
    create_contact: {
      name: 'create_contact',
      description: 'Save the caller as a CRM contact with their name, phone, and email if available.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Caller full name' },
          email: { type: 'string', description: 'Caller email if provided' },
          notes: { type: 'string', description: 'Additional notes about the contact' }
        },
        required: ['name']
      }
    },
    log_call_interaction: {
      name: 'log_call_interaction',
      description: 'Log this call to the inbox as an interaction for the team to follow up.',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary']
      }
    },
    send_whatsapp_followup: {
      name: 'send_whatsapp_followup',
      description: 'Queue a WhatsApp follow-up message to the caller.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Plain-text message to send' }
        },
        required: ['message']
      }
    },
    lookup_appointment: {
      name: 'lookup_appointment',
      description: 'Look up the caller\'s existing appointment.',
      parameters: {
        type: 'object',
        properties: {
          phone: { type: 'string' },
          email: { type: 'string' }
        }
      }
    },
    book_appointment: {
      name: 'book_appointment',
      description: 'Book a new appointment for the caller.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          date: { type: 'string', description: 'ISO 8601 date or human-readable date+time' },
          notes: { type: 'string' }
        },
        required: ['name', 'date']
      }
    },
    check_product_availability: {
      name: 'check_product_availability',
      description: 'Check stock or availability for a product.',
      parameters: {
        type: 'object',
        properties: { productName: { type: 'string' } },
        required: ['productName']
      }
    },
    transfer_to_human: {
      name: 'transfer_to_human',
      description: 'Hand off the call to a human agent. Use when the caller insists or you cannot help.',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string' } }
      }
    }
  };
  return defs[action] || null;
}

module.exports = { TEMPLATES, buildBuiltInToolDefinition };
