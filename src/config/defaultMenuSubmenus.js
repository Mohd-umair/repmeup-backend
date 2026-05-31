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
        icon: 'fas fa-pen',
        route: '/app/publish',
        order: 1,
        requiredRoles: ['admin', 'manager', 'agent'],
        requiredPermissions: ['posts.create']
      },
      {
        label: 'Calendar',
        icon: 'fas fa-calendar-alt',
        route: '/app/publish/calendar',
        order: 2,
        requiredRoles: ['admin', 'manager', 'agent'],
        requiredPermissions: ['posts.read']
      },
      {
        label: 'Scheduled',
        icon: 'fas fa-clock',
        route: '/app/scheduled-posts',
        order: 3,
        requiredRoles: ['admin', 'manager', 'agent'],
        requiredPermissions: ['posts.read']
      },
      {
        label: 'Content',
        icon: 'fas fa-folder-open',
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
        icon: 'fas fa-chart-pie',
        route: '/app/analytics',
        order: 1,
        queryParams: { tab: 'overview' },
        requiredRoles: ['admin', 'manager'],
        requiredPermissions: ['analytics.read']
      },
      {
        label: 'Platforms',
        icon: 'fas fa-mobile-alt',
        route: '/app/analytics',
        order: 2,
        queryParams: { tab: 'platforms' },
        requiredRoles: ['admin', 'manager'],
        requiredPermissions: ['analytics.read']
      },
      {
        label: 'Trends',
        icon: 'fas fa-chart-line',
        route: '/app/analytics',
        order: 3,
        queryParams: { tab: 'trends' },
        requiredRoles: ['admin', 'manager'],
        requiredPermissions: ['analytics.read']
      },
      {
        label: 'Performance',
        icon: 'fas fa-bolt',
        route: '/app/analytics',
        order: 4,
        queryParams: { tab: 'performance' },
        requiredRoles: ['admin', 'manager'],
        requiredPermissions: ['analytics.read']
      },
      {
        label: 'Reports',
        icon: 'fas fa-file-alt',
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
        icon: 'fas fa-link',
        route: '/app/settings/platforms',
        order: 1,
        requiredRoles: ['admin', 'manager'],
        requiredPermissions: ['settings.read']
      },
      {
        label: 'Profile',
        icon: 'fas fa-user',
        route: '/app/settings/profile',
        order: 2,
        requiredRoles: ['admin', 'manager'],
        requiredPermissions: ['settings.read']
      },
      {
        label: 'Organization',
        icon: 'fas fa-building',
        route: '/app/settings/organization',
        order: 3,
        requiredRoles: ['admin', 'manager'],
        requiredPermissions: ['organization.read']
      },
      {
        label: 'Notifications',
        icon: 'fas fa-bell',
        route: '/app/settings/notifications',
        order: 4,
        requiredRoles: ['admin', 'manager'],
        requiredPermissions: ['settings.read']
      },
      {
        label: 'Auto-reply',
        icon: 'fas fa-robot',
        route: '/app/settings/auto-reply',
        order: 5,
        requiredRoles: ['admin', 'manager'],
        requiredPermissions: ['settings.read']
      },
      {
        label: 'Brand rules',
        icon: 'fas fa-ruler-combined',
        route: '/app/settings/brand-rules',
        order: 6,
        requiredRoles: ['admin', 'manager'],
        requiredPermissions: ['settings.read']
      },
      {
        label: 'Compliance',
        icon: 'fas fa-check-circle',
        route: '/app/settings/compliance',
        order: 7,
        requiredRoles: ['admin', 'manager'],
        requiredPermissions: ['settings.read']
      }
    ]
  }
];

module.exports = { DEFAULT_SUBMENU_PACKS };
