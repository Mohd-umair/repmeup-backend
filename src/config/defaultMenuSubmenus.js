/**
 * Default submenu rows inserted when a parent exists in DB but has no children.
 * Used by POST /api/super-admin/menus/bootstrap-defaults (not injected at runtime).
 */
const DEFAULT_SUBMENU_PACKS = [
  {
    parentRoute: '/app/publish',
    children: [
      {
        label: 'Create',
        icon: '✏️',
        route: '/app/publish',
        order: 1,
        requiredRoles: ['admin', 'manager', 'agent'],
        requiredPermissions: ['posts.create']
      },
      {
        label: 'Calendar',
        icon: '📅',
        route: '/app/publish/calendar',
        order: 2,
        requiredRoles: ['admin', 'manager', 'agent'],
        requiredPermissions: ['posts.read']
      },
      {
        label: 'Scheduled',
        icon: '⏰',
        route: '/app/scheduled-posts',
        order: 3,
        requiredRoles: ['admin', 'manager', 'agent'],
        requiredPermissions: ['posts.read']
      },
      {
        label: 'Content',
        icon: '📚',
        route: '/app/content',
        order: 4,
        requiredRoles: ['admin', 'manager', 'agent'],
        requiredPermissions: ['posts.read']
      }
    ]
  },
  {
    parentRoute: '/app/analytics',
    children: [
      {
        label: 'Overview',
        icon: '📊',
        route: '/app/analytics',
        order: 1,
        queryParams: { tab: 'overview' },
        requiredRoles: ['admin', 'manager'],
        requiredPermissions: ['analytics.read']
      },
      {
        label: 'Platforms',
        icon: '📱',
        route: '/app/analytics',
        order: 2,
        queryParams: { tab: 'platforms' },
        requiredRoles: ['admin', 'manager'],
        requiredPermissions: ['analytics.read']
      },
      {
        label: 'Trends',
        icon: '📈',
        route: '/app/analytics',
        order: 3,
        queryParams: { tab: 'trends' },
        requiredRoles: ['admin', 'manager'],
        requiredPermissions: ['analytics.read']
      },
      {
        label: 'Performance',
        icon: '⚡',
        route: '/app/analytics',
        order: 4,
        queryParams: { tab: 'performance' },
        requiredRoles: ['admin', 'manager'],
        requiredPermissions: ['analytics.read']
      },
      {
        label: 'Reports',
        icon: '📄',
        route: '/app/analytics',
        order: 5,
        queryParams: { tab: 'reports' },
        requiredRoles: ['admin', 'manager'],
        requiredPermissions: ['analytics.read']
      }
    ]
  },
  {
    parentRoute: '/app/settings',
    children: [
      {
        label: 'Platforms',
        icon: '🔗',
        route: '/app/settings/platforms',
        order: 1,
        requiredRoles: ['admin', 'manager'],
        requiredPermissions: ['settings.read']
      },
      {
        label: 'Profile',
        icon: '👤',
        route: '/app/settings/profile',
        order: 2,
        requiredRoles: ['admin', 'manager'],
        requiredPermissions: ['settings.read']
      },
      {
        label: 'Organization',
        icon: '🏢',
        route: '/app/settings/organization',
        order: 3,
        requiredRoles: ['admin', 'manager'],
        requiredPermissions: ['organization.read']
      },
      {
        label: 'Notifications',
        icon: '🔔',
        route: '/app/settings/notifications',
        order: 4,
        requiredRoles: ['admin', 'manager'],
        requiredPermissions: ['settings.read']
      },
      {
        label: 'Auto-reply',
        icon: '🤖',
        route: '/app/settings/auto-reply',
        order: 5,
        requiredRoles: ['admin', 'manager'],
        requiredPermissions: ['settings.read']
      },
      {
        label: 'Brand rules',
        icon: '📐',
        route: '/app/settings/brand-rules',
        order: 6,
        requiredRoles: ['admin', 'manager'],
        requiredPermissions: ['settings.read']
      },
      {
        label: 'Compliance',
        icon: '✅',
        route: '/app/settings/compliance',
        order: 7,
        requiredRoles: ['admin', 'manager'],
        requiredPermissions: ['settings.read']
      }
    ]
  }
];

module.exports = { DEFAULT_SUBMENU_PACKS };
