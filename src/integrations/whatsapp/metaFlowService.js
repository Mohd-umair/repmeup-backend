const axios = require('axios');
const FormData = require('form-data');

/**
 * Meta WhatsApp Flows Management API Service
 * Wraps the Graph API endpoints for creating, uploading, publishing, and managing flows.
 * Documentation: https://developers.facebook.com/docs/whatsapp/flows
 */
class MetaFlowService {
  constructor() {
    this.apiVersion = 'v23.0';
    this.apiURL = `https://graph.facebook.com/${this.apiVersion}`;
  }

  _accessToken(connection) {
    return connection?.accessToken || process.env.WHATSAPP_ACCESS_TOKEN;
  }

  _wabaId(connection) {
    return connection?.platformData?.businessAccountId || process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  }

  _authHeader(connection) {
    return { Authorization: `Bearer ${this._accessToken(connection)}` };
  }

  _jsonHeaders(connection) {
    return {
      Authorization: `Bearer ${this._accessToken(connection)}`,
      'Content-Type': 'application/json'
    };
  }

  /**
   * Create a new flow on Meta's side.
   * @param {Object} connection PlatformConnection
   * @param {string} name Flow name
   * @param {string} category Flow category (e.g. 'SURVEY', 'LEAD_GENERATION')
   * @returns {Object} { flowId, status }
   */
  async createFlow(connection, name, category = 'SURVEY') {
    const wabaId = this._wabaId(connection);
    if (!wabaId) {
      throw new Error('WABA ID not configured');
    }

    try {
      const response = await axios.post(
        `${this.apiURL}/${wabaId}/flows`,
        {
          name,
          categories: [category]
        },
        { headers: this._jsonHeaders(connection), timeout: 15000 }
      );

      const validationErrors = this._formatValidationErrors(response.data?.validation_errors);
      if (validationErrors) {
        throw new Error(`Meta rejected the form layout: ${validationErrors}`);
      }

      return {
        flowId: response.data.id,
        status: response.data.status || 'created'
      };
    } catch (error) {
      if (!error.response) throw error;
      console.error('[MetaFlow] Create flow failed:', error.response?.data || error.message);
      // Meta returns a bare "Invalid parameter" when the flow name is already
      // taken on this WABA — say so rather than passing that through.
      const metaError = error.response?.data?.error;
      if (metaError?.message === 'Invalid parameter') {
        throw new Error(
          metaError.error_user_msg ||
          'Meta rejected the flow. A flow with this name may already exist on your WhatsApp Business account — try a different name.'
        );
      }
      throw new Error(metaError?.message || 'Failed to create flow on Meta');
    }
  }

  /**
   * Flatten Meta's `validation_errors` array into one readable line.
   * Meta returns these with HTTP 200, so callers must check the body — a bad
   * Flow JSON otherwise only surfaces later as an opaque publish failure.
   */
  _formatValidationErrors(validationErrors) {
    if (!Array.isArray(validationErrors) || validationErrors.length === 0) return null;
    return validationErrors
      .map((e) => {
        const where = e.pointers?.[0]?.json_path || e.line_start != null ? ` (${e.pointers?.[0]?.json_path || `line ${e.line_start}`})` : '';
        return `${e.message || e.error_type || 'validation error'}${where}`;
      })
      .join('; ');
  }

  /**
   * Upload flow JSON asset to Meta.
   *
   * The /assets edge takes multipart/form-data — the JSON goes up as a *file*
   * part named `flow.json`, not as a JSON body field.
   *
   * @param {Object} connection PlatformConnection
   * @param {string} flowId Flow ID returned from createFlow
   * @param {Object} flowJson The flow JSON definition
   * @returns {Object} { success, validationErrors }
   */
  async uploadFlowAsset(connection, flowId, flowJson) {
    try {
      const form = new FormData();
      form.append('file', Buffer.from(JSON.stringify(flowJson), 'utf8'), {
        filename: 'flow.json',
        contentType: 'application/json'
      });
      form.append('name', 'flow.json');
      form.append('asset_type', 'FLOW_JSON');

      const response = await axios.post(
        `${this.apiURL}/${flowId}/assets`,
        form,
        {
          headers: { ...this._authHeader(connection), ...form.getHeaders() },
          timeout: 30000,
          maxBodyLength: Infinity
        }
      );

      const validationErrors = this._formatValidationErrors(response.data?.validation_errors);
      if (validationErrors) {
        throw new Error(`Meta rejected the form layout: ${validationErrors}`);
      }

      return { success: true, validationErrors: null };
    } catch (error) {
      if (!error.response) throw error;
      console.error('[MetaFlow] Upload asset failed:', error.response?.data || error.message);
      throw new Error(error.response?.data?.error?.message || 'Failed to upload flow asset to Meta');
    }
  }

  /**
   * Publish a flow (make it live).
   * Note: publishing makes a flow **immutable** — editing requires deprecating and creating a new flow.
   * @param {Object} connection PlatformConnection
   * @param {string} flowId Flow ID
   * @returns {Object} { success, status }
   */
  async publishFlow(connection, flowId) {
    try {
      const response = await axios.post(
        `${this.apiURL}/${flowId}/publish`,
        {},
        { headers: this._jsonHeaders(connection), timeout: 15000 }
      );

      return {
        success: true,
        status: response.data.status || 'published'
      };
    } catch (error) {
      console.error('[MetaFlow] Publish flow failed:', error.response?.data || error.message);
      const metaError = error.response?.data?.error;

      // 139000 is an account-level gate, not a problem with the flow itself —
      // most often an unverified Meta Business account. The raw "Blocked by
      // Integrity" tells the user nothing they can act on.
      if (metaError?.code === 139000) {
        throw new Error(
          'Meta blocked publishing for this WhatsApp Business account. This is usually because ' +
          'the Meta Business account is not verified — publishing forms requires completed ' +
          'Business Verification. Check Business Settings → Business Info → Verification, and ' +
          'WhatsApp Manager for any account restrictions. The form stays saved and can be ' +
          'published once the account clears.'
        );
      }

      throw new Error(metaError?.error_user_msg || metaError?.message || 'Failed to publish flow on Meta');
    }
  }

  /**
   * Deprecate a published flow (make it unavailable for new sends).
   * @param {Object} connection PlatformConnection
   * @param {string} flowId Flow ID
   * @returns {Object} { success, status }
   */
  async deprecateFlow(connection, flowId) {
    try {
      const response = await axios.post(
        `${this.apiURL}/${flowId}/deprecate`,
        {},
        { headers: this._jsonHeaders(connection), timeout: 15000 }
      );

      return {
        success: true,
        status: response.data.status || 'deprecated'
      };
    } catch (error) {
      console.error('[MetaFlow] Deprecate flow failed:', error.response?.data || error.message);
      throw new Error(error.response?.data?.error?.message || 'Failed to deprecate flow on Meta');
    }
  }

  /**
   * Get flow preview URL for testing/preview before publishing.
   * @param {Object} connection PlatformConnection
   * @param {string} flowId Flow ID
   * @returns {Object} { previewUrl }
   */
  async getFlowPreviewUrl(connection, flowId) {
    try {
      const response = await axios.get(
        `${this.apiURL}/${flowId}?fields=preview_url`,
        { headers: this._authHeader(connection), timeout: 15000 }
      );

      return {
        previewUrl: response.data.preview_url
      };
    } catch (error) {
      console.error('[MetaFlow] Get preview URL failed:', error.response?.data || error.message);
      throw new Error(error.response?.data?.error?.message || 'Failed to get flow preview URL');
    }
  }

  /**
   * Get flow status/metadata.
   * @param {Object} connection PlatformConnection
   * @param {string} flowId Flow ID
   * @returns {Object} { id, name, status, ... }
   */
  async getFlowStatus(connection, flowId) {
    try {
      const response = await axios.get(
        `${this.apiURL}/${flowId}`,
        { headers: this._authHeader(connection), timeout: 15000 }
      );

      return response.data;
    } catch (error) {
      console.error('[MetaFlow] Get flow status failed:', error.response?.data || error.message);
      throw new Error(error.response?.data?.error?.message || 'Failed to get flow status');
    }
  }
}

module.exports = new MetaFlowService();
