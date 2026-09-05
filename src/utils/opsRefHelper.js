'use strict';

const Organization = require('../models/Organization');

const REF_PREFIX = Object.freeze({
  order: 'ORD',
  complaint: 'CMP',
  review: 'REV',
  appointment: 'APT'
});

const COUNTER_FIELD = Object.freeze({
  order: 'orderCounter',
  complaint: 'complaintCounter',
  review: 'reviewCounter',
  appointment: 'appointmentCounter'
});

/**
 * Atomically increment org counter and return a display reference (e.g. ORD-2847).
 * @param {string|import('mongoose').Types.ObjectId} organizationId
 * @param {'order'|'complaint'|'review'} kind
 * @returns {Promise<{ number: number, displayRef: string }>}
 */
async function generateOpsRef(organizationId, kind) {
  const field = COUNTER_FIELD[kind];
  const prefix = REF_PREFIX[kind];
  if (!field || !prefix) {
    throw new Error(`generateOpsRef: invalid kind "${kind}"`);
  }

  const org = await Organization.findByIdAndUpdate(
    organizationId,
    { $inc: { [field]: 1 } },
    { new: true, select: `${field} orgCode` }
  ).lean();

  if (!org) {
    throw new Error(`generateOpsRef: organization ${organizationId} not found`);
  }

  const number = org[field] ?? 1;
  return { number, displayRef: `${prefix}-${number}` };
}

/**
 * Assign displayRef to a new CommerceOrder payload (mutates/returns fields to $set).
 */
async function assignOrderDisplayRef(organizationId, orderFields = {}) {
  if (orderFields.displayRef) return orderFields;
  const { number, displayRef } = await generateOpsRef(organizationId, 'order');
  return { ...orderFields, orderNumber: number, displayRef };
}

/**
 * Assign displayRef to a new Appointment payload (e.g. APT-128).
 */
async function assignAppointmentDisplayRef(organizationId, fields = {}) {
  if (fields.displayRef) return fields;
  const { number, displayRef } = await generateOpsRef(organizationId, 'appointment');
  return { ...fields, appointmentNumber: number, displayRef };
}

module.exports = {
  generateOpsRef,
  assignOrderDisplayRef,
  assignAppointmentDisplayRef,
  REF_PREFIX,
  COUNTER_FIELD
};
