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
  const byParent = new Map();
  accessibleMenus.forEach((m) => {
    if (!m.parentId) return;
    const pid = menuIdStr(m.parentId);
    if (!byParent.has(pid)) byParent.set(pid, []);
    byParent.get(pid).push(m);
  });
  byParent.forEach((arr) => arr.sort((a, b) => (a.order || 0) - (b.order || 0)));

  const topLevel = accessibleMenus.filter((m) => !m.parentId);

  const enriched = topLevel.map((parent) => {
    const kids = byParent.get(menuIdStr(parent._id)) || [];
    if (kids.length === 0) return { ...parent };
    return { ...parent, children: kids };
  });

  const groupedMenus = { main: [], management: [], settings: [] };
  enriched.forEach((menu) => {
    if (groupedMenus[menu.group]) {
      groupedMenus[menu.group].push(menu);
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
        if (!menu.requiredRoles.includes(user.role)) {
          return false;
        }
      }

      if (menu.requiredPermissions && menu.requiredPermissions.length > 0) {
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
        icon: '🏠',
        route: '/',
        order: 1,
        group: 'main',
        requiredRoles: []
      },
      {
        label: 'Dashboard',
        icon: '📊',
        route: '/app/dashboard',
        order: 2,
        group: 'main',
        requiredRoles: ['admin', 'manager', 'agent']
      },
      {
        label: 'Inbox',
        icon: '📥',
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
        label: 'Content',
        icon: '📄',
        route: '/app/content',
        order: 5,
        group: 'main',
        requiredRoles: ['admin', 'manager', 'agent']
      },
      {
        label: 'Knowledge Base',
        icon: '🧠',
        route: '/app/knowledge-base',
        order: 6,
        group: 'main',
        requiredRoles: ['admin', 'manager'],
        requiresFeature: 'knowledge_base'
      },
      {
        label: 'Analytics',
        icon: '📈',
        route: '/app/analytics',
        order: 7,
        group: 'main',
        requiredRoles: ['admin', 'manager'],
        requiresFeature: 'analytics'
      },
      {
        label: 'Agents',
        icon: '👥',
        route: '/app/agents',
        order: 8,
        group: 'management',
        requiredRoles: ['admin', 'manager'],
        requiresFeature: 'agents'
      },
      {
        label: 'Settings',
        icon: '⚙️',
        route: '/app/settings',
        order: 9,
        group: 'settings',
        requiredRoles: ['admin', 'manager']
      }
    ];

    const inserted = await Menu.insertMany(defaultMenus);

    const publishParent = await Menu.create({
      label: 'Publish',
      icon: '✈️',
      route: '/app/publish',
      order: 4,
      group: 'main',
      requiredRoles: ['admin', 'manager', 'agent'],
      requiredPermissions: []
    });

    const publishChildren = await Menu.insertMany([
      {
        label: 'Create',
        icon: '✏️',
        route: '/app/publish',
        order: 1,
        group: 'main',
        parentId: publishParent._id,
        requiredRoles: ['admin', 'manager', 'agent'],
        requiredPermissions: ['posts.create']
      },
      {
        label: 'Calendar',
        icon: '📅',
        route: '/app/publish/calendar',
        order: 2,
        group: 'main',
        parentId: publishParent._id,
        requiredRoles: ['admin', 'manager', 'agent'],
        requiredPermissions: ['posts.read']
      },
      {
        label: 'Published',
        icon: '📋',
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
        icon: '✏️',
        route: '/app/publish',
        order: 1,
        group: 'main',
        parentId: publishParent._id,
        requiredRoles: ['admin', 'manager', 'agent'],
        requiredPermissions: ['posts.create']
      },
      {
        label: 'Calendar',
        icon: '📅',
        route: '/app/publish/calendar',
        order: 2,
        group: 'main',
        parentId: publishParent._id,
        requiredRoles: ['admin', 'manager', 'agent'],
        requiredPermissions: ['posts.read']
      },
      {
        label: 'Published',
        icon: '📋',
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
