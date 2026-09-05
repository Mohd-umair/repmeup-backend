/**
 * Allows access to Super Admin Panel APIs for platform operators ONLY.
 *
 * SECURITY: this must be `super_admin` exclusively. The tenant-level role
 * `admin` is assigned to the first user of EVERY organization at signup
 * (see authService.register), so including it here would let any customer
 * reach the platform-wide super-admin APIs (list all orgs, reveal any
 * password, impersonate any user). Platform operators are provisioned as
 * `super_admin` via scripts/createSuperAdmin.js.
 */
const PANEL_ROLES = ['super_admin'];

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
