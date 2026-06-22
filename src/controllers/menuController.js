const Menu = require('../models/Menu');
const User = require('../models/User');
const Group = require('../models/Group');
const { DEFAULT_SUBMENU_PACKS } = require('../config/defaultMenuSubmenus');

function menuIdStr(id) {
  if (id == null) return '';
  return id.toString();
}

/**
 * Build grouped menus: top-level only, with nested `children` from parentId (already permission-filtered).
 */
function buildGroupedMenuTree(accessibleMenus) {
  const idSet = new Set(accessibleMenus.map((m) => menuIdStr(m._id)));

  const byParent = new Map();
  accessibleMenus.forEach((m) => {
    if (!m.parentId) return;
    const pid = menuIdStr(m.parentId);
    if (!byParent.has(pid)) byParent.set(pid, []);
    byParent.get(pid).push(m);
  });
  byParent.forEach((arr) => arr.sort((a, b) => (a.order || 0) - (b.order || 0)));

  // Items whose parentId points to a missing/inactive parent are orphaned — promote to top-level
  // so they still appear in the sidebar (e.g. Catalog with a deleted parent).
  const topLevel = accessibleMenus.filter((m) => {
    if (!m.parentId) return true;
    return !idSet.has(menuIdStr(m.parentId));
  });
  topLevel.sort((a, b) => (a.order || 0) - (b.order || 0));

  const enriched = topLevel.map((parent) => {
    const kids = byParent.get(menuIdStr(parent._id)) || [];
    if (kids.length === 0) return { ...parent };
    return { ...parent, children: kids };
  });

  const groupedMenus = { main: [], management: [], settings: [], automation: [], campaigns: [] };
  enriched.forEach((menu) => {
    if (groupedMenus[menu.group]) {
      groupedMenus[menu.group].push(menu);
    } else {
      // Unknown group: fall back to main so it's still visible
      groupedMenus.main.push(menu);
    }
  });
  return groupedMenus;
}

function passesMenuRoles(requiredRoles, userRole, isBypassRole) {
  if (isBypassRole) return true;
  if (!requiredRoles || requiredRoles.length === 0) return true;
  return requiredRoles.includes(userRole);
}

function passesMenuPermissions(requiredPermissions, permissionSet, isBypassRole, user) {
  if (isBypassRole) return true;
  if (user?.role === 'admin' && permissionSet.size === 0) return true;
  if (!requiredPermissions || requiredPermissions.length === 0) return true;
  if (permissionSet.size === 0) return false;
  return requiredPermissions.every((p) => permissionSet.has(p));
}

async function resolveEffectiveGroupForMenuUser(user) {
  if (user?.group && Array.isArray(user.group.permissions) && user.group.permissions.length > 0) {
    return user.group;
  }

  const roleToSlug = {
    super_admin: 'super-admin',
    admin: 'admin',
    manager: 'manager',
    agent: 'agent',
    viewer: 'viewer'
  };

  const slug = roleToSlug[user?.role];
  if (!slug) return null;

  return Group.findOne({ slug, isActive: true })
    .populate('permissions', 'code')
    .lean();
}

/**
 * @desc    Get user's accessible menus
 * @route   GET /api/menus
 * @access  Private
 */
exports.getMenus = async (req, res, next) => {
  try {
    const baseUser = req.user;
    const user = await User.findById(baseUser._id)
      .select('email role permissions group')
      .populate({
        path: 'group',
        populate: { path: 'permissions', select: 'code' }
      })
      .lean();
    if (!user) {
      return res.status(401).json({ success: false, error: 'User not found' });
    }

    const effectiveGroup = await resolveEffectiveGroupForMenuUser(user);
    const groupCodes = Array.isArray(effectiveGroup?.permissions)
      ? effectiveGroup.permissions.map((p) => (typeof p === 'object' ? p.code : p)).filter(Boolean)
      : [];
    const directCodes = Array.isArray(user.permissions) ? user.permissions.filter(Boolean) : [];
    const permissionCodes = [...new Set([...groupCodes, ...directCodes])];
    const permissionSet = new Set(permissionCodes);
    const isBypassRole = user.role === 'super_admin';
    
    // Fetch all active menus (single source of truth from DB config)
    const allMenus = await Menu.find({ isActive: true })
      .sort({ group: 1, order: 1 })
      .lean();

    // Filter menus based on user permissions
    const accessibleMenus = allMenus.filter((menu) => {
      if (isBypassRole) {
        return true;
      }

      if (menu.requiredRoles && menu.requiredRoles.length > 0) {
        const bypassRoleCheck = user.role === 'admin';
        if (!bypassRoleCheck && !menu.requiredRoles.includes(user.role)) {
          return false;
        }
      }

      if (menu.requiredPermissions && menu.requiredPermissions.length > 0) {
        // Org admins often lack every granular code (e.g. posts.manage); route guards still apply on navigation.
        const bypassPermCheck = user.role === 'admin';
        if (!bypassPermCheck) {
          if (permissionSet.size === 0) {
            return false;
          }

          const hasAllPermissions = menu.requiredPermissions.every((permission) =>
            permissionSet.has(permission)
          );

          if (!hasAllPermissions) {
            return false;
          }
        }
      }

      return true;
    });

    const groupedMenus = buildGroupedMenuTree(accessibleMenus);

    res.status(200).json({
      success: true,
      data: {
        menus: accessibleMenus,
        grouped: groupedMenus
      }
    });
  } catch (error) {
    console.error('Get menus error:', error);
    next(error);
  }
};

/**
 * @desc    Create new menu item (Admin only)
 * @route   POST /api/menus
 * @access  Private (Admin)
 */
exports.createMenu = async (req, res, next) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Only administrators can create menus'
      });
    }

    const menu = await Menu.create(req.body);

    res.status(201).json({
      success: true,
      data: menu
    });
  } catch (error) {
    console.error('Create menu error:', error);
    next(error);
  }
};

/**
 * @desc    Update menu item (Admin only)
 * @route   PUT /api/menus/:id
 * @access  Private (Admin)
 */
exports.updateMenu = async (req, res, next) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Only administrators can update menus'
      });
    }

    const menu = await Menu.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    if (!menu) {
      return res.status(404).json({
        success: false,
        error: 'Menu not found'
      });
    }

    res.status(200).json({
      success: true,
      data: menu
    });
  } catch (error) {
    console.error('Update menu error:', error);
    next(error);
  }
};

/**
 * @desc    Delete menu item (Admin only)
 * @route   DELETE /api/menus/:id
 * @access  Private (Admin)
 */
exports.deleteMenu = async (req, res, next) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Only administrators can delete menus'
      });
    }

    const menu = await Menu.findByIdAndDelete(req.params.id);

    if (!menu) {
      return res.status(404).json({
        success: false,
        error: 'Menu not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Menu deleted successfully'
    });
  } catch (error) {
    console.error('Delete menu error:', error);
    next(error);
  }
};

/**
 * @desc    Get all menus (Admin only)
 * @route   GET /api/menus/all
 * @access  Private (Admin)
 */
exports.getAllMenus = async (req, res, next) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Only administrators can view all menus'
      });
    }

    const menus = await Menu.find().sort({ group: 1, order: 1 });

    res.status(200).json({
      success: true,
      data: menus
    });
  } catch (error) {
    console.error('Get all menus error:', error);
    next(error);
  }
};

/**
 * @desc    Seed default menus (Admin only)
 * @route   POST /api/menus/seed
 * @access  Private (Admin)
 */
exports.seedMenus = async (req, res, next) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Only administrators can seed menus'
      });
    }

    // Check if menus already exist
    const existingCount = await Menu.countDocuments();
    if (existingCount > 0) {
      return res.status(400).json({
        success: false,
        error: 'Menus already exist. Delete them first if you want to reseed.'
      });
    }

    const defaultMenus = [
      {
        label: 'Home',
        icon: 'fas fa-home',
        route: '/',
        order: 1,
        group: 'main',
        requiredRoles: []
      },
      {
        label: 'Dashboard',
        icon: 'fas fa-chart-pie',
        route: '/app/dashboard',
        order: 2,
        group: 'main',
        requiredRoles: ['admin', 'manager', 'agent']
      },
      {
        label: 'Inbox',
        icon: 'fas fa-inbox',
        route: '/app/inbox',
        order: 3,
        group: 'main',
        requiredRoles: ['admin', 'manager', 'agent'],
        badge: {
          enabled: true,
          source: 'inbox'
        }
      },
      {
        label: 'Bucket Board',
        icon: 'fas fa-columns',
        route: '/app/inbox/buckets',
        order: 4,
        group: 'main',
        requiredRoles: ['admin', 'manager', 'agent'],
        requiredPermissions: ['inbox.read']
      },
      {
        label: 'Knowledge Base',
        icon: 'fas fa-brain',
        route: '/app/knowledge-base',
        order: 6,
        group: 'main',
        requiredRoles: ['admin', 'manager'],
        requiresFeature: 'knowledge_base'
      },
      {
        label: 'Analytics',
        icon: 'fas fa-chart-line',
        route: '/app/analytics',
        order: 7,
        group: 'main',
        requiredRoles: ['admin', 'manager'],
        requiresFeature: 'analytics'
      },
      {
        label: 'Agents',
        icon: 'fas fa-users',
        route: '/app/agents',
        order: 8,
        group: 'management',
        requiredRoles: ['admin', 'manager'],
        requiresFeature: 'agents'
      },
      {
        label: 'Appointments',
        icon: 'fas fa-calendar-check',
        route: '/app/appointments',
        order: 7,
        group: 'management',
        requiredRoles: ['admin', 'manager']
      },
      {
        label: 'Settings',
        icon: 'fas fa-cog',
        route: '/app/settings',
        order: 9,
        group: 'settings',
        requiredRoles: ['admin', 'manager']
      }
    ];

    const inserted = await Menu.insertMany(defaultMenus);

    const publishParent = await Menu.create({
      label: 'Publish',
      icon: 'fas fa-paper-plane',
      route: '/app/publish',
      order: 4,
      group: 'main',
      requiredRoles: ['admin', 'manager', 'agent'],
      requiredPermissions: []
    });

    const publishChildren = await Menu.insertMany([
      {
        label: 'Create',
        icon: 'fas fa-pen',
        route: '/app/publish',
        order: 1,
        group: 'main',
        parentId: publishParent._id,
        requiredRoles: ['admin', 'manager', 'agent'],
        requiredPermissions: ['posts.create']
      },
      {
        label: 'Calendar',
        icon: 'fas fa-calendar-alt',
        route: '/app/publish/calendar',
        order: 2,
        group: 'main',
        parentId: publishParent._id,
        requiredRoles: ['admin', 'manager', 'agent'],
        requiredPermissions: ['posts.read']
      },
      {
        label: 'Published',
        icon: 'fas fa-folder-open',
        route: '/app/content',
        queryParams: { view: 'published' },
        order: 3,
        group: 'main',
        parentId: publishParent._id,
        requiredRoles: ['admin', 'manager', 'agent'],
        requiredPermissions: ['posts.read']
      }
    ]);

    const extraMenus = [];
    for (const pack of DEFAULT_SUBMENU_PACKS) {
      if (pack.parentRoute === '/app/publish') continue;
      const parent = await Menu.findOne({
        route: pack.parentRoute,
        $or: [{ parentId: null }, { parentId: { $exists: false } }]
      });
      if (!parent) continue;
      const docs = pack.children.map((c) => ({
        ...c,
        group: parent.group || 'main',
        parentId: parent._id,
        isActive: true
      }));
      const created = await Menu.insertMany(docs);
      extraMenus.push(...created);
    }

    const menus = [...inserted, publishParent, ...publishChildren, ...extraMenus];

    res.status(201).json({
      success: true,
      data: menus,
      message: `${menus.length} menus seeded (Publish, Analytics, Settings submenus from DB)`
    });
  } catch (error) {
    console.error('Seed menus error:', error);
    next(error);
  }
};

/**
 * @desc    Add Publish submenus (Create, Calendar, Published) for existing installs — idempotent
 * @route   POST /api/menus/migrate-publish-submenus
 * @access  Private (Admin)
 */
exports.migratePublishSubmenus = async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Only administrators can run menu migration'
      });
    }

    const publishParent = await Menu.findOne({
      route: '/app/publish',
      $or: [{ parentId: null }, { parentId: { $exists: false } }]
    });

    if (!publishParent) {
      return res.status(404).json({
        success: false,
        error: 'Top-level Publish menu not found. Create one or reseed menus.'
      });
    }

    const existing = await Menu.countDocuments({ parentId: publishParent._id });
    if (existing > 0) {
      return res.status(200).json({
        success: true,
        message: 'Publish submenus already exist',
        data: { created: 0, existing }
      });
    }

    const publishChildren = await Menu.insertMany([
      {
        label: 'Create',
        icon: 'fas fa-pen',
        route: '/app/publish',
        order: 1,
        group: 'main',
        parentId: publishParent._id,
        requiredRoles: ['admin', 'manager', 'agent'],
        requiredPermissions: ['posts.create']
      },
      {
        label: 'Calendar',
        icon: 'fas fa-calendar-alt',
        route: '/app/publish/calendar',
        order: 2,
        group: 'main',
        parentId: publishParent._id,
        requiredRoles: ['admin', 'manager', 'agent'],
        requiredPermissions: ['posts.read']
      },
      {
        label: 'Published',
        icon: 'fas fa-folder-open',
        route: '/app/content',
        queryParams: { view: 'published' },
        order: 3,
        group: 'main',
        parentId: publishParent._id,
        requiredRoles: ['admin', 'manager', 'agent'],
        requiredPermissions: ['posts.read']
      }
    ]);

    res.status(201).json({
      success: true,
      message: 'Publish submenus created',
      data: { created: publishChildren.length }
    });
  } catch (error) {
    console.error('migratePublishSubmenus error:', error);
    next(error);
  }
};

/**
 * @desc    Point /app/content menu items at platform library (strip ?view=published). Idempotent.
 * @route   POST /api/menus/migrate-content-menu-library
 * @access  Private (Admin)
 */
exports.migrateContentMenuLibrary = async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Only administrators can run menu migration'
      });
    }

    const cleared = await Menu.updateMany(
      { route: '/app/content', 'queryParams.view': 'published' },
      { $unset: { queryParams: 1 } }
    );

    const relabeled = await Menu.updateMany(
      { route: '/app/content', label: 'Published' },
      { $set: { label: 'Content', icon: 'fas fa-folder-open' } }
    );

    res.status(200).json({
      success: true,
      message: 'Content menu opens platform library; RepMeUp published is available from the Content page tab.',
      data: {
        clearedPublishedQueryParam: cleared.modifiedCount,
        relabeledPublishedToContent: relabeled.modifiedCount
      }
    });
  } catch (error) {
    console.error('migrateContentMenuLibrary error:', error);
    next(error);
  }
};
