/**
 * WhatsApp Connection Service
 *
 * Owns the business logic for connecting, disconnecting, and status-checking
 * a WhatsApp Business Cloud API account for an organization.
 *
 * The controller delegates here; it only handles HTTP request parsing and
 * response formatting.
 *
 * Exports:
 *   connectDirect(organizationId, createdBy)  → { connection }  | throws
 *   disconnect(organizationId, connectionId)  → void             | throws
 *   getStatus(organizationId)                 → { isConnected, connection? }
 */

const PlatformConnection = require('../models/PlatformConnection');
const whatsappService = require('../integrations/whatsapp/whatsappService');
const logger = require('../config/logger');

/**
 * Connect WhatsApp using environment credentials (single-tenant / dev fallback).
 * Used when the admin manually connects via WHATSAPP_PHONE_NUMBER_ID in .env.
 *
 * @param {string} organizationId
 * @param {string} createdBy  - User._id who triggered the connect
 * @returns {Promise<{ connection: PlatformConnection }>}
 * @throws {{ status: number, code?: string, error: string, message?: string }}
 */
async function connectDirect(organizationId, createdBy) {
  const verificationResult = await whatsappService.verifyConnection(null);
  if (!verificationResult.success) {
    const err = new Error('Failed to verify WhatsApp connection');
    err.statusCode = 400;
    err.clientMessage = 'Please check your WhatsApp credentials in environment variables';
    throw err;
  }

  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const businessAccountId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;

  const existing = await PlatformConnection.findOne({
    organization: organizationId,
    platform: 'whatsapp',
    isActive: true
  });
  if (existing) {
    const err = new Error('WhatsApp already connected');
    err.statusCode = 400;
    err.clientMessage = 'This organization already has an active WhatsApp connection';
    throw err;
  }

  const crossOrgConflict = await PlatformConnection.findCrossOrgConflict(
    'whatsapp', phoneNumberId, organizationId
  );
  if (crossOrgConflict) {
    const err = new Error('This WhatsApp number is already connected to another workspace.');
    err.statusCode = 409;
    err.code = 'CROSS_ORG_CONFLICT';
    throw err;
  }

  const profileResult = await whatsappService.getBusinessProfile({
    accessToken,
    platformData: { phoneNumberId },
    platformUserId: phoneNumberId
  });
  const profilePic =
    profileResult.profile?.profile_picture_url || null;

  const connection = await PlatformConnection.create({
    organization: organizationId,
    platform: 'whatsapp',
    platformUserId: phoneNumberId,
    platformDisplayName: verificationResult.verifiedName,
    platformProfilePicture: profilePic || undefined,
    accessToken,
    createdBy,
    platformData: {
      phoneNumberId,
      businessAccountId,
      wabaId: businessAccountId,
      displayPhoneNumber: verificationResult.phoneNumber,
      verifiedName: verificationResult.verifiedName,
      qualityRating: verificationResult.qualityRating,
      codeVerificationStatus: verificationResult.codeVerificationStatus,
      businessProfile: profileResult.profile
    },
    metadata: {
      connectionType: 'whatsapp_direct_env',
      profilePicture: profilePic || undefined
    },
    status: 'connected',
    isActive: true
  });

  logger.info('[whatsappConnectionService] Direct connection created', { connectionId: connection._id });
  return { connection };
}

/**
 * Disconnect a WhatsApp connection, unsubscribing its WABA from webhooks first.
 *
 * @param {string} organizationId
 * @param {string|null} connectionId  - Specific connection to disconnect; null = any active one
 * @throws {{ statusCode: 404, error: string }} when not found
 */
async function disconnect(organizationId, connectionId) {
  const query = { organization: organizationId, platform: 'whatsapp', isActive: true };
  if (connectionId) query._id = connectionId;

  const connection = await PlatformConnection.findOne(query);
  if (!connection) {
    const err = new Error('WhatsApp connection not found');
    err.statusCode = 404;
    throw err;
  }

  // Unsubscribe WABA from webhooks before marking disconnected.
  // Both paths are best-effort — a remote failure must not block local cleanup,
  // otherwise a number stays stuck in a workspace it has already left.
  const wabaId = connection.platformData?.wabaId || connection.platformData?.businessAccountId;
  const phoneNumberId = connection.platformData?.phoneNumberId || connection.platformUserId;

  if (connection.platformData?.provider === 'interakt') {
    // Interakt owns the subscription for these numbers; releasing it there also
    // clears the override_callback_uri pointing at us.
    const interakt = require('../integrations/whatsapp/interaktPartnerService');
    if (wabaId) {
      await interakt.unsubscribe({ wabaId, phoneNumberId, organization: connection.organization }).catch(err => {
        logger.warn('[whatsappConnectionService] Interakt unsubscribe failed (non-fatal)', { error: err.message });
      });
    }
  } else if (wabaId && connection.accessToken) {
    const whatsappLoginAuth = require('../integrations/whatsapp/whatsappLoginAuth');
    await whatsappLoginAuth.unsubscribeFromWebhook(wabaId, connection.accessToken).catch(err => {
      logger.warn('[whatsappConnectionService] Webhook unsubscribe failed (non-fatal)', { error: err.message });
    });
  }

  connection.isActive = false;
  connection.status = 'disconnected';
  await connection.save();

  logger.info('[whatsappConnectionService] Connection disconnected', { connectionId: connection._id });
}

/**
 * Get the current WhatsApp connection status for an organization.
 *
 * @param {string} organizationId
 * @returns {Promise<{ isConnected: boolean, connection?: object }>}
 */
async function getStatus(organizationId) {
  const connection = await PlatformConnection.findOne({
    organization: organizationId,
    platform: 'whatsapp',
    isActive: true
  });

  if (!connection) return { isConnected: false, connection: null };

  return {
    isConnected: true,
    connection: {
      id: connection._id,
      displayPhoneNumber: connection.platformData.displayPhoneNumber,
      verifiedName: connection.platformData.verifiedName,
      qualityRating: connection.platformData.qualityRating,
      status: connection.status
    }
  };
}

module.exports = { connectDirect, disconnect, getStatus };
