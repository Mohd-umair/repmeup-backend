'use strict';

const CHANNEL_LABELS = {
  instagram: 'Instagram',
  whatsapp: 'WhatsApp',
  voice: 'Voice',
  manual: 'Manual',
  facebook: 'Facebook',
  google: 'Google',
  youtube: 'YouTube',
  linkedin: 'LinkedIn',
  email: 'Email',
  website: 'Website'
};

const ORDER_STATUS_LABELS = {
  intent: 'Intent',
  product_sent: 'Product Sent',
  cart_started: 'Cart Started',
  payment_pending: 'Awaiting Payment',
  paid: 'Paid',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled'
};

const ORDER_STATUS_TONE = {
  intent: 'neutral',
  product_sent: 'info',
  cart_started: 'info',
  payment_pending: 'warning',
  paid: 'success',
  shipped: 'info',
  delivered: 'success',
  cancelled: 'danger'
};

const COMPLAINT_STATUS_LABELS = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  closed: 'Closed'
};

function formatMoney(amount, currency = 'INR') {
  if (amount == null || Number.isNaN(Number(amount))) return '—';
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: currency || 'INR',
      maximumFractionDigits: 0
    }).format(amount);
  } catch {
    return `₹${Number(amount).toFixed(2)}`.trim();
  }
}

function formatDateLabel(date) {
  if (!date) return '—';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today, ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  if (isYesterday) return `Yesterday, ${time}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDurationMinutes(minutes) {
  if (minutes == null || minutes < 0) return '—';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

function customerFromContact(contact, fallbackName, fallbackHandle) {
  if (contact && typeof contact === 'object') {
    return {
      name: contact.name || fallbackName || 'Unknown',
      handle: contact.phone || contact.email || contact.username || fallbackHandle || '',
      avatarUrl: contact.avatarUrl || null
    };
  }
  return {
    name: fallbackName || 'Unknown',
    handle: fallbackHandle || '',
    avatarUrl: null
  };
}

function customerFromOrder(order) {
  const contact = order.contact;
  const name = order.buyerName || contact?.name || 'Unknown';
  const handle =
    order.buyerPhone ||
    contact?.phone ||
    contact?.email ||
    order.instagramUserId ||
    '';
  return customerFromContact(contact, name, handle);
}

function customerFromInteraction(interaction) {
  const author = interaction.author || {};
  return {
    name: author.name || author.username || 'Unknown',
    handle: author.username || author.phone || author.email || '',
    avatarUrl: author.avatarUrl || null
  };
}

function lineItemsSummary(lineItems = []) {
  if (!lineItems.length) return '—';
  const first = lineItems[0];
  const name = first.name || first.product?.name || 'Item';
  const extra = lineItems.length > 1 ? ` +${lineItems.length - 1} more` : '';
  const qty = first.qty > 1 ? ` ×${first.qty}` : '';
  return `${name}${qty}${extra}`;
}

function paymentLabelForOrder(order) {
  if (order.status === 'paid' || order.status === 'shipped' || order.status === 'delivered') {
    return { label: 'PAID', tone: 'success' };
  }
  if (order.status === 'payment_pending' || order.status === 'cart_started') {
    return { label: 'PENDING', tone: 'warning' };
  }
  if (order.status === 'cancelled') {
    return { label: 'CANCELLED', tone: 'danger' };
  }
  return { label: '—', tone: 'neutral' };
}

function getReviewRating(interaction) {
  const md = interaction.metadata || {};
  const raw = md.starRating ?? md.rating ?? interaction.rating;
  if (raw == null) return null;
  const map = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
  if (typeof raw === 'string' && map[raw]) return map[raw];
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function reviewSnippet(content, max = 80) {
  const t = String(content || '').trim();
  if (!t) return '—';
  return t.length > max ? `${t.substring(0, max)}…` : t;
}

function chatDeepLink(interactionId) {
  return interactionId ? `/app/inbox?selected=${interactionId}` : null;
}

module.exports = {
  CHANNEL_LABELS,
  ORDER_STATUS_LABELS,
  ORDER_STATUS_TONE,
  COMPLAINT_STATUS_LABELS,
  formatMoney,
  formatDateLabel,
  formatDurationMinutes,
  customerFromContact,
  customerFromOrder,
  customerFromInteraction,
  lineItemsSummary,
  paymentLabelForOrder,
  getReviewRating,
  reviewSnippet,
  chatDeepLink
};
