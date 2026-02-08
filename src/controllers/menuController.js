const Menu = require('../models/Menu');

/**
 * @desc    Get user's accessible menus
 * @route   GET /api/menus
 * @access  Private
 */
exports.getMenus = async (req, res, next) => {
  try {
    const user = req.user;
    
    console.log('🔍 [Menu] User requesting menus:', {
      email: user.email,
      role: user.role,
      permissions: user.permissions
    });

    // Fetch all active menus
    const allMenus = await Menu.find({ isActive: true })
      .sort({ group: 1, order: 1 })
      .lean();
    
    console.log(`📋 [Menu] Found ${allMenus.length} active menus in database`);

    // Filter menus based on user permissions
    const accessibleMenus = allMenus.filter(menu => {
      // Check role requirements
      if (menu.requiredRoles && menu.requiredRoles.length > 0) {
        if (!menu.requiredRoles.includes(user.role)) {
          console.log(`❌ [Menu] ${menu.label} - Role '${user.role}' not in required roles: [${menu.requiredRoles.join(', ')}]`);
          return false;
        }
      }

      // Check permission requirements
      if (menu.requiredPermissions && menu.requiredPermissions.length > 0) {
        if (!user.permissions || !Array.isArray(user.permissions)) {
          return false;
        }

        const hasAllPermissions = menu.requiredPermissions.every(
          permission => user.permissions.includes(permission)
        );

        if (!hasAllPermissions) {
          return false;
        }
      }

      console.log(`✅ [Menu] ${menu.label} - Accessible`);
      return true;
    });
    
    console.log(`✅ [Menu] User has access to ${accessibleMenus.length} menus`);

    // Group menus by group
    const groupedMenus = {
      main: [],
      management: [],
      settings: []
    };

    accessibleMenus.forEach(menu => {
      if (groupedMenus[menu.group]) {
        groupedMenus[menu.group].push(menu);
      }
    });

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
        label: 'Publish',
        icon: '✈️',
        route: '/app/publish',
        order: 4,
        group: 'main',
        requiredRoles: ['admin', 'manager', 'agent']
      },
      {
        label: 'Knowledge Base',
        icon: '🧠',
        route: '/app/knowledge-base',
        order: 5,
        group: 'main',
        requiredRoles: ['admin', 'manager'],
        requiresFeature: 'knowledge_base'
      },
      {
        label: 'Analytics',
        icon: '📈',
        route: '/app/analytics',
        order: 6,
        group: 'main',
        requiredRoles: ['admin', 'manager'],
        requiresFeature: 'analytics'
      },
      {
        label: 'Agents',
        icon: '👥',
        route: '/app/agents',
        order: 7,
        group: 'management',
        requiredRoles: ['admin', 'manager'],
        requiresFeature: 'agents'
      },
      {
        label: 'Settings',
        icon: '⚙️',
        route: '/app/settings',
        order: 8,
        group: 'settings',
        requiredRoles: ['admin', 'manager']
      }
    ];

    const menus = await Menu.insertMany(defaultMenus);

    res.status(201).json({
      success: true,
      data: menus,
      message: `${menus.length} menus seeded successfully`
    });
  } catch (error) {
    console.error('Seed menus error:', error);
    next(error);
  }
};
