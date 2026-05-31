'use strict';

const complaintOps = require('../../../../src/services/inbox/inboxComplaintOpsService');

const ORG = 'org_test_1';

describe('inboxComplaintOpsService — pure helpers', () => {
  describe('buildComplaintFilter', () => {
    test('requires complaint.displayRef', () => {
      expect(complaintOps.buildComplaintFilter(ORG, {})).toEqual({
        organization: ORG,
        'complaint.displayRef': { $exists: true, $ne: null }
      });
    });

    test('tab maps to complaint.status', () => {
      const filter = complaintOps.buildComplaintFilter(ORG, { tab: 'open' });
      expect(filter['complaint.status']).toBe('open');
    });

    test('priority and channel filters', () => {
      const filter = complaintOps.buildComplaintFilter(ORG, {
        priority: 'high',
        channel: 'instagram'
      });
      expect(filter['complaint.priority']).toBe('high');
      expect(filter.platform).toBe('instagram');
    });
  });

  describe('acknowledgedLabel', () => {
    test('returns No when not acknowledged', () => {
      const result = complaintOps.acknowledgedLabel({});
      expect(result.label).toBe('No');
      expect(result.tone).toBe('danger');
    });

    test('returns Yes with SLA minutes', () => {
      const raised = new Date('2026-05-20T10:00:00Z');
      const ack = new Date('2026-05-20T10:14:00Z');
      const result = complaintOps.acknowledgedLabel({
        acknowledgedAt: ack,
        slaAckMinutes: 14,
        timeline: [{ at: raised }]
      });
      expect(result.label).toBe('Yes · 14 min');
      expect(result.tone).toBe('success');
    });
  });

  describe('mapComplaintRow', () => {
    test('maps complaint list row DTO', () => {
      const row = complaintOps.mapComplaintRow({
        _id: { toString: () => 'cmp1' },
        platform: 'whatsapp',
        content: 'My order is late',
        author: { name: 'John', username: '+971501111111' },
        platformCreatedAt: new Date('2026-05-20T09:00:00Z'),
        complaint: {
          displayRef: 'CMP-0041',
          issueSummary: 'Late delivery',
          status: 'open',
          priority: 'high'
        }
      });

      expect(row.displayRef).toBe('CMP-0041');
      expect(row.customerName).toBe('John');
      expect(row.channelLabel).toBe('WhatsApp');
      expect(row.issueSummary).toBe('Late delivery');
      expect(row.priority).toBe('high');
      expect(row.acknowledgedLabel).toBe('No');
      expect(row.chatDeepLink).toBe('/app/inbox?selected=cmp1');
    });
  });
});
