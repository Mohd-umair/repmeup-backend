const User = require('../models/User');

/** Same roles as manual inbox assignment (`getAvailableAgents`). */
const ASSIGNABLE_ROLES = ['admin', 'manager', 'agent'];

/**
 * Resolve ordered user documents for escalation / AI pool auto-assignment.
 * When `escalationSettings.availableAgents` is non-empty, order follows that list
 * (inactive or missing users are omitted).
 * Otherwise: all active org members with admin, manager, or agent role.
 *
 * @param {import('mongoose').Document} organization - Organization document with `_id` and `escalationSettings`
 * @returns {Promise<import('mongoose').Document[]>}
 */
async function resolveEscalationAssignmentUsers(organization) {
  const orgId = organization._id;
  const configured = organization.escalationSettings?.availableAgents || [];

  if (configured.length > 0) {
    const users = await User.find({
      _id: { $in: configured },
      organization: orgId,
      isActive: true,
      deletedAt: null
    });

    const byId = new Map(users.map((u) => [u._id.toString(), u]));
    return configured.map((id) => byId.get(id.toString())).filter(Boolean);
  }

  return User.find({
    organization: orgId,
    role: { $in: ASSIGNABLE_ROLES },
    isActive: true,
    deletedAt: null
  }).sort({ role: 1, firstName: 1, lastName: 1 });
}

module.exports = {
  ASSIGNABLE_ROLES,
  resolveEscalationAssignmentUsers
};
