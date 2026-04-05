const Menu = require('../models/Menu');
const { DEFAULT_SUBMENU_PACKS } = require('../config/defaultMenuSubmenus');

const MENU_LIST_DEFAULT_PAGE = 1;
const MENU_LIST_DEFAULT_LIMIT = 20;
const MENU_LIST_MAX_LIMIT = 100;

function parseMenuListPagination(query) {
  const page = Math.max(1, parseInt(query.page, 10) || MENU_LIST_DEFAULT_PAGE);
  let limit = parseInt(query.limit, 10) || MENU_LIST_DEFAULT_LIMIT;
  limit = Math.min(Math.max(1, limit), MENU_LIST_MAX_LIMIT);
  return { page, limit, skip: (page - 1) * limit };
}

function normalizeMenuSearch(val) {
  if (val == null) return '';
  const s = String(val).trim();
  if (s === '' || s === 'undefined' || s === 'null') return '';
  return s;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseQueryParams(body) {
  if (body.queryParams == null || body.queryParams === '') return undefined;
  if (typeof body.queryParams === 'object' && !Array.isArray(body.queryParams)) {
    return Object.keys(body.queryParams).length ? body.queryParams : undefined;
  }
  if (typeof body.queryParams === 'string') {
    const t = body.queryParams.trim();
    if (!t) return undefined;
    try {
      const o = JSON.parse(t);
      return typeof o === 'object' && o !== null ? o : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function sanitizeMenuPayload(body, { partial = false } = {}) {
  const allowed = [
    'label',
    'icon',
    'route',
    'order',
    'isActive',
    'group',
    'parentId',
    'description',
    'tooltip',
    'requiredRoles',
    'requiredPermissions',
    'requiresFeature',
    'badge'
  ];
  const out = {};
  for (const k of allowed) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  const qp = parseQueryParams(body);
  if (qp !== undefined) out.queryParams = qp;
  if (partial && out.queryParams === undefined && body.queryParams === '') {
    out.queryParams = undefined;
  }
  return out;
}

async function deleteMenuCascade(id) {
  const kids = await Menu.find({ parentId: id }).select('_id').lean();
  for (const k of kids) {
    await deleteMenuCascade(k._id);
  }
  await Menu.findByIdAndDelete(id);
}

/**
 * GET /api/super-admin/menus
 * Query: page, limit, search (matches label, route, group, icon, description)
 */
exports.listAllMenus = async (req, res, next) => {
  try {
    const { page, limit, skip } = parseMenuListPagination(req.query);
    const search = normalizeMenuSearch(req.query.search);

    const filter = {};
    if (search) {
      const safe = escapeRegex(search);
      const re = new RegExp(safe, 'i');
      filter.$or = [
        { label: re },
        { route: re },
        { group: re },
        { icon: re },
        { description: re }
      ];
    }

    const [total, items] = await Promise.all([
      Menu.countDocuments(filter),
      Menu.find(filter).sort({ group: 1, order: 1, label: 1 }).skip(skip).limit(limit).lean()
    ]);

    const parentIds = [...new Set(items.map((m) => m.parentId).filter(Boolean))];
    let parentById = new Map();
    if (parentIds.length) {
      const parents = await Menu.find({ _id: { $in: parentIds } }).select('label').lean();
      parentById = new Map(parents.map((p) => [String(p._id), p]));
    }

    const enriched = items.map((m) => ({
      ...m,
      parentLabel: m.parentId ? parentById.get(String(m.parentId))?.label || '—' : null
    }));

    res.status(200).json({
      success: true,
      data: {
        items: enriched,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit) || 0
        }
      }
    });
  } catch (e) {
    next(e);
  }
};

/**
 * GET /api/super-admin/menus/parent-options
 * All top-level menus for create/edit parent dropdown (not paginated).
 */
exports.listTopLevelParentOptions = async (req, res, next) => {
  try {
    const items = await Menu.find({
      $or: [{ parentId: null }, { parentId: { $exists: false } }]
    })
      .select('_id label icon order group')
      .sort({ group: 1, order: 1, label: 1 })
      .lean();
    res.status(200).json({ success: true, data: { items } });
  } catch (e) {
    next(e);
  }
};

/**
 * POST /api/super-admin/menus
 */
exports.createMenu = async (req, res, next) => {
  try {
    const payload = sanitizeMenuPayload(req.body);
    if (!payload.label || !payload.icon || !payload.route) {
      return res.status(400).json({
        success: false,
        error: 'label, icon, and route are required'
      });
    }
    if (payload.parentId) {
      const p = await Menu.findById(payload.parentId);
      if (!p) {
        return res.status(400).json({ success: false, error: 'parentId not found' });
      }
      if (!payload.group) payload.group = p.group;
    }
    if (!payload.group) payload.group = 'main';
    const menu = await Menu.create(payload);
    res.status(201).json({ success: true, data: menu });
  } catch (e) {
    next(e);
  }
};

/**
 * PUT /api/super-admin/menus/:id
 */
exports.updateMenu = async (req, res, next) => {
  try {
    const clearQueryParams =
      Object.prototype.hasOwnProperty.call(req.body, 'queryParams') &&
      (req.body.queryParams === '' || req.body.queryParams === null);

    const payload = sanitizeMenuPayload(req.body, { partial: true });

    if (payload.parentId && String(payload.parentId) === String(req.params.id)) {
      return res.status(400).json({ success: false, error: 'Menu cannot be its own parent' });
    }

    let menu;
    if (clearQueryParams) {
      delete payload.queryParams;
      const op =
        Object.keys(payload).length > 0
          ? { $set: payload, $unset: { queryParams: 1 } }
          : { $unset: { queryParams: 1 } };
      menu = await Menu.findByIdAndUpdate(req.params.id, op, { new: true, runValidators: true });
    } else {
      menu = await Menu.findByIdAndUpdate(req.params.id, payload, {
        new: true,
        runValidators: true
      });
    }

    if (!menu) {
      return res.status(404).json({ success: false, error: 'Menu not found' });
    }
    res.status(200).json({ success: true, data: menu });
  } catch (e) {
    next(e);
  }
};

/**
 * DELETE /api/super-admin/menus/:id
 */
exports.deleteMenu = async (req, res, next) => {
  try {
    const menu = await Menu.findById(req.params.id);
    if (!menu) {
      return res.status(404).json({ success: false, error: 'Menu not found' });
    }
    await deleteMenuCascade(req.params.id);
    res.status(200).json({ success: true, message: 'Menu deleted (including submenus)' });
  } catch (e) {
    next(e);
  }
};

/**
 * POST /api/super-admin/menus/bootstrap-defaults
 * Inserts default children for Publish / Analytics / Settings when parent exists and has zero children.
 */
exports.bootstrapDefaultSubmenus = async (req, res, next) => {
  try {
    const summary = [];

    for (const pack of DEFAULT_SUBMENU_PACKS) {
      const parent = await Menu.findOne({
        route: pack.parentRoute,
        $or: [{ parentId: null }, { parentId: { $exists: false } }]
      }).lean();

      if (!parent) {
        summary.push({ parentRoute: pack.parentRoute, status: 'skipped', reason: 'parent not found' });
        continue;
      }

      const existing = await Menu.countDocuments({ parentId: parent._id });
      if (existing > 0) {
        summary.push({ parentRoute: pack.parentRoute, status: 'skipped', reason: 'already has children', existing });
        continue;
      }

      const docs = pack.children.map((c) => ({
        ...c,
        group: parent.group || 'main',
        parentId: parent._id,
        isActive: true
      }));

      const created = await Menu.insertMany(docs);
      summary.push({ parentRoute: pack.parentRoute, status: 'created', count: created.length });
    }

    res.status(200).json({ success: true, data: { summary } });
  } catch (e) {
    next(e);
  }
};
