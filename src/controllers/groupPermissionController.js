const gpService = require('../services/groupPermissionService');

function handleServiceError(res, next, error) {
  if (error.statusCode) {
    return res.status(error.statusCode).json({ success: false, error: error.message });
  }
  next(error);
}

// ─── Permissions ───

exports.listPermissions = async (req, res, next) => {
  try {
    const data = await gpService.listPermissions(req.query);
    res.json({ success: true, data });
  } catch (error) { handleServiceError(res, next, error); }
};

exports.getPermission = async (req, res, next) => {
  try {
    const data = await gpService.getPermissionById(req.params.id);
    res.json({ success: true, data });
  } catch (error) { handleServiceError(res, next, error); }
};

exports.createPermission = async (req, res, next) => {
  try {
    const data = await gpService.createPermission(req.body);
    res.status(201).json({ success: true, data, message: 'Permission created' });
  } catch (error) { handleServiceError(res, next, error); }
};

exports.updatePermission = async (req, res, next) => {
  try {
    const data = await gpService.updatePermission(req.params.id, req.body);
    res.json({ success: true, data, message: 'Permission updated' });
  } catch (error) { handleServiceError(res, next, error); }
};

exports.deletePermission = async (req, res, next) => {
  try {
    const data = await gpService.deletePermission(req.params.id);
    res.json({ success: true, data, message: 'Permission deleted' });
  } catch (error) { handleServiceError(res, next, error); }
};

exports.getPermissionMeta = async (req, res, next) => {
  try {
    const data = await gpService.getPermissionMeta();
    res.json({ success: true, data });
  } catch (error) { handleServiceError(res, next, error); }
};

// ─── Groups ───

exports.listGroups = async (req, res, next) => {
  try {
    const data = await gpService.listGroups(req.query);
    res.json({ success: true, data });
  } catch (error) { handleServiceError(res, next, error); }
};

exports.getGroup = async (req, res, next) => {
  try {
    const data = await gpService.getGroupById(req.params.id);
    res.json({ success: true, data });
  } catch (error) { handleServiceError(res, next, error); }
};

exports.createGroup = async (req, res, next) => {
  try {
    const data = await gpService.createGroup(req.body, req.user._id);
    res.status(201).json({ success: true, data, message: 'Group created' });
  } catch (error) { handleServiceError(res, next, error); }
};

exports.updateGroup = async (req, res, next) => {
  try {
    const data = await gpService.updateGroup(req.params.id, req.body);
    res.json({ success: true, data, message: 'Group updated' });
  } catch (error) { handleServiceError(res, next, error); }
};

exports.deleteGroup = async (req, res, next) => {
  try {
    const data = await gpService.deleteGroup(req.params.id);
    res.json({ success: true, data, message: 'Group deleted' });
  } catch (error) { handleServiceError(res, next, error); }
};

// ─── User-Group Assignment ───

exports.assignGroupToUser = async (req, res, next) => {
  try {
    const { groupId } = req.body;
    const data = await gpService.assignGroupToUser(req.params.userId, groupId);
    res.json({ success: true, data, message: 'Group assigned' });
  } catch (error) { handleServiceError(res, next, error); }
};

// ─── Seed ───

exports.seedPermissions = async (req, res, next) => {
  try {
    const perms = await gpService.seedDefaultPermissions();
    const groups = await gpService.seedDefaultGroups();
    res.json({
      success: true,
      data: { permissions: perms, groups },
      message: `Seeded ${perms.created} permission(s) and ${groups.created} group(s)`
    });
  } catch (error) { handleServiceError(res, next, error); }
};
