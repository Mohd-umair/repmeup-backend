'use strict';

const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const ContactFilterPreset = require('../models/ContactFilterPreset');
const ContactNote = require('../models/ContactNote');
const ContactTask = require('../models/ContactTask');
const Team = require('../models/Team');
const User = require('../models/User');
const logger = require('../config/logger');
const { listContacts, countContacts, findContactIds } = require('../services/contactQueryService');
const { listForContact, record } = require('../services/contactActivityService');
const customFieldService = require('../services/customFieldService');
const { mergeContacts } = require('../services/mergeService');
const duplicateDetectionService = require('../services/duplicateDetectionService');
const { segmentTag } = duplicateDetectionService;
const { computeForContact, generateSummary } = require('../services/contactIntelligenceService');
const { computeAndStore } = require('../services/nextBestActionService');
const { listOrders } = require('../services/commerceMetricsService');
const { maxRecipientsPerCampaign } = require('../config/campaignConfig');

const CONTACT_IMPORT_MAX_ROWS = 20000;
const CONTACT_IMPORT_MAX_BYTES = 10 * 1024 * 1024;

function orgIdOf(req) {
  return req.user.organization._id || req.user.organization;
}

function parseFilterQuery(bodyOrQuery) {
  if (!bodyOrQuery) return null;
  if (typeof bodyOrQuery.filterQuery === 'string') {
    try { return JSON.parse(bodyOrQuery.filterQuery); } catch { return null; }
  }
  return bodyOrQuery.filterQuery || null;
}

function isObjectId(value) {
  return mongoose.Types.ObjectId.isValid(value);
}

function badRequest(res, error) {
  return res.status(400).json({ success: false, error });
}

async function contactExists(orgId, contactId) {
  if (!isObjectId(contactId)) return false;
  return Boolean(await Contact.exists({ _id: contactId, organization: orgId, isDeleted: false }));
}

async function orgUserExists(orgId, userId) {
  if (!isObjectId(userId)) return false;
  return Boolean(await User.exists({ _id: userId, organization: orgId, isActive: { $ne: false } }));
}

exports.listContacts = async (req, res, next) => {
  try {
    const allowedSort = ['lastInteractionAt', 'createdAt', 'primaryName', 'lifecycleStage', 'healthScore', 'leadScore', 'engagementScore', 'totalSpent'];
    const sortField = allowedSort.includes(req.query.sortField) ? req.query.sortField : undefined;
    const sortDir = req.query.sortDir === 'asc' ? 'asc' : undefined;
    const result = await listContacts({
      orgId: orgIdOf(req),
      search: req.query.search,
      filterQuery: parseFilterQuery(req.query) || parseFilterQuery(req.body),
      platform: req.query.platform,
      tag: req.query.tag,
      lifecycleStage: req.query.lifecycleStage,
      owner: req.query.owner,
      page: req.query.page,
      limit: req.query.limit,
      sortField,
      sortDir: sortDir || (sortField ? 'desc' : undefined)
    });
    return res.json({ success: true, data: result.contacts, pagination: result.pagination });
  } catch (error) {
    logger.error('listContacts error', { error: error.message });
    next(error);
  }
};

exports.filterPreview = async (req, res, next) => {
  try {
    const total = await countContacts({
      orgId: orgIdOf(req),
      search: req.body.search,
      filterQuery: req.body.filterQuery
    });
    return res.json({ success: true, data: { total } });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, error: error.message });
    next(error);
  }
};

exports.getContact360 = async (req, res, next) => {
  try {
    const orgId = orgIdOf(req);
    const contact = await Contact.findOne({ _id: req.params.id, organization: orgId, isDeleted: false })
      .populate('owner', 'firstName lastName email')
      .lean();
    if (!contact) return res.status(404).json({ success: false, error: 'Contact not found' });
    return res.json({ success: true, data: contact });
  } catch (error) {
    next(error);
  }
};

exports.updateContact = async (req, res, next) => {
  try {
    const orgId = orgIdOf(req);
    if (!isObjectId(req.params.id)) return badRequest(res, 'Invalid contact id');
    const contact = await Contact.findOne({ _id: req.params.id, organization: orgId, isDeleted: false });
    if (!contact) return res.status(404).json({ success: false, error: 'Contact not found' });
    if (req.body.owner && !(await orgUserExists(orgId, req.body.owner))) {
      return badRequest(res, 'Owner must be an active user in this organization');
    }
    if (req.body.team && !(await Team.exists({ _id: req.body.team, organization: orgId }))) {
      return badRequest(res, 'Team does not belong to this organization');
    }
    if (req.body.customFields !== undefined) {
      req.body.customFields = await customFieldService.validateContactValues(orgId, req.body.customFields);
    }
    if (req.body.tags !== undefined) {
      if (!Array.isArray(req.body.tags)) return badRequest(res, 'tags must be an array');
      req.body.tags = [...new Set(
        req.body.tags.slice(0, 100).map((tag) => String(tag).trim().slice(0, 80)).filter(Boolean)
      )];
    }
    const lifecycleStages = new Set(['lead', 'engaged', 'qualified', 'customer', 'repeat_customer', 'vip', 'at_risk', 'churned']);
    if (req.body.lifecycleStage !== undefined && !lifecycleStages.has(req.body.lifecycleStage)) {
      return badRequest(res, 'Invalid lifecycle stage');
    }
    if (req.body.communicationPreferences !== undefined) {
      const allowedPreferences = ['whatsapp', 'sms', 'email', 'instagram', 'facebook', 'marketingConsent', 'doNotContact'];
      const preferences = {};
      for (const key of allowedPreferences) {
        if (req.body.communicationPreferences[key] !== undefined) {
          if (typeof req.body.communicationPreferences[key] !== 'boolean') {
            return badRequest(res, `${key} must be true or false`);
          }
          preferences[key] = req.body.communicationPreferences[key];
        }
      }
      req.body.communicationPreferences = {
        ...(contact?.communicationPreferences?.toObject?.() || {}),
        ...preferences
      };
    }
    const fields = [
      'primaryName', 'primaryPhone', 'primaryEmail', 'notes', 'tags', 'company',
      'lifecycleStage', 'owner', 'team', 'customFields', 'communicationPreferences'
    ];
    for (const key of fields) {
      if (req.body[key] !== undefined) contact[key] = req.body[key];
    }
    await contact.save();
    return res.json({ success: true, data: contact });
  } catch (error) {
    next(error);
  }
};

exports.listPresets = async (req, res, next) => {
  try {
    const kind = req.query.kind;
    const q = { organization: orgIdOf(req) };
    if (kind) q.kind = kind;
    const items = await ContactFilterPreset.find(q).sort({ isSystem: -1, name: 1 }).lean();
    return res.json({ success: true, data: items });
  } catch (error) {
    next(error);
  }
};

exports.createPreset = async (req, res, next) => {
  try {
    if (!String(req.body.name || '').trim()) return badRequest(res, 'Name is required');
    // Compile once on write so malformed/unsafe DSL never gets persisted.
    require('../services/contactFilterCompilerService').compileFilterQuery(req.body.filterQuery);
    const doc = await ContactFilterPreset.create({
      organization: orgIdOf(req),
      kind: req.body.kind || 'saved_view',
      name: req.body.name,
      description: req.body.description || '',
      filterQuery: req.body.filterQuery || { logic: 'AND', conditions: [] },
      sort: req.body.sort,
      columns: req.body.columns,
      color: req.body.color,
      icon: req.body.icon,
      createdBy: req.user._id
    });
    return res.status(201).json({ success: true, data: doc });
  } catch (error) {
    next(error);
  }
};

exports.updatePreset = async (req, res, next) => {
  try {
    if (req.body.filterQuery) {
      require('../services/contactFilterCompilerService').compileFilterQuery(req.body.filterQuery);
    }
    const doc = await ContactFilterPreset.findOne({ _id: req.params.id, organization: orgIdOf(req) });
    if (!doc) return res.status(404).json({ success: false, error: 'Not found' });
    ['name', 'description', 'filterQuery', 'sort', 'columns', 'color', 'icon'].forEach((k) => {
      if (req.body[k] !== undefined) doc[k] = req.body[k];
    });
    await doc.save();
    return res.json({ success: true, data: doc });
  } catch (error) {
    next(error);
  }
};

exports.deletePreset = async (req, res, next) => {
  try {
    await ContactFilterPreset.deleteOne({ _id: req.params.id, organization: orgIdOf(req), isSystem: false });
    return res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

exports.listTags = async (req, res, next) => {
  try {
    const rows = await Contact.aggregate([
      { $match: { organization: orgIdOf(req), isDeleted: false } },
      { $unwind: '$tags' },
      { $group: { _id: '$tags', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 200 }
    ]);
    return res.json({ success: true, data: rows.map((r) => ({ tag: r._id, count: r.count })) });
  } catch (error) {
    next(error);
  }
};

exports.resolveCampaignAudience = async (req, res, next) => {
  try {
    const orgId = orgIdOf(req);
    const cap = maxRecipientsPerCampaign;
    const body = req.body || {};
    let ids = [];

    if (Array.isArray(body.contactIds) && body.contactIds.length) {
      ids = body.contactIds
        .filter((id) => isObjectId(id))
        .slice(0, cap);
    } else {
      const filterQuery = body.filterQuery || parseFilterQuery(body);
      const hasFilter = filterQuery?.conditions?.length || body.search || body.platform || body.tag;
      if (!hasFilter) {
        return badRequest(res, 'Provide contactIds or filter criteria for the campaign audience.');
      }
      ids = await findContactIds({
        orgId,
        filterQuery,
        search: body.search,
        extra: {
          ...(body.platform ? { 'channels.platform': body.platform } : {}),
          ...(body.tag ? { tags: body.tag } : {})
        },
        limit: cap + 1
      });
      if (ids.length > cap) {
        return badRequest(res, `Audience exceeds the ${cap.toLocaleString()} recipient limit per campaign. Narrow your filters.`);
      }
    }

    if (!ids.length) {
      return res.json({
        success: true,
        data: { lines: [], total: 0, skippedNoPhone: 0, requested: 0 }
      });
    }

    const contacts = await Contact.find({
      _id: { $in: ids },
      organization: orgId,
      isDeleted: false
    })
      .select('primaryName primaryPhone')
      .lean();

    const byId = new Map(contacts.map((c) => [String(c._id), c]));
    const lines = [];
    let skippedNoPhone = 0;

    for (const id of ids) {
      const c = byId.get(String(id));
      if (!c) continue;
      const phone = String(c.primaryPhone || '').trim();
      if (!phone) {
        skippedNoPhone += 1;
        continue;
      }
      const name = String(c.primaryName || '').trim();
      lines.push({
        phone,
        name: name && name !== 'Unknown' ? name : ''
      });
    }

    return res.json({
      success: true,
      data: {
        lines,
        total: lines.length,
        skippedNoPhone,
        requested: ids.length
      }
    });
  } catch (error) {
    next(error);
  }
};

exports.bulkAction = async (req, res, next) => {
  try {
    const orgId = orgIdOf(req);
    const { action, params = {}, contactIds, filterQuery } = req.body;
    const hasIds = Array.isArray(contactIds) && contactIds.length > 0;
    const hasFilter = filterQuery && Array.isArray(filterQuery.conditions) && filterQuery.conditions.length > 0;
    if (!hasIds && !hasFilter) return badRequest(res, 'Select contacts or provide a non-empty filter');
    if (action === 'assign' && !(await orgUserExists(orgId, params.owner))) {
      return badRequest(res, 'Owner must be an active user in this organization');
    }
    const lifecycleStages = new Set(['lead', 'engaged', 'qualified', 'customer', 'repeat_customer', 'vip', 'at_risk', 'churned']);
    if (action === 'lifecycle' && !lifecycleStages.has(params.lifecycleStage)) {
      return badRequest(res, 'Invalid lifecycle stage');
    }
    if (['add_tag', 'remove_tag'].includes(action)) {
      params.tag = String(params.tag || '').trim().slice(0, 80);
      if (!params.tag) return badRequest(res, 'Tag is required');
    }
    const ids = await findContactIds({ orgId, filterQuery, contactIds, limit: 10001 });
    if (!ids.length) return res.json({ success: true, data: { updated: 0 } });
    if (ids.length > 10000) return badRequest(res, 'Bulk actions are limited to 10,000 contacts at a time');

    if (action === 'add_tag' && params.tag) {
      await Contact.updateMany({ _id: { $in: ids }, organization: orgId }, { $addToSet: { tags: params.tag } });
    } else if (action === 'remove_tag' && params.tag) {
      await Contact.updateMany({ _id: { $in: ids }, organization: orgId }, { $pull: { tags: params.tag } });
    } else if (action === 'assign' && params.owner) {
      await Contact.updateMany({ _id: { $in: ids }, organization: orgId }, { $set: { owner: params.owner } });
    } else if (action === 'lifecycle' && params.lifecycleStage) {
      await Contact.updateMany({ _id: { $in: ids }, organization: orgId }, { $set: { lifecycleStage: params.lifecycleStage } });
    } else if (action === 'add_to_segment' && params.segmentId) {
      const preset = await ContactFilterPreset.findOne({ _id: params.segmentId, organization: orgId, kind: 'segment' });
      if (!preset) return badRequest(res, 'Segment not found');
      const tag = segmentTag(preset._id);
      await Contact.updateMany({ _id: { $in: ids }, organization: orgId }, { $addToSet: { tags: tag } });
      preset.memberCountCached = await Contact.countDocuments({
        organization: orgId,
        isDeleted: false,
        tags: tag
      });
      preset.lastEvaluatedAt = new Date();
      await preset.save();
    } else {
      return res.status(400).json({ success: false, error: 'Unknown bulk action' });
    }
    return res.json({ success: true, data: { updated: ids.length } });
  } catch (error) {
    next(error);
  }
};

exports.exportContacts = async (req, res, next) => {
  try {
    const orgId = orgIdOf(req);
    const ids = await findContactIds({
      orgId,
      filterQuery: parseFilterQuery(req.query),
      search: req.query.search,
      limit: 5000,
      extra: {
        ...(req.query.platform ? { 'channels.platform': req.query.platform } : {}),
        ...(req.query.tag ? { tags: req.query.tag } : {})
      }
    });
    const contacts = await Contact.find({ _id: { $in: ids }, organization: orgId })
      .select('primaryName primaryPhone primaryEmail lifecycleStage tags lastInteractionAt')
      .lean();
    const header = 'name,phone,email,lifecycle,tags,lastSeen';
    const rows = contacts.map((c) => [
      csv(c.primaryName),
      csv(c.primaryPhone),
      csv(c.primaryEmail),
      csv(c.lifecycleStage),
      csv((c.tags || []).join('|')),
      csv(c.lastInteractionAt)
    ].join(','));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
    return res.send([header, ...rows].join('\n'));
  } catch (error) {
    next(error);
  }
};

function csv(v) {
  let s = v == null ? '' : String(v);
  // Prevent spreadsheet formula execution when an exported CSV is opened.
  if (/^[\t\r ]*[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

exports.importContacts = async (req, res, next) => {
  try {
    const {
      validateImportMapping,
      pickRowValue,
      normalizePhone
    } = require('../utils/contactImportMapping');

    let rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    let headers = [];
    if (typeof req.body.csvText === 'string') {
      if (Buffer.byteLength(req.body.csvText, 'utf8') > CONTACT_IMPORT_MAX_BYTES) {
        return badRequest(res, 'CSV file must be 10 MB or smaller');
      }
      const parsed = require('../utils/csvParser').parseCsv(req.body.csvText, { hasHeader: true });
      headers = parsed.headers;
      rows = parsed.rows.map((values) => Object.fromEntries(
        parsed.headers.map((header, index) => [header, values[index] || ''])
      ));
    } else if (rows.length) {
      headers = Object.keys(rows[0]);
    }
    if (!rows.length) return badRequest(res, 'No rows supplied');
    if (rows.length > CONTACT_IMPORT_MAX_ROWS) {
      return badRequest(res, `A maximum of ${CONTACT_IMPORT_MAX_ROWS.toLocaleString()} rows is allowed per import`);
    }

    const validated = validateImportMapping(headers, req.body.mapping || {});
    if (validated.error) return badRequest(res, validated.error);
    const mapping = validated.mapping;

    const orgId = orgIdOf(req);
    let imported = 0;
    let updated = 0;
    let failed = 0;
    const failures = [];
    const normalized = [];
    for (const row of rows) {
      const name = String(
        pickRowValue(row, mapping.first_name) || pickRowValue(row, mapping.name) || 'Unknown'
      ).trim().slice(0, 120);
      const phone = normalizePhone(pickRowValue(row, mapping.phone));
      const email = String(pickRowValue(row, mapping.email) || '').trim().toLowerCase() || null;
      if (!phone && !email) {
        failed += 1;
        failures.push({ row, reason: 'Missing phone and email' });
        continue;
      }
      normalized.push({ name, phone, email, row });
    }
    for (let i = 0; i < normalized.length; i += 200) {
      const chunk = normalized.slice(i, i + 200);
      const phones = chunk.map((item) => item.phone).filter(Boolean);
      const emails = chunk.map((item) => item.email).filter(Boolean);
      const existing = await Contact.find({
        organization: orgId,
        isDeleted: false,
        $or: [
          phones.length ? { primaryPhone: { $in: phones } } : null,
          emails.length ? { primaryEmail: { $in: emails } } : null
        ].filter(Boolean)
      }).select('primaryName primaryPhone primaryEmail').lean();
      const byPhone = new Map(existing.filter((c) => c.primaryPhone).map((c) => [c.primaryPhone, c]));
      const byEmail = new Map(existing.filter((c) => c.primaryEmail).map((c) => [c.primaryEmail, c]));
      const inserts = [];
      const updates = [];
      for (const item of chunk) {
        const match = (item.phone && byPhone.get(item.phone)) || (item.email && byEmail.get(item.email));
        if (match) {
          const set = {};
          if (item.name && match.primaryName === 'Unknown') set.primaryName = item.name;
          if (item.phone && !match.primaryPhone) set.primaryPhone = item.phone;
          if (item.email && !match.primaryEmail) set.primaryEmail = item.email;
          if (Object.keys(set).length) updates.push({ _id: match._id, set });
          updated += 1;
        } else {
          inserts.push({
            organization: orgId,
            primaryName: item.name,
            primaryPhone: item.phone,
            primaryEmail: item.email,
            source: { channel: 'import', firstTouchAt: new Date() }
          });
          imported += 1;
        }
      }
      if (inserts.length) {
        try {
          await Contact.insertMany(inserts, { ordered: false });
        } catch (err) {
          failed += inserts.length;
          imported -= inserts.length;
          failures.push({ reason: err.message });
        }
      }
      if (updates.length) {
        await Contact.bulkWrite(updates.map((item) => ({
          updateOne: { filter: { _id: item._id, organization: orgId }, update: { $set: item.set } }
        })), { ordered: false });
      }
    }
    return res.json({
      success: true,
      data: {
        imported,
        updated,
        failed,
        mapping,
        failures: failures.slice(0, 50)
      }
    });
  } catch (error) {
    next(error);
  }
};

exports.listNotes = async (req, res, next) => {
  try {
    if (!(await contactExists(orgIdOf(req), req.params.id))) {
      return res.status(404).json({ success: false, error: 'Contact not found' });
    }
    const items = await ContactNote.find({ organization: orgIdOf(req), contact: req.params.id })
      .populate('author', 'firstName lastName')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    return res.json({ success: true, data: items });
  } catch (error) {
    next(error);
  }
};

exports.addNote = async (req, res, next) => {
  try {
    const orgId = orgIdOf(req);
    if (!(await contactExists(orgId, req.params.id))) {
      return res.status(404).json({ success: false, error: 'Contact not found' });
    }
    const body = String(req.body.body || '').trim();
    if (!body) return badRequest(res, 'Note body is required');
    const mentions = Array.isArray(req.body.mentions) ? req.body.mentions.slice(0, 50) : [];
    const validMentionCount = await User.countDocuments({
      _id: { $in: mentions.filter(isObjectId) },
      organization: orgId
    });
    if (validMentionCount !== mentions.length) return badRequest(res, 'One or more mentions are invalid');
    const note = await ContactNote.create({
      organization: orgId,
      contact: req.params.id,
      author: req.user._id,
      body,
      mentions
    });
    await record({
      organization: orgId,
      contact: req.params.id,
      type: 'note_added',
      actor: { kind: 'user', ref: req.user._id },
      payload: { preview: String(req.body.body || '').slice(0, 80) }
    });
    return res.status(201).json({ success: true, data: note });
  } catch (error) {
    next(error);
  }
};

exports.listTasks = async (req, res, next) => {
  try {
    if (!(await contactExists(orgIdOf(req), req.params.id))) {
      return res.status(404).json({ success: false, error: 'Contact not found' });
    }
    const items = await ContactTask.find({ organization: orgIdOf(req), contact: req.params.id })
      .populate('owner', 'firstName lastName')
      .sort({ dueDate: 1, createdAt: -1 })
      .limit(100)
      .lean();
    return res.json({ success: true, data: items });
  } catch (error) {
    next(error);
  }
};

exports.addTask = async (req, res, next) => {
  try {
    const orgId = orgIdOf(req);
    if (!(await contactExists(orgId, req.params.id))) {
      return res.status(404).json({ success: false, error: 'Contact not found' });
    }
    const owner = req.body.owner || req.user._id;
    if (!(await orgUserExists(orgId, owner))) return badRequest(res, 'Invalid task owner');
    const task = await ContactTask.create({
      organization: orgId,
      contact: req.params.id,
      title: req.body.title,
      description: req.body.description || '',
      owner,
      dueDate: req.body.dueDate || null,
      priority: req.body.priority || 'medium',
      createdBy: req.user._id
    });
    await record({
      organization: orgId,
      contact: req.params.id,
      type: 'task_created',
      actor: { kind: 'user', ref: req.user._id },
      payload: { title: task.title }
    });
    return res.status(201).json({ success: true, data: task });
  } catch (error) {
    next(error);
  }
};

exports.updateTask = async (req, res, next) => {
  try {
    const orgId = orgIdOf(req);
    if (req.body.owner && !(await orgUserExists(orgId, req.body.owner))) {
      return badRequest(res, 'Invalid task owner');
    }
    const task = await ContactTask.findOne({
      _id: req.params.taskId,
      contact: req.params.id,
      organization: orgId
    });
    if (!task) return res.status(404).json({ success: false, error: 'Task not found' });
    ['title', 'description', 'owner', 'dueDate', 'priority', 'status'].forEach((k) => {
      if (req.body[k] !== undefined) task[k] = req.body[k];
    });
    if (task.status === 'done' && !task.completedAt) task.completedAt = new Date();
    await task.save();
    return res.json({ success: true, data: task });
  } catch (error) {
    next(error);
  }
};

exports.listActivity = async (req, res, next) => {
  try {
    if (!(await contactExists(orgIdOf(req), req.params.id))) {
      return res.status(404).json({ success: false, error: 'Contact not found' });
    }
    const data = await listForContact({ orgId: orgIdOf(req), contactId: req.params.id, page: req.query.page, limit: req.query.limit });
    return res.json({ success: true, data: data.items, pagination: data.pagination });
  } catch (error) {
    next(error);
  }
};

exports.listCustomFields = async (req, res, next) => {
  try {
    return res.json({ success: true, data: await customFieldService.list(orgIdOf(req)) });
  } catch (error) {
    next(error);
  }
};

exports.createCustomField = async (req, res, next) => {
  try {
    return res.status(201).json({ success: true, data: await customFieldService.create(orgIdOf(req), req.body) });
  } catch (error) {
    next(error);
  }
};

exports.updateCustomField = async (req, res, next) => {
  try {
    const doc = await customFieldService.update(orgIdOf(req), req.params.id, req.body);
    if (!doc) return res.status(404).json({ success: false, error: 'Not found' });
    return res.json({ success: true, data: doc });
  } catch (error) {
    next(error);
  }
};

exports.deleteCustomField = async (req, res, next) => {
  try {
    await customFieldService.remove(orgIdOf(req), req.params.id);
    return res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

exports.mergeById = async (req, res, next) => {
  try {
    const data = await mergeContacts({
      orgId: orgIdOf(req),
      userId: req.user._id,
      primaryId: req.params.id,
      secondaryId: req.body.secondaryId,
      fieldResolutions: req.body.fieldResolutions || {}
    });
    return res.json({ success: true, data });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, error: error.message });
    next(error);
  }
};

exports.listDuplicates = async (req, res, next) => {
  try {
    const data = await duplicateDetectionService.listPending(orgIdOf(req), req.query);
    return res.json({ success: true, data: data.items, pagination: data.pagination });
  } catch (error) {
    next(error);
  }
};

exports.scanDuplicates = async (req, res, next) => {
  try {
    const orgId = orgIdOf(req);
    const { duplicateScanQueue } = require('../config/queue');
    await duplicateScanQueue.add(
      { organizationId: String(orgId) },
      { jobId: `duplicate-scan:${orgId}`, removeOnComplete: 10 }
    );
    return res.status(202).json({ success: true, data: { queued: true } });
  } catch (error) {
    next(error);
  }
};

exports.dismissDuplicate = async (req, res, next) => {
  try {
    const data = await duplicateDetectionService.dismiss(orgIdOf(req), req.params.id, req.user._id);
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

exports.listTeams = async (req, res, next) => {
  try {
    return res.json({ success: true, data: await Team.find({ organization: orgIdOf(req) }).lean() });
  } catch (error) {
    next(error);
  }
};

exports.createTeam = async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 80);
    if (!name) return badRequest(res, 'Team name is required');
    const memberUserIds = Array.isArray(req.body.memberUserIds)
      ? req.body.memberUserIds.filter(isObjectId).slice(0, 100)
      : [];
    if (memberUserIds.length) {
      const valid = await User.countDocuments({ _id: { $in: memberUserIds }, organization: orgIdOf(req) });
      if (valid !== memberUserIds.length) return badRequest(res, 'Team members must belong to this organization');
    }
    const team = await Team.create({ organization: orgIdOf(req), name, memberUserIds });
    return res.status(201).json({ success: true, data: team });
  } catch (error) {
    next(error);
  }
};

exports.listOwners = async (req, res, next) => {
  try {
    const users = await User.find({ organization: orgIdOf(req), isActive: { $ne: false } })
      .select('firstName lastName email role')
      .limit(100)
      .lean();
    return res.json({ success: true, data: users });
  } catch (error) {
    next(error);
  }
};

exports.recomputeIntelligence = async (req, res, next) => {
  try {
    const scores = await computeForContact(orgIdOf(req), req.params.id);
    const nba = await computeAndStore(orgIdOf(req), req.params.id);
    return res.json({ success: true, data: { scores, nextBestAction: nba } });
  } catch (error) {
    next(error);
  }
};

exports.generateSummary = async (req, res, next) => {
  try {
    const summary = await generateSummary(orgIdOf(req), req.params.id);
    return res.json({ success: true, data: { summary } });
  } catch (error) {
    next(error);
  }
};

exports.listOrders = async (req, res, next) => {
  try {
    const data = await listOrders(orgIdOf(req), req.params.id, req.query);
    return res.json({ success: true, data: data.items, pagination: data.pagination });
  } catch (error) {
    next(error);
  }
};

exports.seedSystemViews = async (req, res, next) => {
  try {
    const orgId = orgIdOf(req);
    const defaults = [
      { name: 'My Leads', kind: 'saved_view', filterQuery: { logic: 'AND', conditions: [{ field: 'lifecycle', operator: 'eq', value: 'lead' }] } },
      { name: 'My Customers', kind: 'saved_view', filterQuery: { logic: 'AND', conditions: [{ field: 'lifecycle', operator: 'in', value: ['customer', 'repeat_customer', 'vip'] }] } },
      { name: 'VIP Customers', kind: 'saved_view', filterQuery: { logic: 'AND', conditions: [{ field: 'lifecycle', operator: 'eq', value: 'vip' }] } },
      { name: 'Negative Sentiment', kind: 'saved_view', filterQuery: { logic: 'AND', conditions: [{ field: 'sentiment', operator: 'eq', value: 'negative' }] } },
      { name: 'Unassigned', kind: 'saved_view', filterQuery: { logic: 'AND', conditions: [{ field: 'owner', operator: 'exists', value: false }] } }
    ];
    for (const d of defaults) {
      await ContactFilterPreset.updateOne(
        { organization: orgId, kind: d.kind, name: d.name },
        { $setOnInsert: { ...d, organization: orgId, isSystem: true } },
        { upsert: true }
      );
    }
    return res.json({ success: true });
  } catch (error) {
    next(error);
  }
};
