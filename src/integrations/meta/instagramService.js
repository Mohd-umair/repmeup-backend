const axios = require('axios');
const Interaction = require('../../models/Interaction');

class InstagramService {
  constructor() {
    this.apiVersion = 'v18.0';
    this.baseUrl = `https://graph.facebook.com/${this.apiVersion}`;
    this.instagramGraphUrl = `https://graph.instagram.com/${this.apiVersion}`;
  }

  /**
   * Fetch Instagram user profile (name, profile_pic) for a user who messaged the business.
   * Uses Instagram User Profile API (graph.instagram.com). Returns null on error.
   */
  async _fetchInstagramUserProfile(accessToken, userId) {
    if (!userId) return null;
    const token = typeof accessToken === 'string' ? accessToken.trim() : null;
    if (!token) return null;
    // Try graph.facebook.com first (same token works for comments there); graph.instagram.com for messaging
    const urlsToTry = [
      { url: `${this.baseUrl}/${userId}`, name: 'graph.facebook.com', fields: 'name,username,profile_pic,profile_picture_url' },
      { url: `${this.instagramGraphUrl}/${userId}`, name: 'graph.instagram.com', fields: 'name,username,profile_pic' }
    ];
    for (const { url, name, fields } of urlsToTry) {
      try {
        const response = await axios.get(url, {
          params: { fields, access_token: token },
          timeout: 5000,
        });
        const data = response.data || null;
        const picUrl = data && (data.profile_pic || data.profile_picture_url);
        if (data) {
          if (picUrl) data.profile_pic = data.profile_pic || data.profile_picture_url;
          return data;
        }
      } catch (err) {
        const msg = err.response?.data?.error?.message || err.message;
        const code = err.response?.data?.error?.code;
        // Expected without Advanced Access (instagram_manage_messages) or with invalid token (190)
        if (code === 200 || code === 190) {
          // Log once per userId at debug level to avoid noise on every webhook
          if (!this._profileFailLogged) this._profileFailLogged = new Set();
          if (!this._profileFailLogged.has(userId)) {
            this._profileFailLogged.add(userId);
            console.warn(`[Instagram] User profile unavailable for userId=${userId} (code ${code}). Normal until instagram_manage_messages has Advanced Access.`);
          }
        } else {
          console.warn(`[Instagram] User profile ${name} failed for userId=${userId}:`, msg, code ? `(code ${code})` : '');
        }
        // Try next URL or return null
      }
    }
    return null;
  }

  /**
   * Get business account ID from connection
   * Falls back to platformUserId if platformData.businessAccountId is not set
   */
  _getBusinessAccountId(platformConnection) {
    return platformConnection.platformData?.businessAccountId ||
           platformConnection.platformUserId;
  }

  /**
   * Fetch Instagram media (posts, reels) only. Used for Content / platform posts listing.
   * @param {Object} platformConnection - Must have accessToken and business account ID
   * @returns {Promise<Array>} Array of { id, caption, media_type, timestamp, permalink, media_url }
   */
  async getMedia(platformConnection) {
    const accessToken = platformConnection.accessToken || platformConnection.access_token;
    const businessAccountId = this._getBusinessAccountId(platformConnection);
    if (!businessAccountId) {
      throw new Error('Instagram Business Account ID not found in connection');
    }
    let allMedia = [];
    let nextPage = `${this.baseUrl}/${businessAccountId}/media`;
    let pageCount = 0;
    const maxPages = 10;
    while (nextPage && pageCount < maxPages) {
      try {
        const mediaResponse = await axios.get(nextPage, {
          params: {
            access_token: accessToken,
            fields: 'id,caption,media_type,timestamp,permalink,media_url',
            limit: 25
          }
        });
        allMedia = allMedia.concat(mediaResponse.data.data || []);
        nextPage = mediaResponse.data.paging?.next;
        pageCount++;
      } catch (error) {
        console.error(`[Instagram] getMedia error:`, error.message);
        break;
      }
    }
    return allMedia;
  }

  /**
   * Fetch Instagram comments for a business account
   * Supports pagination and includes replies
   */
  async fetchComments(platformConnection) {
    try {
      const accessToken = platformConnection.accessToken || platformConnection.access_token;
      const businessAccountId = this._getBusinessAccountId(platformConnection);

      if (!businessAccountId) {
        throw new Error('Instagram Business Account ID not found in connection');
      }

      console.log(`📸 [Instagram] Fetching comments for account: ${businessAccountId}`);

      // Get recent media (posts, reels, stories)
      let allMedia = [];
      let nextPage = `${this.baseUrl}/${businessAccountId}/media`;
      let pageCount = 0;
      const maxPages = 10; // Limit to prevent excessive API calls

      // Fetch all media with pagination
      while (nextPage && pageCount < maxPages) {
        try {
          const mediaResponse = await axios.get(nextPage, {
            params: {
              access_token: accessToken,
              fields: 'id,caption,media_type,timestamp,permalink,media_url',
              limit: 25
            }
          });

          allMedia = allMedia.concat(mediaResponse.data.data || []);
          nextPage = mediaResponse.data.paging?.next;
          pageCount++;

          if (pageCount >= maxPages) {
            console.log(`⚠️ [Instagram] Reached max pages (${maxPages}) for media fetch`);
          }
        } catch (error) {
          console.error(`Error fetching media page ${pageCount + 1}:`, error.message);
          break;
        }
      }

      console.log(`📸 [Instagram] Found ${allMedia.length} media items`);

      const interactions = [];
      const interactionMap = new Map(); // Track by platformId for bulk upsert

      // For each media, get comments
      for (const media of allMedia) {
        try {
          let allComments = [];
          let commentsNextPage = `${this.baseUrl}/${media.id}/comments`;
          let commentsPageCount = 0;
          const maxCommentPages = 5; // Limit comment pages per media

          // Fetch all comments with pagination
          while (commentsNextPage && commentsPageCount < maxCommentPages) {
            try {
              const commentsResponse = await axios.get(commentsNextPage, {
                params: {
                  access_token: accessToken,
                  fields: 'id,text,username,timestamp,from,like_count,replies{id,text,username,timestamp,from}',
                  limit: 100
                }
              });

              allComments = allComments.concat(commentsResponse.data.data || []);
              commentsNextPage = commentsResponse.data.paging?.next;
              commentsPageCount++;
            } catch (error) {
              console.error(`Error fetching comments page for media ${media.id}:`, error.message);
              break;
            }
          }

          // Process top-level comments
          for (const comment of allComments) {
            const interaction = {
              organization: platformConnection.organization,
              platformConnection: platformConnection._id,
              platform: 'instagram',
              type: 'comment',
              platformId: comment.id,
              platformUrl: media.permalink || `https://www.instagram.com/p/${media.id}/`,
              content: comment.text || '',
              author: {
                platformId: comment.from?.id,
                username: comment.username || comment.from?.username || 'unknown',
                name: comment.from?.username || comment.username || 'Unknown User'
                // avatarUrl set below from Instagram User Profile API (not Facebook /picture)
              },
              metadata: {
                postId: media.id,
                postUrl: media.permalink,
                mediaType: media.media_type,
                likeCount: comment.like_count || 0
              },
              platformCreatedAt: new Date(comment.timestamp),
              status: 'unread',
              sentiment: null // Will be set by AI processing
            };

            interactions.push(interaction);
            interactionMap.set(comment.id, interaction);

            // Process replies to this comment
            if (comment.replies && comment.replies.data && comment.replies.data.length > 0) {
              for (const reply of comment.replies.data) {
                const replyInteraction = {
                  organization: platformConnection.organization,
                  platformConnection: platformConnection._id,
                  platform: 'instagram',
                  type: 'comment',
                  platformId: reply.id,
                  parentId: comment.id, // Link to parent comment
                  platformUrl: media.permalink || `https://www.instagram.com/p/${media.id}/`,
                  content: reply.text || '',
                  author: {
                    platformId: reply.from?.id,
                    username: reply.username || reply.from?.username || 'unknown',
                    name: reply.from?.username || reply.username || 'Unknown User'
                    // avatarUrl set below from Instagram User Profile API
                  },
                  metadata: {
                    postId: media.id,
                    postUrl: media.permalink,
                    parentCommentId: comment.id,
                    isReply: true
                  },
                  platformCreatedAt: new Date(reply.timestamp),
                  status: 'unread',
                  sentiment: null
                };

                interactions.push(replyInteraction);
                interactionMap.set(reply.id, replyInteraction);
              }
            }
          }
        } catch (error) {
          console.error(`Error processing media ${media.id}:`, error.message);
          continue;
        }
      }

      // Fetch user profile (profile_pic) for comment/reply authors so inbox can show avatar
      const authorIds = [...new Set(interactions.map(i => i.author?.platformId).filter(Boolean))];
      const tokenOk = typeof accessToken === 'string' && accessToken.trim().length > 0;
      const profilePicByAuthor = new Map();
      for (const authorId of authorIds) {
        const profile = tokenOk ? await this._fetchInstagramUserProfile(accessToken, authorId) : null;
        const pic = profile?.profile_pic || profile?.profile_picture_url;
        if (pic) profilePicByAuthor.set(authorId, pic);
      }
      let withAvatar = 0;
      for (const interaction of interactions) {
        if (interaction.author?.platformId && profilePicByAuthor.has(interaction.author.platformId)) {
          interaction.author.avatarUrl = profilePicByAuthor.get(interaction.author.platformId);
          withAvatar++;
        }
      }

      console.log(`📸 [Instagram] Found ${interactions.length} total comments (including replies)`);

      // Bulk upsert interactions
      if (interactions.length > 0) {
        const bulkOps = interactions.map(interaction => {
          const { status, isRead, sentiment, ...platformFields } = interaction;
          return {
            updateOne: {
              filter: { platformId: interaction.platformId },
              update: {
                $set: platformFields,
                $setOnInsert: { status: 'unread', isRead: false, sentiment: sentiment ?? null }
              },
              upsert: true
            }
          };
        });

        await Interaction.bulkWrite(bulkOps);
        console.log(`✅ [Instagram] Saved ${interactions.length} comments to database`);
      }

      return {
        count: interactions.length,
        interactions: interactions
      };
    } catch (error) {
      console.error('Instagram fetch comments error:', error.message);
      if (error.response) {
        console.error('API Response:', error.response.data);
      }
      throw error;
    }
  }

  /**
   * Fetch Instagram DMs (messages) from conversations
   * Note: Instagram DMs require Instagram Messaging Product to be added to your app
   */
  async fetchMessages(platformConnection) {
    try {
      const accessToken = platformConnection.accessToken || platformConnection.access_token;
      const businessAccountId = this._getBusinessAccountId(platformConnection);
      // Facebook Login flow: conversations must be fetched via the Page ID,
      // not the Instagram Business Account ID (which requires Instagram Login).
      const pageId = platformConnection.platformPageId ||
        platformConnection.platformData?.pageId ||
        businessAccountId;

      if (!businessAccountId) {
        throw new Error('Instagram Business Account ID not found in connection');
      }

      if (!platformConnection.platformPageId && !platformConnection.platformData?.pageId) {
        console.warn('⚠️  [Instagram] platformPageId missing — falling back to IG account ID for conversations. Reconnect Instagram to fix this.');
      }

      // Log which token is used (masked) for debugging "capability" errors
      const tokenPreview = accessToken
        ? `${String(accessToken).slice(0, 8)}...${String(accessToken).slice(-4)}`
        : '(missing)';
      console.log(`💬 [Instagram] Fetching DMs via Page ID: ${pageId} (IG account: ${businessAccountId})`);
      console.log(`💬 [Instagram] Using token: ${tokenPreview}`);

      // Get conversations using Page ID (Facebook Login flow requires /{page-id}/conversations?platform=instagram)
      let allConversations = [];
      let nextPage = `${this.baseUrl}/${pageId}/conversations`;
      let pageCount = 0;
      const maxPages = 10;

      // Fetch conversations with pagination
      while (nextPage && pageCount < maxPages) {
        try {
          const response = await axios.get(nextPage, {
            params: {
              access_token: accessToken,
              platform: 'instagram',
              fields: 'id,participants',
              limit: 25
            }
          });

          allConversations = allConversations.concat(response.data.data || []);
          nextPage = response.data.paging?.next;
          pageCount++;
        } catch (error) {
          console.error(`❌ [Instagram] Error fetching conversations page ${pageCount + 1}:`, error.message);
          
          // Log detailed error info
          if (error.response?.data?.error) {
            const apiError = error.response.data.error;
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.error('❌ [Instagram DM] API Error Details:');
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.error('  Message:', apiError.message);
            console.error('  Type:', apiError.type);
            console.error('  Code:', apiError.code);
            console.error('  Subcode:', apiError.error_subcode);
            console.error('  Trace ID:', apiError.fbtrace_id);
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            
            // Check for specific permission errors
            if (apiError.code === 10 || apiError.code === 200 || apiError.code === 190) {
              console.warn('');
              console.warn('⚠️  [Instagram DM] PERMISSION ERROR DETECTED');
              console.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
              console.warn('📋 Instagram DMs require additional setup:');
              console.warn('');
              console.warn('   1. Add "Instagram Messaging" product to your Meta app');
              console.warn('      → https://developers.facebook.com/apps/1241029857870706/products/');
              console.warn('');
              console.warn('   2. Request "instagram_manage_messages" permission');
              console.warn('      → App Review → Permissions and Features');
              console.warn('');
              console.warn('   3. Complete Business Verification');
              console.warn('      → Settings → Basic → Business Verification');
              console.warn('');
              console.warn('   4. Switch app to Live mode (not Development)');
              console.warn('      → Settings → Basic → App Mode');
              console.warn('');
              console.warn('   5. After approval, reconnect Instagram in app settings');
              console.warn('');
              console.warn('📖 See: backend/docs/INSTAGRAM_DM_SETUP.md for full guide');
              console.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
              console.warn('✅ Comments will continue to work normally');
              console.warn('');
            }
            
            if (apiError.code === 100) {
              console.error('❌ [Instagram] Invalid access token or permissions issue');
              console.error('   → Try disconnecting and reconnecting Instagram');
            }
          }
          
          // Don't throw error - just skip DMs and continue with comments
          break;
        }
      }

      if (allConversations.length > 0) {
        console.log(`✅ [Instagram] Found ${allConversations.length} conversations - DMs are working!`);
      } else if (pageCount === 0) {
        console.warn(`⚠️  [Instagram] No conversations found - DMs likely not enabled (see error above)`);
      } else {
        console.log(`📭 [Instagram] No active conversations found (DMs are enabled but no messages)`);
      }

      const interactions = [];
      const interactionMap = new Map();
      const profileCache = new Map();

      // One interaction per conversation (same as webhook: platformId = dm_igAccountId_senderId)
      // so we don't create duplicate inbox entries when both webhook and sync run.
      for (const conversation of allConversations) {
        try {
          const participants = conversation.participants?.data || [];
          const otherParticipant = participants.find(p => String(p?.id) !== String(businessAccountId));
          const otherParticipantId = otherParticipant?.id;
          if (!otherParticipantId) {
            console.warn(`[Instagram] Skipping conversation ${conversation.id}: could not determine other participant`);
            continue;
          }

          // Same thread ID format as webhook so sync and webhook update the same interaction
          const threadPlatformId = `dm_${String(businessAccountId)}_${String(otherParticipantId)}`;

          let allMessages = [];
          let messagesNextPage = `${this.baseUrl}/${conversation.id}/messages`;
          let messagesPageCount = 0;
          const maxMessagePages = 10;

          while (messagesNextPage && messagesPageCount < maxMessagePages) {
            try {
              const messagesResponse = await axios.get(messagesNextPage, {
                params: {
                  access_token: accessToken,
                  fields: 'id,from,to,message,created_time,attachments',
                  limit: 100
                }
              });

              allMessages = allMessages.concat(messagesResponse.data.data || []);
              messagesNextPage = messagesResponse.data.paging?.next;
              messagesPageCount++;
            } catch (error) {
              console.error(`Error fetching messages for conversation ${conversation.id}:`, error.message);
              break;
            }
          }

          // Collect only incoming messages (from the other participant) for this conversation
          const incomingMessages = [];
          let latestIncoming = null;
          for (const message of allMessages) {
            const isFromUs = message.from?.id === businessAccountId ||
                            message.from?.id === platformConnection.platformPageId;
            if (!isFromUs && message.message) {
              const ts = message.created_time;
              const timestamp = typeof ts === 'number' ? ts : (new Date(ts).getTime() / 1000);
              incomingMessages.push({
                mid: message.id,
                text: message.message,
                timestamp
              });
              if (!latestIncoming || new Date(message.created_time) > new Date(latestIncoming.created_time)) {
                latestIncoming = message;
              }
            }
          }

          if (incomingMessages.length === 0) continue;

          const authorId = otherParticipantId;
          if (!profileCache.has(authorId)) {
            const profile = await this._fetchInstagramUserProfile(accessToken, authorId);
            profileCache.set(authorId, profile);
          }
          const profile = profileCache.get(authorId);
          let authorName = profile?.name || otherParticipant?.username || 'Unknown User';
          let avatarUrl = profile?.profile_pic || profile?.profile_picture_url;
          if (!avatarUrl) avatarUrl = `${this.baseUrl}/${authorId}/picture?type=normal`;

          const interaction = {
            organization: platformConnection.organization,
            platformConnection: platformConnection._id,
            platform: 'instagram',
            type: 'dm',
            platformId: threadPlatformId,
            threadId: otherParticipantId,
            platformUrl: 'https://www.instagram.com/direct/inbox/',
            content: latestIncoming.message,
            author: {
              platformId: authorId,
              username: otherParticipant?.username || 'unknown',
              name: authorName,
              avatarUrl
            },
            metadata: {
              conversationId: conversation.id,
              participants: participants,
              instagramAccountId: businessAccountId,
              incomingMessages: incomingMessages.slice(-100),
              lastMid: latestIncoming.id
            },
            platformCreatedAt: new Date(latestIncoming.created_time),
            status: 'unread',
            sentiment: null
          };

          interactions.push(interaction);
          interactionMap.set(threadPlatformId, interaction);
        } catch (error) {
          console.error(`Error processing conversation ${conversation.id}:`, error.message);
          continue;
        }
      }

      if (interactions.length > 0) {
        console.log(`💬 [Instagram] Found ${interactions.length} incoming DMs`);
      } else if (allConversations.length > 0) {
        console.log(`📭 [Instagram] No new incoming DMs (all messages from you or already synced)`);
      }

      // Bulk upsert interactions
      if (interactions.length > 0) {
        const bulkOps = interactions.map(interaction => {
          const { status, isRead, sentiment, ...platformFields } = interaction;
          return {
            updateOne: {
              filter: { platformId: interaction.platformId },
              update: {
                $set: platformFields,
                $setOnInsert: { status: 'unread', isRead: false, sentiment: sentiment ?? null }
              },
              upsert: true
            }
          };
        });

        await Interaction.bulkWrite(bulkOps);
        console.log(`✅ [Instagram] Saved ${interactions.length} DMs to database`);
      }

      // Always clean up legacy per-message rows (platformId not starting with "dm_").
      // Old sync code created one row per message (platformId = message.id like "m_xxx").
      // New code uses one row per conversation (platformId = dm_igAccountId_senderId).
      // $not: /^dm_/ correctly matches anything NOT starting with "dm_".
      try {
        const deleted = await Interaction.deleteMany({
          organization: platformConnection.organization,
          platform: 'instagram',
          type: 'dm',
          platformId: { $not: /^dm_/ }
        });
        if (deleted.deletedCount > 0) {
          console.log(`✅ [Instagram] Removed ${deleted.deletedCount} legacy per-message DM rows to prevent duplicates`);
        }
      } catch (cleanupErr) {
        console.warn('[Instagram] Legacy DM cleanup failed (non-critical):', cleanupErr.message);
      }

      return {
        count: interactions.length,
        interactions: interactions
      };
    } catch (error) {
      console.error('Instagram fetch messages error:', error.message);
      if (error.response) {
        console.error('API Response:', error.response.data);
      }
      throw error;
    }
  }

  /**
   * Fetch all Instagram interactions (comments + DMs)
   */
  async fetchAllInteractions(platformConnection) {
    try {
      const commentsResult = await this.fetchComments(platformConnection);
      let messagesResult = { count: 0, interactions: [] };

      // Try to fetch messages (may fail if Instagram Messaging not enabled)
      try {
        messagesResult = await this.fetchMessages(platformConnection);
      } catch (error) {
        console.warn(`⚠️ [Instagram] Could not fetch DMs: ${error.message}`);
        // Continue even if DMs fail
      }

      return {
        count: commentsResult.count + messagesResult.count,
        interactions: [...commentsResult.interactions, ...messagesResult.interactions]
      };
    } catch (error) {
      console.error('Instagram fetch all interactions error:', error.message);
      throw error;
    }
  }

  /**
   * Reply to an Instagram comment
   */
  async replyToComment(commentId, message, accessToken) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/${commentId}/replies`,
        {
          message: message
        },
        {
          params: {
            access_token: accessToken
          }
        }
      );

      return {
        success: true,
        platformResponseId: response.data.id
      };
    } catch (error) {
      console.error('Instagram reply to comment error:', error.message);
      if (error.response) {
        console.error('API Response:', error.response.data);
      }
      throw error;
    }
  }

  /**
   * Resolve the Facebook Page ID that this access token belongs to.
   * Only returns a value for PAGE tokens; for USER tokens /me would be the user ID, not the thread owner.
   * When token verification fails (e.g. app mismatch), returns null so caller uses stored platformPageId.
   * @param {string} accessToken - Page or User access token
   * @returns {Promise<string|null>} Page ID or null on error / when token is USER / when verify fails
   */
  async getPageIdFromToken(accessToken) {
    if (!accessToken) return null;
    try {
      const metaAuth = require('./metaAuth');
      const debug = await metaAuth.verifyAccessToken(accessToken);
      if (debug && debug.type === 'PAGE' && debug.profile_id) {
        return String(debug.profile_id);
      }
      if (debug && debug.type === 'USER') {
        console.warn('[Instagram] getPageIdFromToken: token is USER type; use stored platformPageId for send.');
        return null;
      }
      if (!debug) {
        console.warn('[Instagram] getPageIdFromToken: token verification failed (e.g. app mismatch). Using stored platformPageId.');
        return null;
      }
      const res = await axios.get(`${this.baseUrl}/me`, {
        params: { fields: 'id', access_token: accessToken },
        timeout: 5000
      });
      return res.data?.id || null;
    } catch (err) {
      console.warn('[Instagram] getPageIdFromToken failed:', err.response?.data?.error?.message || err.message);
      return null;
    }
  }

  /**
   * Send Instagram DM (Messaging API).
   * Uses HUMAN_AGENT message tag when useHumanAgentTag is true (default), per Meta App Review requirements.
   * @param {string} recipientId - Instagram recipient user ID (PSID)
   * @param {string} message - Text to send
   * @param {string} accessToken - Page access token
   * @param {string} pageId - Facebook Page ID (owns the Instagram account)
   * @param {boolean} [useHumanAgentTag=true] - Send with MESSAGE_TAG + HUMAN_AGENT for human agent replies
   */
  async sendMessage(recipientId, message, accessToken, pageId, useHumanAgentTag = true) {
    let tokenPageId = null;
    try {
      // Take thread control before replying — required when app receives DMs via standby channel.
      // This makes our app the thread owner so the reply succeeds.
      try {
        await axios.post(`${this.baseUrl}/${pageId}/take_thread_control`, null, {
          params: { recipient_id: recipientId, access_token: accessToken }
        });
        console.log('[Instagram] Thread control taken for recipient:', recipientId);
      } catch (ttcErr) {
        // Non-fatal: if we're already the thread owner this may fail or be a no-op
        console.warn('[Instagram] take_thread_control failed (may already be owner):', ttcErr.response?.data?.error?.message || ttcErr.message);
      }

      try {
        const meRes = await axios.get(`${this.baseUrl}/me`, {
          params: { fields: 'id', access_token: accessToken },
          timeout: 3000
        });
        tokenPageId = meRes.data?.id ? String(meRes.data.id) : null;
        if (tokenPageId && tokenPageId !== String(pageId)) {
          console.warn('[Instagram] sendMessage: token belongs to Page', tokenPageId, 'but sending with pageId', pageId, '- "not the thread owner" likely. Reconnect this Instagram from Settings using the same Meta App as the webhook.');
        }
      } catch (meErr) {
        const code = meErr.response?.data?.error?.code;
        const msg = meErr.response?.data?.error?.message || meErr.message;
        console.warn('[Instagram] sendMessage: /me check failed (code', code, '). Cannot confirm token matches pageId.', msg?.substring(0, 80));
      }

      // Try sending; if HUMAN_AGENT tag is not approved (error 10), fall back to RESPONSE.
      const attemptSend = async (useTag) => {
        const body = {
          recipient: { id: recipientId },
          message: { text: message }
        };
        if (useTag) {
          body.messaging_type = 'MESSAGE_TAG';
          body.tag = 'HUMAN_AGENT';
        } else {
          body.messaging_type = 'RESPONSE';
        }
        return axios.post(
          `${this.baseUrl}/${pageId}/messages`,
          body,
          { params: { access_token: accessToken } }
        );
      };

      let response;
      try {
        response = await attemptSend(useHumanAgentTag);
      } catch (tagErr) {
        const tagErrCode = tagErr.response?.data?.error?.code;
        const tagErrMsg = tagErr.response?.data?.error?.message || '';
        if (tagErrCode === 10 || tagErrMsg.toLowerCase().includes('human agent')) {
          console.warn('[Instagram] HUMAN_AGENT tag not approved, retrying with RESPONSE messaging_type');
          response = await attemptSend(false);
        } else {
          throw tagErr;
        }
      }

      return {
        success: true,
        platformResponseId: response.data.message_id
      };
    } catch (error) {
      const data = error.response?.data;
      const apiError = data?.error;
      let userMsg = apiError?.error_user_msg || apiError?.message || error.message;
      if (apiError?.code === 200 && userMsg && userMsg.includes('instagram_manage_messages')) {
        userMsg = 'Instagram messaging requires Advanced Access for instagram_manage_messages (App Review). Until approved, you can only reply to users who are Testers on your Meta app. Add the recipient as a Tester in your app’s Roles, or complete App Review for Advanced Access.';
      }
      if (apiError?.code === 100 && apiError?.error_subcode === 2534037) {
        userMsg = 'This conversation belongs to a different Instagram account. Reconnect the Instagram account that receives these DMs in Settings → Platforms.';
        const tokenMatchesPage = tokenPageId && String(tokenPageId) === String(pageId);
        if (tokenMatchesPage) {
          console.warn('[Instagram] Thread owner (2534037) but token Page matches pageId. The webhook is likely subscribed to a DIFFERENT Meta App than the one used to connect Instagram. Fix: In Meta for Developers use ONE app for both (1) Instagram product + webhook subscription and (2) your app\'s Instagram login. Put that app\'s App ID and Secret in .env (META_APP_ID / META_APP_SECRET).');
        } else {
          console.warn('[Instagram] Thread owner error (2534037). Ensure the same Meta App is used for (1) Instagram webhook subscription and (2) connecting Instagram in Settings. Token\'s Page from /me:', tokenPageId || 'unknown', '| pageId used:', pageId);
        }
      }
      console.error('Instagram send message error:', userMsg);
      if (data) {
        console.error('Instagram API response:', JSON.stringify(data));
      }
      const err = new Error(userMsg);
      err.platformError = apiError;
      err.statusCode = error.response?.status;
      throw err;
    }
  }
  /**
   * Create Instagram Media Container
   * Step 1 of publishing process
   */
  async createMediaContainer(platformConnection, { caption, mediaUrl, mediaType }) {
    try {
      const { accessToken } = platformConnection;
      const businessAccountId = this._getBusinessAccountId(platformConnection);

      if (!businessAccountId) {
        throw new Error('Instagram Business Account ID not found');
      }

      console.log(`📸 [Instagram] Creating media container for account: ${businessAccountId}`);

      const params = {
        access_token: accessToken,
        caption: caption || ''
      };

      // Add media based on type
      if (mediaType === 'image') {
        params.image_url = mediaUrl;
      } else if (mediaType === 'video') {
        params.media_type = 'VIDEO';
        params.video_url = mediaUrl;
      } else {
        throw new Error('Invalid media type. Must be "image" or "video"');
      }

      const response = await axios.post(
        `${this.baseUrl}/${businessAccountId}/media`,
        null,
        { params }
      );

      console.log(`✅ [Instagram] Media container created:`, response.data.id);

      return {
        containerId: response.data.id,
        mediaType
      };
    } catch (error) {
      console.error('❌ [Instagram] Create container error:', error.response?.data || error.message);
      
      // Extract detailed error info from Instagram API
      const apiError = error.response?.data?.error;
      if (apiError) {
        const detailedError = new Error(apiError.message || 'Failed to create media container');
        detailedError.platformError = {
          title: apiError.error_user_title || 'Instagram Error',
          message: apiError.error_user_msg || apiError.message,
          code: apiError.code,
          subcode: apiError.error_subcode,
          type: apiError.type
        };
        throw detailedError;
      }
      
      throw new Error('Failed to create media container');
    }
  }

  /**
   * Check Media Container Status
   * Required for videos to ensure processing is complete
   */
  async checkContainerStatus(accessToken, containerId, maxAttempts = 30) {
    console.log(`⏳ [Instagram] Checking container status: ${containerId}`);

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await axios.get(
          `${this.baseUrl}/${containerId}`,
          {
            params: {
              access_token: accessToken,
              fields: 'status_code,status' // Request both status_code and detailed status
            }
          }
        );

        const statusCode = response.data.status_code;
        const statusDetails = response.data.status;
        console.log(`📊 [Instagram] Container status (attempt ${i + 1}/${maxAttempts}): ${statusCode}`);
        
        // Log full response for debugging
        if (statusDetails) {
          console.log(`📋 [Instagram] Status details:`, JSON.stringify(statusDetails));
        }

        if (statusCode === 'FINISHED') {
          console.log(`✅ [Instagram] Container ready for publishing`);
          return true;
        } else if (statusCode === 'ERROR') {
          // Extract detailed error message from status field
          let errorMessage = 'Video processing failed';
          
          if (statusDetails) {
            if (typeof statusDetails === 'string') {
              errorMessage = statusDetails;
            } else if (statusDetails.error_message) {
              errorMessage = statusDetails.error_message;
            } else if (statusDetails.message) {
              errorMessage = statusDetails.message;
            } else {
              errorMessage = JSON.stringify(statusDetails);
            }
          }
          
          console.error(`❌ [Instagram] Video processing failed:`, errorMessage);
          
          // Check for specific error codes
          if (errorMessage.includes('2207076')) {
            throw new Error('Instagram cannot access the video URL. Ensure the URL is publicly accessible without authentication. Check your server firewall and SSL certificate.');
          } else if (errorMessage.includes('2207027')) {
            throw new Error('Media is not ready yet. This usually happens with large videos - try a smaller file.');
          } else {
            // Generic error with suggestions
            const suggestions = [
              'Video format: MP4 with H.264 codec + AAC audio',
              'Duration: 15-90 seconds for reels',
              'Aspect ratio: 9:16 (vertical) or 1:1',
              'File size: Under 1GB',
              'URL must be publicly accessible'
            ];
            throw new Error(`${errorMessage}. Requirements: ${suggestions.join('; ')}`);
          }
        } else if (statusCode === 'EXPIRED') {
          throw new Error('Container expired - took too long to process');
        }
        
        // Log current status for debugging
        console.log(`⏳ [Instagram] Still processing (${statusCode})... waiting 2s before retry`);

        // Wait 2 seconds before next check
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        // If it's a processing/expired error, throw immediately
        if (error.message.includes('processing') || error.message.includes('expired')) {
          throw error;
        }
        
        // If it's an API error, log and retry
        console.error(`⚠️ [Instagram] Status check error (attempt ${i + 1}/${maxAttempts}):`, error.response?.data || error.message);
        
        // If this was the last attempt, throw the error
        if (i === maxAttempts - 1) {
          throw new Error(`Failed to check container status: ${error.message}`);
        }
      }
    }

    throw new Error(`Video processing timeout - container not ready after ${maxAttempts * 2} seconds. The video may not meet Instagram's requirements (codec, format, duration, etc.).`);
  }

  /**
   * Publish Media Container
   * Step 2 of publishing process
   */
  async publishMediaContainer(platformConnection, containerId) {
    try {
      const { accessToken } = platformConnection;
      const businessAccountId = this._getBusinessAccountId(platformConnection);

      console.log(`📤 [Instagram] Publishing container: ${containerId}`);

      const response = await axios.post(
        `${this.baseUrl}/${businessAccountId}/media_publish`,
        null,
        {
          params: {
            access_token: accessToken,
            creation_id: containerId
          }
        }
      );

      const postId = response.data.id;
      console.log(`✅ [Instagram] Post published successfully: ${postId}`);

      // Fetch the permalink (correct URL with shortcode)
      let postUrl = `https://www.instagram.com/p/${postId}/`; // Fallback
      try {
        const mediaResponse = await axios.get(
          `${this.baseUrl}/${postId}`,
          {
            params: {
              access_token: accessToken,
              fields: 'permalink'
            }
          }
        );
        
        if (mediaResponse.data.permalink) {
          postUrl = mediaResponse.data.permalink;
          console.log(`✅ [Instagram] Fetched permalink: ${postUrl}`);
        }
      } catch (err) {
        console.warn(`⚠️ [Instagram] Could not fetch permalink, using fallback URL`);
      }

      return {
        postId,
        postUrl
      };
    } catch (error) {
      console.error('❌ [Instagram] Publish error:', error.response?.data || error.message);
      
      // Extract detailed error info from Instagram API
      const apiError = error.response?.data?.error;
      if (apiError) {
        const detailedError = new Error(apiError.message || 'Failed to publish media');
        detailedError.platformError = {
          title: apiError.error_user_title || 'Instagram Error',
          message: apiError.error_user_msg || apiError.message,
          code: apiError.code,
          subcode: apiError.error_subcode,
          type: apiError.type
        };
        throw detailedError;
      }
      
      throw new Error('Failed to publish media');
    }
  }

  /**
   * Create and Publish Instagram Post (Complete Flow)
   * Handles both images and videos
   */
  async createPost(platformConnection, { caption, mediaUrl, mediaType }) {
    try {
      if (!mediaUrl) {
        throw new Error('Media URL is required for Instagram posts');
      }

      console.log(`🚀 [Instagram] Starting post creation flow`);

      // Pre-check: Verify URL is publicly accessible
      await this.verifyMediaUrlAccessible(mediaUrl);

      // Step 1: Create media container
      const { containerId } = await this.createMediaContainer(platformConnection, {
        caption,
        mediaUrl,
        mediaType
      });

      // Step 2: Wait for media to be ready (videos need processing; images need a brief moment)
      await this.checkContainerStatus(platformConnection.accessToken, containerId, mediaType === 'video' ? 30 : 5);

      // Step 3: Publish the container
      const result = await this.publishMediaContainer(platformConnection, containerId);

      console.log(`🎉 [Instagram] Post creation complete!`);

      return result;
    } catch (error) {
      console.error('❌ [Instagram] Post creation failed:', error.message);
      // Preserve platformError if it exists
      if (error.platformError) {
        throw error;
      }
      throw new Error(error.message || 'Failed to create Instagram post');
    }
  }

  /**
   * Create and Publish Instagram Story
   * Stories are 24-hour temporary content
   */
  async createStory(platformConnection, { mediaUrl, mediaType }) {
    try {
      if (!mediaUrl) {
        throw new Error('Media URL is required for Instagram stories');
      }

      const { accessToken } = platformConnection;
      const businessAccountId = this._getBusinessAccountId(platformConnection);

      console.log(`📖 [Instagram] Starting story creation for account: ${businessAccountId}`);

      // Pre-check: Verify URL is publicly accessible
      await this.verifyMediaUrlAccessible(mediaUrl);

      // Step 1: Create story container
      const params = {
        access_token: accessToken,
        media_type: 'STORIES' // This tells Instagram it's a story
      };

      if (mediaType === 'image') {
        params.image_url = mediaUrl;
      } else if (mediaType === 'video') {
        params.video_url = mediaUrl;
      } else {
        throw new Error('Invalid media type. Must be "image" or "video"');
      }

      console.log(`📸 [Instagram] Creating story container`);
      const containerResponse = await axios.post(
        `${this.baseUrl}/${businessAccountId}/media`,
        null,
        { params }
      );

      const containerId = containerResponse.data.id;
      console.log(`✅ [Instagram] Story container created: ${containerId}`);

      // Step 2: For videos, wait for processing
      if (mediaType === 'video') {
        await this.checkContainerStatus(accessToken, containerId);
      }

      // Step 3: Publish the story
      console.log(`📤 [Instagram] Publishing story container: ${containerId}`);
      const publishResponse = await axios.post(
        `${this.baseUrl}/${businessAccountId}/media_publish`,
        null,
        {
          params: {
            access_token: accessToken,
            creation_id: containerId
          }
        }
      );

      const storyId = publishResponse.data.id;
      console.log(`✅ [Instagram] Story published successfully: ${storyId}`);

      return {
        postId: storyId,
        postUrl: `https://www.instagram.com/stories/${businessAccountId}/${storyId}`
      };
    } catch (error) {
      console.error('❌ [Instagram] Story creation failed:', error.response?.data || error.message);
      
      const apiError = error.response?.data?.error;
      if (apiError) {
        const detailedError = new Error(apiError.message || 'Failed to create story');
        detailedError.platformError = {
          title: apiError.error_user_title || 'Instagram Story Error',
          message: apiError.error_user_msg || apiError.message,
          code: apiError.code,
          subcode: apiError.error_subcode,
          type: apiError.type
        };
        throw detailedError;
      }
      
      throw new Error(error.message || 'Failed to create Instagram story');
    }
  }

  /**
   * Verify that a media URL is publicly accessible
   * This prevents Instagram error 2207076 (cannot download media)
   */
  async verifyMediaUrlAccessible(mediaUrl) {
    try {
      console.log(`🔍 [Instagram] Verifying URL is accessible: ${mediaUrl}`);
      
      const response = await axios.head(mediaUrl, {
        timeout: 10000,
        maxRedirects: 5,
        validateStatus: (status) => status === 200
      });
      




      console.log(`✅ [Instagram] URL is accessible (${response.status})`);
      console.log(`📊 [Instagram] Content-Type: ${response.headers['content-type']}, Size: ${response.headers['content-length']} bytes`);
      
      return true;
    } catch (error) {
      console.error(`❌ [Instagram] URL is NOT accessible:`, error.message);
      
      if (error.code === 'ECONNREFUSED') {
        throw new Error(`URL is not accessible: Connection refused. Check if your server is running and accessible from the internet (not just localhost).`);
      } else if (error.code === 'ENOTFOUND') {
        throw new Error(`URL is not accessible: Domain not found. Check your BASE_URL in .env file.`);
      } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
        throw new Error(`URL is not accessible: Connection timeout. Check firewall settings and ensure public access.`);
      } else if (error.response) {
        throw new Error(`URL is not accessible: Server returned ${error.response.status}. Ensure the /api/posts/media/ endpoint is public (no auth required).`);
      } else {
        throw new Error(`URL is not accessible: ${error.message}`);
      }
    }
  }

  /**
   * Create and Publish Instagram Reel
   * Reels are short-form video content optimized for discovery
   */
  async createReel(platformConnection, { caption, mediaUrl }) {
    try {
      if (!mediaUrl) {
        throw new Error('Video URL is required for Instagram reels');
      }

      const { accessToken } = platformConnection;
      const businessAccountId = this._getBusinessAccountId(platformConnection);

      console.log(`🎬 [Instagram] Starting reel creation for account: ${businessAccountId}`);
      console.log(`📹 [Instagram] Video URL: ${mediaUrl}`);

      // Pre-check: Verify URL is publicly accessible before sending to Instagram
      await this.verifyMediaUrlAccessible(mediaUrl);

      // Step 1: Create reel container
      const params = {
        access_token: accessToken,
        media_type: 'REELS', // This tells Instagram it's a reel
        video_url: mediaUrl,
        caption: caption || '',
        share_to_feed: true // Also share to main feed
      };

      console.log(`📹 [Instagram] Creating reel container with params:`, {
        media_type: params.media_type,
        video_url: params.video_url,
        share_to_feed: params.share_to_feed
      });
      const containerResponse = await axios.post(
        `${this.baseUrl}/${businessAccountId}/media`,
        null,
        { params }
      );

      const containerId = containerResponse.data.id;
      console.log(`✅ [Instagram] Reel container created: ${containerId}`);

      // Step 2: Wait for video processing
      await this.checkContainerStatus(accessToken, containerId);

      // Step 3: Publish the reel
      console.log(`📤 [Instagram] Publishing reel container: ${containerId}`);
      const publishResponse = await axios.post(
        `${this.baseUrl}/${businessAccountId}/media_publish`,
        null,
        {
          params: {
            access_token: accessToken,
            creation_id: containerId
          }
        }
      );

      const reelId = publishResponse.data.id;
      console.log(`✅ [Instagram] Reel published successfully: ${reelId}`);

      // Try to fetch the permalink
      let reelUrl = `https://www.instagram.com/reel/${reelId}/`;
      try {
        const mediaResponse = await axios.get(
          `${this.baseUrl}/${reelId}`,
          {
            params: {
              access_token: accessToken,
              fields: 'permalink'
            }
          }
        );
        
        if (mediaResponse.data.permalink) {
          reelUrl = mediaResponse.data.permalink;
          console.log(`✅ [Instagram] Fetched reel permalink: ${reelUrl}`);
        }
      } catch (err) {
        console.warn(`⚠️ [Instagram] Could not fetch reel permalink, using fallback URL`);
      }

      return {
        postId: reelId,
        postUrl: reelUrl
      };
    } catch (error) {
      console.error('❌ [Instagram] Reel creation failed:', error.response?.data || error.message);
      
      const apiError = error.response?.data?.error;
      if (apiError) {
        const detailedError = new Error(apiError.message || 'Failed to create reel');
        detailedError.platformError = {
          title: apiError.error_user_title || 'Instagram Reel Error',
          message: apiError.error_user_msg || apiError.message,
          code: apiError.code,
          subcode: apiError.error_subcode,
          type: apiError.type
        };
        throw detailedError;
      }
      
      throw new Error(error.message || 'Failed to create Instagram reel');
    }
  }

  /**
   * Create Carousel Post (Multiple Media)
   */
  async createCarouselPost(platformConnection, { caption, mediaUrls }) {
    try {
      const { accessToken } = platformConnection;
      const businessAccountId = this._getBusinessAccountId(platformConnection);

      if (!mediaUrls || mediaUrls.length === 0) {
        throw new Error('At least one media URL is required for carousel posts');
      }

      if (mediaUrls.length > 10) {
        throw new Error('Maximum 10 media items allowed in carousel');
      }

      console.log(`📸 [Instagram] Creating carousel with ${mediaUrls.length} items`);

      // Pre-check: Verify all URLs are publicly accessible
      for (let i = 0; i < mediaUrls.length; i++) {
        const mediaItem = mediaUrls[i];
        console.log(`🔍 [Instagram] Verifying carousel item ${i + 1}/${mediaUrls.length}`);
        await this.verifyMediaUrlAccessible(mediaItem.url);
      }

      // Step 1: Create containers for each media item
      const containerIds = [];
      for (const mediaItem of mediaUrls) {
        const params = {
          access_token: accessToken,
          is_carousel_item: true
        };

        if (mediaItem.type === 'image') {
          params.image_url = mediaItem.url;
        } else if (mediaItem.type === 'video') {
          params.media_type = 'VIDEO';
          params.video_url = mediaItem.url;
        }

        const response = await axios.post(
          `${this.baseUrl}/${businessAccountId}/media`,
          null,
          { params }
        );

        containerIds.push(response.data.id);
        console.log(`✅ [Instagram] Carousel item ${containerIds.length} created`);
      }

      // Step 2: Create carousel container
      const carouselResponse = await axios.post(
        `${this.baseUrl}/${businessAccountId}/media`,
        null,
        {
          params: {
            access_token: accessToken,
            media_type: 'CAROUSEL',
            caption: caption || '',
            children: containerIds.join(',')
          }
        }
      );

      const carouselContainerId = carouselResponse.data.id;
      console.log(`✅ [Instagram] Carousel container created: ${carouselContainerId}`);

      // Step 3: Publish carousel
      const result = await this.publishMediaContainer(platformConnection, carouselContainerId);

      console.log(`🎉 [Instagram] Carousel post published!`);

      return result;
    } catch (error) {
      console.error('❌ [Instagram] Carousel creation failed:', error.response?.data || error.message);
      
      // Extract detailed error info from Instagram API
      const apiError = error.response?.data?.error;
      if (apiError) {
        const detailedError = new Error(apiError.message || 'Failed to create carousel post');
        detailedError.platformError = {
          title: apiError.error_user_title || 'Instagram Error',
          message: apiError.error_user_msg || apiError.message,
          code: apiError.code,
          subcode: apiError.error_subcode,
          type: apiError.type
        };
        throw detailedError;
      }
      
      throw new Error('Failed to create carousel post');
    }
  }
}

module.exports = new InstagramService();
