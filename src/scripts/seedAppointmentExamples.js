'use strict';

/**
 * Seed EXAMPLE appointment data for one organization so you can try the feature
 * end-to-end: enables appointmentSettings, creates a few Services + Providers
 * (with working hours), and books a handful of sample Appointments (upcoming +
 * past) across statuses/channels.
 *
 * Idempotent: re-running won't duplicate services/providers (matched by name) and
 * won't add more example appointments once some exist.
 *
 * Usage:
 *   node src/scripts/seedAppointmentExamples.js --org <organizationId>
 *   node src/scripts/seedAppointmentExamples.js                 # uses DEFAULT_ORG
 */

const DEFAULT_ORG = '69e117559f8545939fd331e3';

const ALL_DAYS_10_18 = {
  sunday: { enabled: false, start: '10:00', end: '18:00' },
  monday: { enabled: true, start: '10:00', end: '18:00' },
  tuesday: { enabled: true, start: '10:00', end: '18:00' },
  wednesday: { enabled: true, start: '10:00', end: '18:00' },
  thursday: { enabled: true, start: '10:00', end: '18:00' },
  friday: { enabled: true, start: '10:00', end: '18:00' },
  saturday: { enabled: true, start: '10:00', end: '14:00' }
};

const WEEKDAYS_9_17 = {
  sunday: { enabled: false, start: '09:00', end: '17:00' },
  monday: { enabled: true, start: '09:00', end: '17:00' },
  tuesday: { enabled: true, start: '09:00', end: '17:00' },
  wednesday: { enabled: true, start: '09:00', end: '17:00' },
  thursday: { enabled: true, start: '09:00', end: '17:00' },
  friday: { enabled: true, start: '09:00', end: '17:00' },
  saturday: { enabled: false, start: '09:00', end: '17:00' }
};

const EXAMPLE_SERVICES = [
  { name: 'Dental Checkup', durationMin: 30, price: 500, currency: 'INR', category: 'Dental', bufferAfterMin: 10, color: '#22c55e' },
  { name: 'Teeth Cleaning', durationMin: 45, price: 1200, currency: 'INR', category: 'Dental', bufferAfterMin: 10, color: '#0ea5e9' },
  { name: 'Consultation', durationMin: 20, price: 300, currency: 'INR', category: 'General', color: '#f59e0b' }
];

const EXAMPLE_PROVIDERS = [
  { name: 'Dr. Asha Mehta', title: 'Senior Dentist', email: 'asha@example.com', timezone: 'Asia/Kolkata', weeklyAvailability: ALL_DAYS_10_18 },
  { name: 'Dr. Rohan Verma', title: 'Dentist', email: 'rohan@example.com', timezone: 'Asia/Kolkata', weeklyAvailability: WEEKDAYS_9_17 }
];

/**
 * @param {object} deps  injected models/services (lets us test against any DB)
 */
async function seedAppointmentExamples(orgId, deps) {
  const {
    Organization, Service, Provider, Appointment,
    availabilityService, appointmentService, assignAppointmentDisplayRef
  } = deps;

  const org = await Organization.findById(orgId);
  if (!org) throw new Error(`Organization ${orgId} not found`);

  // 1) Enable appointment settings (don't clobber if already customised).
  org.appointmentSettings = org.appointmentSettings || {};
  if (!org.appointmentSettings.enabled) {
    org.appointmentSettings.enabled = true;
    org.appointmentSettings.aiBookingEnabled = true;
    org.appointmentSettings.slotGranularityMin = org.appointmentSettings.slotGranularityMin || 15;
    org.appointmentSettings.reminderOffsetsMins = org.appointmentSettings.reminderOffsetsMins?.length
      ? org.appointmentSettings.reminderOffsetsMins : [1440, 60];
    org.markModified('appointmentSettings');
    await org.save();
  }

  // 2) Upsert services (match by name within org).
  const serviceByName = {};
  for (const s of EXAMPLE_SERVICES) {
    let doc = await Service.findOne({ organization: orgId, name: s.name });
    if (!doc) doc = await Service.create({ organization: orgId, ...s, isActive: true });
    serviceByName[s.name] = doc;
  }
  const serviceIds = Object.values(serviceByName).map((d) => d._id);

  // 3) Upsert providers (all qualified for all example services).
  const providers = [];
  for (const p of EXAMPLE_PROVIDERS) {
    let doc = await Provider.findOne({ organization: orgId, name: p.name });
    if (!doc) doc = await Provider.create({ organization: orgId, ...p, services: serviceIds, isActive: true });
    else if (!doc.services?.length) { doc.services = serviceIds; await doc.save(); }
    providers.push(doc);
  }

  // 4) Sample appointments — only if none seeded yet.
  const alreadySeeded = await Appointment.exists({ organization: orgId, notes: '[example]' });
  let created = 0;
  if (!alreadySeeded) {
    const customers = [
      { name: 'Riya Sharma', phone: '+919812300011' },
      { name: 'Amit Patel', phone: '+919812300022' },
      { name: 'Neha Gupta', phone: '+919812300033' }
    ];

    // 4a) Upcoming, real bookable slots (validated by the availability engine).
    const checkup = serviceByName['Dental Checkup'];
    const { slots } = await availabilityService.getAvailableSlots({ orgId, serviceId: checkup._id, days: 7, limitPerDay: 2 });
    const channels = ['whatsapp', 'manual', 'instagram'];
    for (let i = 0; i < Math.min(3, slots.length); i++) {
      const slot = slots[i];
      const c = customers[i % customers.length];
      const res = await appointmentService.createAppointment(orgId, {
        channel: channels[i % channels.length],
        serviceId: String(checkup._id),
        providerId: slot.providerId,
        startAt: slot.startAt,
        customerName: c.name,
        customerPhone: c.phone,
        status: i === 0 ? 'requested' : 'confirmed'
      });
      if (!res.error) created++;
    }

    // 4b) A couple of PAST appointments (completed + no-show) for history.
    const cleaning = serviceByName['Teeth Cleaning'];
    const past = [
      { daysAgo: 3, status: 'completed', c: customers[0], svc: cleaning, ch: 'whatsapp' },
      { daysAgo: 6, status: 'no_show', c: customers[1], svc: checkup, ch: 'instagram' }
    ];
    for (const p of past) {
      const provider = providers[0];
      const start = new Date(Date.now() - p.daysAgo * 86400000);
      start.setHours(11, 0, 0, 0);
      const payload = await assignAppointmentDisplayRef(orgId, {
        organization: orgId, channel: p.ch, status: p.status,
        service: p.svc._id,
        serviceSnapshot: { name: p.svc.name, durationMin: p.svc.durationMin, price: p.svc.price, currency: p.svc.currency },
        provider: provider._id, providerSnapshot: { name: provider.name },
        startAt: start, endAt: new Date(start.getTime() + p.svc.durationMin * 60000),
        timezone: 'Asia/Kolkata', customerName: p.c.name, customerPhone: p.c.phone,
        notes: '[example]',
        statusHistory: [
          { status: 'confirmed', at: new Date(start.getTime() - 86400000) },
          { status: p.status, at: start }
        ],
        completedAt: p.status === 'completed' ? start : undefined,
        noShowAt: p.status === 'no_show' ? start : undefined
      });
      await Appointment.create(payload);
      created++;
    }

    // Tag the upcoming ones too so re-runs are detected.
    await Appointment.updateMany(
      { organization: orgId, notes: { $exists: false } , customerPhone: { $in: customers.map((c) => c.phone) } },
      { $set: { notes: '[example]' } }
    );
  }

  return {
    services: Object.keys(serviceByName).length,
    providers: providers.length,
    appointmentsCreated: created,
    appointmentsSkipped: !!alreadySeeded
  };
}

module.exports = { seedAppointmentExamples, EXAMPLE_SERVICES, EXAMPLE_PROVIDERS };

// ── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
  require('dotenv').config();
  const mongoose = require('mongoose');
  const logger = require('../config/logger');

  (async () => {
    const idx = process.argv.indexOf('--org');
    const orgId = (idx !== -1 && process.argv[idx + 1]) || DEFAULT_ORG;
    await mongoose.connect(process.env.MONGODB_URI);
    try {
      const deps = {
        Organization: require('../models/Organization'),
        Service: require('../models/Service'),
        Provider: require('../models/Provider'),
        Appointment: require('../models/Appointment'),
        availabilityService: require('../services/appointment/availabilityService'),
        appointmentService: require('../services/appointment/appointmentService'),
        assignAppointmentDisplayRef: require('../utils/opsRefHelper').assignAppointmentDisplayRef
      };
      const r = await seedAppointmentExamples(orgId, deps);
      console.log(`✓ Seeded examples for org ${orgId}:`, JSON.stringify(r));
      console.log('Open Appointments in the app to see them. (Run once; safe to re-run.)');
    } catch (err) {
      logger.error('[seedAppointmentExamples] failed', { error: err.message });
      console.error('ERROR:', err.message);
      process.exitCode = 1;
    } finally {
      await mongoose.disconnect();
    }
  })();
}
