const mongoose = require('mongoose');
const Group = require('../models/Group');
const Permission = require('../models/Permission');
const User = require('../models/User');

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parsePagination(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || DEFAULT_PAGE);
  let limit = parseInt(query.limit, 10) || DEFAULT_LIMIT;
  limit = Math.min(Math.max(1, limit), MAX_LIMIT);
  return { page, limit, skip: (page - 1) * limit };
}

function makeError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function roleForSystemGroupSlug(slug) {
  const map = {
    'super-admin': 'super_admin',
    'admin': 'admin',
    'manager': 'manager',
    'agent': 'agent',
    'viewer': 'viewer'
  };
  return map[slug] || null;
}

class GroupPermissionService {

  // ─── Permissions ───

  async listPermissions(query = {}) {
    const { page, limit, skip } = parsePagination(query);
    const filter = {};
    if (query.category) filter.category = query.category;
    if (query.isActive !== undefined) filter.isActive = query.isActive === 'true';

    const [total, items] = await Promise.all([
      Permission.countDocuments(filter),
      Permission.find(filter)
        .sort({ category: 1, code: 1 })
        .skip(skip)
        .limit(limit)
        .lean()
    ]);

    return {
      items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 0 }
    };
  }

  async getPermissionById(id) {
    if (!mongoose.Types.ObjectId.isValid(id)) throw makeError('Invalid permission id', 400);
    const perm = await Permission.findById(id).lean();
    if (!perm) throw makeError('Permission not found', 404);
    return perm;
  }

  async createPermission(body) {
    const { name, code, description, category, actions } = body;
    if (!name || !code || !category) {
      throw makeError('name, code, and category are required', 400);
    }

    const existing = await Permission.findOne({ $or: [{ code }, { name }] });
    if (existing) throw makeError('Permission with this name or code already exists', 400);

    return Permission.create({
      name: name.trim(),
      code: code.trim().toLowerCase(),
      description: (description || '').trim(),
      category,
      actions: actions || ['read']
    });
  }

  async updatePermission(id, body) {
    if (!mongoose.Types.ObjectId.isValid(id)) throw makeError('Invalid permission id', 400);
    const perm = await Permission.findById(id);
    if (!perm) throw makeError('Permission not found', 404);

    if (body.name !== undefined) perm.name = body.name.trim();
    if (body.description !== undefined) perm.description = body.description.trim();
    if (body.category !== undefined) perm.category = body.category;
    if (body.actions !== undefined) perm.actions = body.actions;
    if (body.isActive !== undefined) perm.isActive = body.isActive;

    await perm.save();
    return perm.toObject();
  }

  async deletePermission(id) {
    if (!mongoose.Types.ObjectId.isValid(id)) throw makeError('Invalid permission id', 400);
    const perm = await Permission.findById(id);
    if (!perm) throw makeError('Permission not found', 404);

    const groupCount = await Group.countDocuments({ permissions: id });
    if (groupCount > 0) {
      throw makeError(
        `Cannot delete: permission is used by ${groupCount} group(s). Remove from groups first.`,
        400
      );
    }

    await Permission.deleteOne({ _id: id });
    return { deleted: true };
  }

  async getPermissionMeta() {
    return {
      categories: Permission.CATEGORIES,
      actions: Permission.ACTIONS
    };
  }

  // ─── Groups ───

  async listGroups(query = {}) {
    const { page, limit, skip } = parsePagination(query);
    const filter = {};
    if (query.isActive !== undefined) filter.isActive = query.isActive === 'true';

    const [total, items] = await Promise.all([
      Group.countDocuments(filter),
      Group.find(filter)
        .populate('permissions', 'name code category actions')
        .populate('createdBy', 'email firstName lastName')
        .sort({ isSystem: -1, name: 1 })
        .skip(skip)
        .limit(limit)
        .lean()
    ]);

    const userCounts = await User.aggregate([
      { $match: { group: { $in: items.map(g => g._id) }, deletedAt: null } },
      { $group: { _id: '$group', count: { $sum: 1 } } }
    ]);
    const countMap = {};
    userCounts.forEach(r => { countMap[String(r._id)] = r.count; });

    // Include legacy users who still use role-only assignment (group is null).
    for (const g of items) {
      if (!g.isSystem) continue;
      const legacyRole = roleForSystemGroupSlug(g.slug);
      if (!legacyRole) continue;
      const legacyCount = await User.countDocuments({
        role: legacyRole,
        deletedAt: null,
        $or: [{ group: null }, { group: { $exists: false } }]
      });
      countMap[String(g._id)] = (countMap[String(g._id)] || 0) + legacyCount;
    }

    const enriched = items.map(g => ({
      ...g,
      userCount: countMap[String(g._id)] || 0
    }));

    return {
      items: enriched,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 0 }
    };
  }

  async getGroupById(id) {
    if (!mongoose.Types.ObjectId.isValid(id)) throw makeError('Invalid group id', 400);
    const group = await Group.findById(id)
      .populate('permissions', 'name code category actions description')
      .populate('createdBy', 'email firstName lastName')
      .lean();
    if (!group) throw makeError('Group not found', 404);

    let userCount = await User.countDocuments({ group: id, deletedAt: null });
    if (group.isSystem) {
      const legacyRole = roleForSystemGroupSlug(group.slug);
      if (legacyRole) {
        const legacyCount = await User.countDocuments({
          role: legacyRole,
          deletedAt: null,
          $or: [{ group: null }, { group: { $exists: false } }]
        });
        userCount += legacyCount;
      }
    }
    return { ...group, userCount };
  }

  async createGroup(body, actorId) {
    const { name, description, permissions } = body;
    if (!name) throw makeError('Group name is required', 400);

    const slug = slugify(name);
    const existing = await Group.findOne({ slug });
    if (existing) throw makeError('A group with this name already exists', 400);

    if (permissions && permissions.length > 0) {
      const validCount = await Permission.countDocuments({
        _id: { $in: permissions },
        isActive: true
      });
      if (validCount !== permissions.length) {
        throw makeError('One or more permission IDs are invalid or inactive', 400);
      }
    }

    const group = await Group.create({
      name: name.trim(),
      slug,
      description: (description || '').trim(),
      permissions: permissions || [],
      createdBy: actorId,
      isSystem: false
    });

    return Group.findById(group._id)
      .populate('permissions', 'name code category actions')
      .populate('createdBy', 'email firstName lastName')
      .lean();
  }

  async updateGroup(id, body) {
    if (!mongoose.Types.ObjectId.isValid(id)) throw makeError('Invalid group id', 400);
    const group = await Group.findById(id);
    if (!group) throw makeError('Group not found', 404);

    if (body.name !== undefined) {
      group.name = body.name.trim();
      group.slug = slugify(body.name);
      const conflict = await Group.findOne({ slug: group.slug, _id: { $ne: id } });
      if (conflict) throw makeError('A group with this name already exists', 400);
    }
    if (body.description !== undefined) group.description = body.description.trim();
    if (body.isActive !== undefined) group.isActive = body.isActive;

    if (body.permissions !== undefined) {
      if (body.permissions.length > 0) {
        const validCount = await Permission.countDocuments({
          _id: { $in: body.permissions },
          isActive: true
        });
        if (validCount !== body.permissions.length) {
          throw makeError('One or more permission IDs are invalid or inactive', 400);
        }
      }
      group.permissions = body.permissions;
    }

    await group.save();
    return Group.findById(id)
      .populate('permissions', 'name code category actions')
      .populate('createdBy', 'email firstName lastName')
      .lean();
  }

  async deleteGroup(id) {
    if (!mongoose.Types.ObjectId.isValid(id)) throw makeError('Invalid group id', 400);
    const group = await Group.findById(id);
    if (!group) throw makeError('Group not found', 404);
    if (group.isSystem) throw makeError('System groups cannot be deleted', 400);

    const userCount = await User.countDocuments({ group: id, deletedAt: null });
    if (userCount > 0) {
      throw makeError(
        `Cannot delete: ${userCount} user(s) are assigned to this group. Reassign them first.`,
        400
      );
    }

    await Group.deleteOne({ _id: id });
    return { deleted: true };
  }

  // ─── User-Group Assignment ───

  async assignGroupToUser(userId, groupId) {
    if (!mongoose.Types.ObjectId.isValid(userId)) throw makeError('Invalid user id', 400);

    if (groupId) {
      if (!mongoose.Types.ObjectId.isValid(groupId)) throw makeError('Invalid group id', 400);
      const group = await Group.findById(groupId);
      if (!group || !group.isActive) throw makeError('Group not found or inactive', 400);
    }

    const user = await User.findById(userId);
    if (!user) throw makeError('User not found', 404);

    user.group = groupId || null;
    await user.save();

    return User.findById(userId)
      .select('email firstName lastName role group')
      .populate('group', 'name slug')
      .lean();
  }

  // ─── Seed Default Permissions ───

  async seedDefaultPermissions() {
    const defaults = [
      { name: 'View Inbox', code: 'inbox.read', category: 'inbox', actions: ['read'] },
      { name: 'Reply to Messages', code: 'inbox.reply', category: 'inbox', actions: ['create'] },
      { name: 'Assign Conversations', code: 'inbox.assign', category: 'inbox', actions: ['assign'] },
      { name: 'Archive Conversations', code: 'inbox.archive', category: 'inbox', actions: ['update'] },
      { name: 'Delete Conversations', code: 'inbox.delete', category: 'inbox', actions: ['delete'] },

      { name: 'View Analytics', code: 'analytics.read', category: 'analytics', actions: ['read'] },
      { name: 'Export Reports', code: 'analytics.export', category: 'analytics', actions: ['export'] },

      { name: 'View Users', code: 'users.read', category: 'users', actions: ['read'] },
      { name: 'Create Users', code: 'users.create', category: 'users', actions: ['create'] },
      { name: 'Edit Users', code: 'users.update', category: 'users', actions: ['update'] },
      { name: 'Delete Users', code: 'users.delete', category: 'users', actions: ['delete'] },

      { name: 'View Settings', code: 'settings.read', category: 'settings', actions: ['read'] },
      { name: 'Edit Settings', code: 'settings.update', category: 'settings', actions: ['update'] },

      { name: 'Connect Platforms', code: 'integrations.connect', category: 'integrations', actions: ['create'] },
      { name: 'Disconnect Platforms', code: 'integrations.disconnect', category: 'integrations', actions: ['delete'] },
      { name: 'Manage Integrations', code: 'integrations.manage', category: 'integrations', actions: ['manage'] },

      { name: 'View Knowledge Base', code: 'knowledge_base.read', category: 'knowledge_base', actions: ['read'] },
      { name: 'Create KB Entries', code: 'knowledge_base.create', category: 'knowledge_base', actions: ['create'] },
      { name: 'Edit KB Entries', code: 'knowledge_base.update', category: 'knowledge_base', actions: ['update'] },
      { name: 'Delete KB Entries', code: 'knowledge_base.delete', category: 'knowledge_base', actions: ['delete'] },

      { name: 'View Posts', code: 'posts.read', category: 'posts', actions: ['read'] },
      { name: 'Create Posts', code: 'posts.create', category: 'posts', actions: ['create'] },
      { name: 'Edit Posts', code: 'posts.update', category: 'posts', actions: ['update'] },
      { name: 'Delete Posts', code: 'posts.delete', category: 'posts', actions: ['delete'] },
      { name: 'Publish Posts', code: 'posts.publish', category: 'posts', actions: ['manage'] },

      { name: 'Upload Media', code: 'media.upload', category: 'media', actions: ['create'] },
      { name: 'View Media', code: 'media.read', category: 'media', actions: ['read'] },
      { name: 'Delete Media', code: 'media.delete', category: 'media', actions: ['delete'] },

      { name: 'View Organization', code: 'organization.read', category: 'organization', actions: ['read'] },
      { name: 'Edit Organization', code: 'organization.update', category: 'organization', actions: ['update'] },

      { name: 'View Billing', code: 'billing.read', category: 'billing', actions: ['read'] },
      { name: 'Manage Billing', code: 'billing.manage', category: 'billing', actions: ['manage'] }
    ];

    let created = 0;
    let skipped = 0;
    for (const def of defaults) {
      const exists = await Permission.findOne({ code: def.code });
      if (exists) { skipped++; continue; }
      await Permission.create(def);
      created++;
    }

    return { created, skipped, total: defaults.length };
  }

  async seedDefaultGroups() {
    const allPerms = await Permission.find({ isActive: true }).lean();
    const permsByCode = {};
    allPerms.forEach(p => { permsByCode[p.code] = p._id; });

    const groupDefs = [
      {
        name: 'Super Admin',
        slug: 'super-admin',
        description: 'Full unrestricted access to all platform features',
        permissionCodes: Object.keys(permsByCode),
        isSystem: true
      },
      {
        name: 'Admin',
        slug: 'admin',
        description: 'Full access except billing management',
        permissionCodes: Object.keys(permsByCode).filter(c => !c.startsWith('billing.manage')),
        isSystem: true
      },
      {
        name: 'Manager',
        slug: 'manager',
        description: 'Manage inbox, posts, analytics, and knowledge base',
        permissionCodes: [
          'inbox.read', 'inbox.reply', 'inbox.assign', 'inbox.archive',
          'analytics.read', 'analytics.export',
          'posts.read', 'posts.create', 'posts.update', 'posts.publish',
          'media.upload', 'media.read',
          'knowledge_base.read', 'knowledge_base.create', 'knowledge_base.update',
          'settings.read', 'organization.read'
        ],
        isSystem: true
      },
      {
        name: 'Agent',
        slug: 'agent',
        description: 'Handle inbox conversations and view analytics',
        permissionCodes: [
          'inbox.read', 'inbox.reply',
          'analytics.read',
          'knowledge_base.read',
          'media.read',
          'posts.read',
          'settings.read'
        ],
        isSystem: true
      },
      {
        name: 'Viewer',
        slug: 'viewer',
        description: 'Read-only access across the platform',
        permissionCodes: [
          'inbox.read', 'analytics.read', 'knowledge_base.read',
          'media.read', 'posts.read', 'settings.read', 'organization.read'
        ],
        isSystem: true
      }
    ];

    let created = 0;
    let skipped = 0;
    for (const def of groupDefs) {
      const exists = await Group.findOne({ slug: def.slug });
      if (exists) { skipped++; continue; }
      const permIds = def.permissionCodes
        .map(code => permsByCode[code])
        .filter(Boolean);
      await Group.create({
        name: def.name,
        slug: def.slug,
        description: def.description,
        permissions: permIds,
        isSystem: def.isSystem
      });
      created++;
    }

    return { created, skipped, total: groupDefs.length };
  }
}

module.exports = new GroupPermissionService();
