/**
 * Allows access to Super Admin Panel APIs for platform operators.
 * Aligns with admin Angular guard: super_admin OR admin.
 */
const PANEL_ROLES = ['super_admin', 'admin'];

exports.requireSuperAdminAccess = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: 'Not authorized'
    });
  }

  if (!PANEL_ROLES.includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      error: 'Super admin access required'
    });
  }

  next();
};
