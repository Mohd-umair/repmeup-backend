const crypto = require('crypto');
const User = require('../models/User');
const Organization = require('../models/Organization');
const Interaction = require('../models/Interaction');
const PlatformConnection = require('../models/PlatformConnection');

/**
 * Data Delete Controller - Facebook/Meta Data Deletion Callback
 * Handles user data deletion requests from Facebook/Instagram
 * Reference: https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback
 */

/**
 * Parse Facebook signed request
 */
function parseSignedRequest(signedRequest, appSecret) {
  try {
    const [encodedSig, payload] = signedRequest.split('.', 2);

    if (!encodedSig || !payload) {
      throw new Error('Invalid signed request format');
    }

    // Decode signature
    const sig = Buffer.from(encodedSig.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

    // Decode payload
    const data = JSON.parse(
      Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    );

    // Verify signature
    const expectedSig = crypto
      .createHmac('sha256', appSecret)
      .update(payload)
      .digest();

    if (!crypto.timingSafeEqual(sig, expectedSig)) {
      throw new Error('Invalid signature');
    }

    return data;
  } catch (error) {
    console.error('❌ [DataDelete] Error parsing signed request:', error);
    throw error;
  }
}

/**
 * Generate unique confirmation code
 */
function generateConfirmationCode() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Handle Facebook/Instagram data deletion request
 */
exports.handleFacebookDataDeletion = async (req, res) => {
  try {
    console.log('📧 [DataDelete] Received Facebook data deletion request');

    const signedRequest = req.body.signed_request;

    if (!signedRequest) {
      console.error('❌ [DataDelete] No signed_request in body');
      return res.status(400).json({
        error: 'Missing signed_request parameter'
      });
    }

    // Get app secret from environment
    const appSecret = process.env.FACEBOOK_APP_SECRET || process.env.META_APP_SECRET;

    if (!appSecret) {
      console.error('❌ [DataDelete] Facebook App Secret not configured');
      return res.status(500).json({
        error: 'Server configuration error'
      });
    }

    // Parse and verify signed request
    let parsedData;
    try {
      parsedData = parseSignedRequest(signedRequest, appSecret);
    } catch (error) {
      console.error('❌ [DataDelete] Failed to parse signed request:', error.message);
      return res.status(400).json({
        error: 'Invalid signed request',
        message: error.message
      });
    }

    const userId = parsedData.user_id;
    const algorithm = parsedData.algorithm;
    const issuedAt = parsedData.issued_at;

    console.log('✅ [DataDelete] Parsed request:', {
      userId,
      algorithm,
      issuedAt: new Date(issuedAt * 1000).toISOString()
    });

    // Generate confirmation code
    const confirmationCode = generateConfirmationCode();

    // Start async deletion process
    deleteUserDataAsync(userId, confirmationCode, 'facebook').catch(error => {
      console.error('❌ [DataDelete] Error in async deletion:', error);
    });

    // Return immediate response to Facebook
    const statusUrl = `${process.env.FRONTEND_URL || 'https://repmeup.in'}/data-deletion-status?code=${confirmationCode}`;

    const response = {
      url: statusUrl,
      confirmation_code: confirmationCode
    };

    console.log('✅ [DataDelete] Responding to Facebook:', response);

    res.status(200).json(response);

  } catch (error) {
    console.error('❌ [DataDelete] Unexpected error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * Handle Instagram data deletion request (uses same format as Facebook)
 */
exports.handleInstagramDataDeletion = async (req, res) => {
  // Instagram uses the same signed request format as Facebook
  return exports.handleFacebookDataDeletion(req, res);
};

/**
 * Async function to delete user data
 * This runs in the background after responding to Facebook
 */
async function deleteUserDataAsync(platformUserId, confirmationCode, platform) {
  try {
    console.log(`🗑️  [DataDelete] Starting deletion for ${platform} user: ${platformUserId}`);

    // Find all platform connections for this user
    const connections = await PlatformConnection.find({
      platform: { $in: ['facebook', 'instagram'] },
      platformUserId: platformUserId,
      isActive: true
    });

    if (connections.length === 0) {
      console.log(`ℹ️  [DataDelete] No active connections found for user ${platformUserId}`);
      
      // Log the deletion request for records
      await logDeletionRequest(platformUserId, confirmationCode, platform, 'no_data_found');
      return;
    }

    console.log(`📊 [DataDelete] Found ${connections.length} connection(s) to delete`);

    for (const connection of connections) {
      // Delete all interactions from this platform connection
      const deletedInteractions = await Interaction.deleteMany({
        platform: connection.platform,
        platformAuthorId: platformUserId,
        organization: connection.organization
      });

      console.log(`🗑️  [DataDelete] Deleted ${deletedInteractions.deletedCount} interactions`);

      // Deactivate the platform connection
      connection.isActive = false;
      connection.status = 'disconnected';
      connection.platformData = {
        ...connection.platformData,
        deletionRequested: true,
        deletionRequestedAt: new Date(),
        deletionConfirmationCode: confirmationCode
      };
      await connection.save();

      console.log(`✅ [DataDelete] Deactivated connection ${connection._id}`);
    }

    // Check if user should be deleted (if they only used Facebook/Instagram login)
    const user = await User.findOne({
      'platformData.facebookId': platformUserId
    }).populate('organization');

    if (user) {
      // Check if user has other login methods
      const hasOtherLogins = user.email && user.password;

      if (!hasOtherLogins) {
        // User only used Facebook/Instagram login, delete the user
        await User.findByIdAndDelete(user._id);
        console.log(`🗑️  [DataDelete] Deleted user ${user._id}`);

        // If user was the only admin of their organization, delete the organization
        if (user.organization) {
          const otherAdmins = await User.countDocuments({
            organization: user.organization._id,
            _id: { $ne: user._id }
          });

          if (otherAdmins === 0) {
            await Organization.findByIdAndDelete(user.organization._id);
            console.log(`🗑️  [DataDelete] Deleted organization ${user.organization._id}`);
          }
        }
      } else {
        // User has email/password login, just remove Facebook data
        user.platformData.facebookId = undefined;
        user.platformData.facebookData = undefined;
        await user.save();
        console.log(`✅ [DataDelete] Removed Facebook data from user ${user._id}`);
      }
    }

    // Log successful deletion
    await logDeletionRequest(platformUserId, confirmationCode, platform, 'completed');

    console.log(`✅ [DataDelete] Completed deletion for user ${platformUserId}`);

  } catch (error) {
    console.error(`❌ [DataDelete] Error in async deletion:`, error);
    
    // Log failed deletion
    await logDeletionRequest(platformUserId, confirmationCode, platform, 'failed', error.message);
  }
}

/**
 * Log deletion request for audit trail
 */
async function logDeletionRequest(platformUserId, confirmationCode, platform, status, error = null) {
  try {
    // You can store this in a dedicated collection or use your existing logging
    console.log('📝 [DataDelete] Logging deletion request:', {
      platformUserId,
      confirmationCode,
      platform,
      status,
      error,
      timestamp: new Date().toISOString()
    });

    // Optional: Store in database for audit trail
    // const DeletionLog = require('../models/DeletionLog');
    // await DeletionLog.create({
    //   platformUserId,
    //   confirmationCode,
    //   platform,
    //   status,
    //   error,
    //   requestedAt: new Date()
    // });

  } catch (logError) {
    console.error('❌ [DataDelete] Error logging deletion request:', logError);
  }
}

/**
 * Check deletion status
 * Users can check the status of their deletion request
 */
exports.checkDeletionStatus = async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      return res.status(400).json({
        success: false,
        error: 'Missing confirmation code'
      });
    }

    // Check if deletion is complete
    // In a production system, you'd check a deletion log/status table
    const connection = await PlatformConnection.findOne({
      'platformData.deletionConfirmationCode': code
    });

    if (!connection) {
      return res.status(404).json({
        success: false,
        error: 'Deletion request not found',
        message: 'This confirmation code is invalid or the request has expired.'
      });
    }

    const status = connection.isActive ? 'processing' : 'completed';

    res.status(200).json({
      success: true,
      status: status,
      message: status === 'completed'
        ? 'Your data has been successfully deleted from our system.'
        : 'Your data deletion request is being processed.',
      requestedAt: connection.platformData.deletionRequestedAt,
      confirmationCode: code
    });

  } catch (error) {
    console.error('❌ [DataDelete] Error checking status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check deletion status'
    });
  }
};

/**
 * Manual data deletion endpoint (for internal use)
 * Allows admins to manually trigger deletion if needed
 */
exports.manualDataDeletion = async (req, res) => {
  try {
    const { platformUserId, platform } = req.body;

    if (!platformUserId || !platform) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters'
      });
    }

    const confirmationCode = generateConfirmationCode();

    // Start deletion
    await deleteUserDataAsync(platformUserId, confirmationCode, platform);

    res.status(200).json({
      success: true,
      message: 'Data deletion initiated',
      confirmationCode
    });

  } catch (error) {
    console.error('❌ [DataDelete] Manual deletion error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to initiate data deletion'
    });
  }
};

