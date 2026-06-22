'use strict';

/**
 * Appointment Controller
 *
 * Thin HTTP layer over appointmentService + availabilityService, plus lightweight
 * CRUD for the Service and Provider catalogs. Mirrors commerceOrderController.
 */

const appointmentService = require('../services/appointment/appointmentService');
const availabilityService = require('../services/appointment/availabilityService');
const Service = require('../models/Service');
const Provider = require('../models/Provider');
const logger = require('../config/logger');

function orgId(req) {
  return req.user.organization._id;
}

function fail(res, code, error, hint) {
  return res.status(code).json({ success: false, error, ...(hint && { hint }) });
}

// ── Appointments ─────────────────────────────────────────────────────────────

exports.listAppointments = async (req, res, next) => {
  try {
    const data = await appointmentService.listAppointments(orgId(req), req.query);
    res.json({ success: true, data: data.rows, pagination: { total: data.total, page: data.page, limit: data.limit } });
  } catch (err) { next(err); }
};

exports.getStats = async (req, res, next) => {
  try {
    res.json({ success: true, data: await appointmentService.getStats(orgId(req)) });
  } catch (err) { next(err); }
};

exports.getAppointment = async (req, res, next) => {
  try {
    const appt = await appointmentService.getDetail(orgId(req), req.params.id);
    if (!appt) return fail(res, 404, 'Appointment not found');
    res.json({ success: true, data: appt });
  } catch (err) { next(err); }
};

exports.getByInteraction = async (req, res, next) => {
  try {
    const ref = await appointmentService.getByInteraction(orgId(req), req.params.interactionId);
    res.json({ success: true, data: ref });
  } catch (err) { next(err); }
};

exports.createAppointment = async (req, res, next) => {
  try {
    const result = await appointmentService.createAppointment(orgId(req), req.body);
    if (result.error) {
      const code = result.error === 'slot_taken' ? 409 : 422;
      return fail(res, code, result.error);
    }
    res.status(201).json({ success: true, data: result.appointment });
  } catch (err) { next(err); }
};

exports.updateStatus = async (req, res, next) => {
  try {
    const { status, ...extra } = req.body || {};
    if (!status) return fail(res, 400, 'status is required');
    const result = await appointmentService.updateStatus(orgId(req), req.params.id, status, extra);
    if (result.error) return fail(res, result.error === 'not_found' ? 404 : 422, result.error);
    res.json({ success: true, data: result.appointment });
  } catch (err) { next(err); }
};

exports.reschedule = async (req, res, next) => {
  try {
    const result = await appointmentService.reschedule(orgId(req), req.params.id, req.body);
    if (result.error) {
      const code = result.error === 'not_found' ? 404 : result.error === 'slot_taken' ? 409 : 422;
      return fail(res, code, result.error);
    }
    res.json({ success: true, data: result.appointment });
  } catch (err) { next(err); }
};

exports.cancelAppointment = async (req, res, next) => {
  try {
    const reason = req.body?.reason || req.query?.reason;
    const result = await appointmentService.updateStatus(orgId(req), req.params.id, 'cancelled', { reason });
    if (result.error) return fail(res, result.error === 'not_found' ? 404 : 422, result.error);
    res.json({ success: true, data: result.appointment });
  } catch (err) { next(err); }
};

// ── Availability ─────────────────────────────────────────────────────────────

exports.getAvailability = async (req, res, next) => {
  try {
    const { serviceId, providerId, from, days, limitPerDay } = req.query;
    if (!serviceId) return fail(res, 400, 'serviceId is required');
    const result = await availabilityService.getAvailableSlots({
      orgId: orgId(req),
      serviceId,
      providerId: providerId || undefined,
      from: from || undefined,
      days: days ? Number(days) : undefined,
      limitPerDay: limitPerDay ? Number(limitPerDay) : undefined
    });
    if (result.error) return fail(res, result.error === 'service_not_found' ? 404 : 422, result.error);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
};

// ── Services CRUD ────────────────────────────────────────────────────────────

exports.listServices = async (req, res, next) => {
  try {
    const filter = { organization: orgId(req) };
    if (req.query.active !== 'all') filter.isActive = true;
    const services = await Service.find(filter).sort({ name: 1 }).lean();
    res.json({ success: true, data: services });
  } catch (err) { next(err); }
};

exports.createService = async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.name) return fail(res, 400, 'name is required');
    const service = await Service.create({
      organization: orgId(req),
      name: b.name, description: b.description, category: b.category,
      durationMin: b.durationMin, bufferBeforeMin: b.bufferBeforeMin, bufferAfterMin: b.bufferAfterMin,
      price: b.price, currency: b.currency, providers: b.providers, color: b.color,
      isActive: b.isActive !== false
    });
    res.status(201).json({ success: true, data: service });
  } catch (err) { next(err); }
};

exports.updateService = async (req, res, next) => {
  try {
    const allowed = ['name', 'description', 'category', 'durationMin', 'bufferBeforeMin',
      'bufferAfterMin', 'price', 'currency', 'providers', 'color', 'isActive'];
    const update = {};
    for (const k of allowed) if (req.body[k] !== undefined) update[k] = req.body[k];
    const service = await Service.findOneAndUpdate(
      { _id: req.params.id, organization: orgId(req) }, { $set: update }, { new: true }
    ).lean();
    if (!service) return fail(res, 404, 'Service not found');
    res.json({ success: true, data: service });
  } catch (err) { next(err); }
};

exports.deleteService = async (req, res, next) => {
  try {
    // Soft-delete to preserve historical appointment snapshots.
    const service = await Service.findOneAndUpdate(
      { _id: req.params.id, organization: orgId(req) }, { $set: { isActive: false } }, { new: true }
    ).lean();
    if (!service) return fail(res, 404, 'Service not found');
    res.json({ success: true, data: { id: service._id, isActive: service.isActive } });
  } catch (err) { next(err); }
};

// ── Providers CRUD ───────────────────────────────────────────────────────────

exports.listProviders = async (req, res, next) => {
  try {
    const filter = { organization: orgId(req) };
    if (req.query.active !== 'all') filter.isActive = true;
    if (req.query.serviceId) filter.services = req.query.serviceId;
    const providers = await Provider.find(filter).select('-google.accessToken -google.refreshToken').sort({ name: 1 }).lean();
    res.json({ success: true, data: providers });
  } catch (err) { next(err); }
};

exports.createProvider = async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.name) return fail(res, 400, 'name is required');
    const provider = await Provider.create({
      organization: orgId(req),
      name: b.name, email: b.email, phone: b.phone, title: b.title, avatarUrl: b.avatarUrl,
      services: b.services, timezone: b.timezone, weeklyAvailability: b.weeklyAvailability,
      timeOff: b.timeOff, user: b.user, isActive: b.isActive !== false
    });
    const safe = provider.toObject(); delete safe.google;
    res.status(201).json({ success: true, data: safe });
  } catch (err) { next(err); }
};

exports.updateProvider = async (req, res, next) => {
  try {
    const allowed = ['name', 'email', 'phone', 'title', 'avatarUrl', 'services', 'timezone',
      'weeklyAvailability', 'timeOff', 'user', 'isActive'];
    const update = {};
    for (const k of allowed) if (req.body[k] !== undefined) update[k] = req.body[k];
    const provider = await Provider.findOneAndUpdate(
      { _id: req.params.id, organization: orgId(req) }, { $set: update }, { new: true }
    ).select('-google.accessToken -google.refreshToken').lean();
    if (!provider) return fail(res, 404, 'Provider not found');
    res.json({ success: true, data: provider });
  } catch (err) { next(err); }
};

exports.deleteProvider = async (req, res, next) => {
  try {
    const provider = await Provider.findOneAndUpdate(
      { _id: req.params.id, organization: orgId(req) }, { $set: { isActive: false } }, { new: true }
    ).lean();
    if (!provider) return fail(res, 404, 'Provider not found');
    res.json({ success: true, data: { id: provider._id, isActive: provider.isActive } });
  } catch (err) { next(err); }
};

// ── Provider Google Calendar sync ────────────────────────────────────────────

exports.connectProviderGoogle = async (req, res, next) => {
  try {
    const provider = await Provider.findOne({ _id: req.params.id, organization: orgId(req) }).select('_id').lean();
    if (!provider) return fail(res, 404, 'Provider not found');
    const gcal = require('../integrations/google/googleCalendarService');
    res.json({ success: true, data: { authUrl: gcal.getConnectUrl(orgId(req), req.params.id) } });
  } catch (err) { next(err); }
};

exports.disconnectProviderGoogle = async (req, res, next) => {
  try {
    const gcal = require('../integrations/google/googleCalendarService');
    await gcal.disconnect(orgId(req), req.params.id);
    res.json({ success: true });
  } catch (err) { next(err); }
};

/** PUBLIC — Google redirects here after the provider grants Calendar access. */
exports.providerGoogleCallback = async (req, res) => {
  const fe = process.env.FRONTEND_URL || 'http://localhost:4200';
  const back = (q) => res.redirect(`${fe}/app/appointments/providers?${q}`);
  try {
    const { code, state, error } = req.query;
    if (error || !code || !state) return back(`gcal_error=${encodeURIComponent(error || 'missing_code')}`);
    const gcal = require('../integrations/google/googleCalendarService');
    const r = await gcal.handleCallback(code, state);
    return back(`gcal_connected=true&provider=${encodeURIComponent(r.name || '')}`);
  } catch (err) {
    logger.warn('[appointments] google callback failed', { error: err.message });
    return back(`gcal_error=${encodeURIComponent(err.message)}`);
  }
};
