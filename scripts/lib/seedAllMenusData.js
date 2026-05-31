'use strict';

const { DEFAULT_SUBMENU_PACKS } = require('../../src/config/defaultMenuSubmenus');

const TOP_LEVEL_MENUS = [
  { label: 'Home', icon: 'fas fa-home', route: '/', order: 1, group: 'main', requiredRoles: [], isActive: true },
  { label: 'Dashboard', icon: 'fas fa-chart-pie', route: '/app/dashboard', order: 2, group: 'main', requiredRoles: ['admin', 'manager', 'agent'], isActive: true },
  {
    label: 'Inbox', icon: 'fas fa-inbox', route: '/app/inbox', order: 3, group: 'main',
    requiredRoles: ['admin', 'manager', 'agent'], requiredPermissions: ['inbox.read'],
    badge: { enabled: true, source: 'inbox' }, isActive: true,
    description: 'View and respond to customer interactions'
  },
  {
    label: 'Bucket Board', icon: 'fas fa-columns', route: '/app/inbox/buckets', order: 4, group: 'main',
    requiredRoles: ['admin', 'manager', 'agent'], requiredPermissions: ['inbox.read'], isActive: true,
    description: 'Intent bucket kanban board for conversations'
  },
  { label: 'Publish', icon: 'fas fa-paper-plane', route: '/app/publish', order: 5, group: 'main', requiredRoles: ['admin', 'manager', 'agent'], isActive: true },
  {
    label: 'Knowledge Base', icon: 'fas fa-brain', route: '/app/knowledge-base', order: 6, group: 'main',
    requiredRoles: ['admin', 'manager'], requiresFeature: 'knowledge_base', isActive: true
  },
  {
    label: 'Catalog', icon: 'fas fa-store', route: '/app/catalog', order: 12, group: 'main',
    requiredRoles: ['admin', 'manager'], requiredPermissions: ['settings.read'], isActive: true,
    description: 'Manage products and Instagram comment-to-DM automation'
  },
  {
    label: 'Analytics', icon: 'fas fa-chart-line', route: '/app/analytics', order: 7, group: 'main',
    requiredRoles: ['admin', 'manager'], requiredPermissions: ['analytics.read'],
    requiresFeature: 'analytics', isActive: true
  },
  { label: 'Agents', icon: 'fas fa-users', route: '/app/agents', order: 8, group: 'management', requiredRoles: ['admin', 'manager'], requiresFeature: 'agents', isActive: true },
  {
    label: 'Voice IVR', icon: 'fas fa-phone-alt', route: '/app/voice-ivr', order: 9, group: 'management',
    requiredRoles: ['admin', 'manager'], isActive: true,
    description: 'AI phone calling, voice agents, call logs, analytics'
  },
  {
    label: 'Plans', icon: 'fas fa-gem', route: '/app/plans', order: 10, group: 'settings',
    requiredRoles: ['admin', 'manager', 'agent'], isActive: true,
    description: 'View and upgrade subscription plans'
  },
  {
    label: 'Settings', icon: 'fas fa-cog', route: '/app/settings', order: 11, group: 'settings',
    requiredRoles: ['admin', 'manager'], requiredPermissions: ['settings.read'], isActive: true
  }
];

const AUTOMATION_MENUS = [
  { label: 'Automation Hub', icon: 'fas fa-robot', route: '/app/automation', order: 20, group: 'automation', requiredRoles: ['admin', 'manager'], requiredPermissions: ['settings.read'], description: 'Automation dashboard' },
  { label: 'AI Auto Replies', icon: 'fas fa-comment-dots', route: '/app/automation/ai-replies', order: 21, group: 'automation', requiredRoles: ['admin', 'manager'], requiredPermissions: ['settings.read'], description: 'AI-powered auto replies' },
  { label: 'Growth Automation', icon: 'fas fa-seedling', route: '/app/automation/growth', order: 22, group: 'automation', requiredRoles: ['admin', 'manager'], requiredPermissions: ['settings.read'], description: 'Comment-to-DM and growth flows' },
  { label: 'WhatsApp Flows', icon: 'fab fa-whatsapp', route: '/app/automation/whatsapp-flows', order: 23, group: 'automation', requiredRoles: ['admin', 'manager'], requiredPermissions: ['settings.read'], description: 'WhatsApp automation flows' },
  { label: 'Review Collection', icon: 'fas fa-star', route: '/app/automation/reviews', order: 24, group: 'automation', requiredRoles: ['admin', 'manager'], requiredPermissions: ['settings.read'], description: 'Request reviews after purchases' },
  { label: 'Retargeting', icon: 'fas fa-bullseye', route: '/app/automation/retargeting', order: 25, group: 'automation', requiredRoles: ['admin', 'manager'], requiredPermissions: ['settings.read'], description: 'Re-engage leads and customers' },
  { label: 'Human Escalation', icon: 'fas fa-headset', route: '/app/automation/escalation', order: 26, group: 'automation', requiredRoles: ['admin', 'manager'], requiredPermissions: ['settings.read'], description: 'Route to human agents' }
];

const CAMPAIGNS_MENUS = [
  { label: 'WhatsApp Campaigns', icon: 'fab fa-whatsapp', route: '/app/campaigns', order: 30, group: 'campaigns', requiredRoles: ['admin', 'manager'], requiredPermissions: ['settings.read'], description: 'Broadcast WhatsApp campaigns' },
  { label: 'Number Reports', icon: 'fas fa-chart-bar', route: '/app/reports', order: 52, group: 'campaigns', requiredRoles: ['admin', 'manager'], requiredPermissions: ['analytics.read'], description: 'Per-number analytics' }
];

module.exports = { DEFAULT_SUBMENU_PACKS, TOP_LEVEL_MENUS, AUTOMATION_MENUS, CAMPAIGNS_MENUS };
