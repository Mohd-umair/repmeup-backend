const axios = require('axios');
const Interaction = require('../../models/Interaction');
const { generateChatRef } = require('../../utils/chatRefHelper');

class InstagramService {
  constructor() {
    // graph.facebook.com: stable on v18.0 for Facebook-Login Instagram flow.
    this.apiVersion = 'v18.0';
    this.baseUrl = `https://graph.facebook.com/${this.apiVersion}`;

    // graph.instagram.com: Instagram API with Instagram Login requires v20.0+
    // for messaging endpoints. Using v18.0 causes a misleading 2534037
    // "not the thread owner" error even when token and payload are correct.
    this.instagramApiVersion = 'v23.0';
    this.instagramGraphUrl = `https://graph.instagram.com/${this.instagramApiVersion}`;
  }

  /**
   * Fetch Instagram user profile (name, profile_pic) for a user who messaged the business.
   * Uses Instagram User Profile API (graph.instagram.com). Returns null on error.
   */
  async _fetchInstagramUserProfile(accessToken, userId) {
    if (!userId) return null;
    const token = typeof accessToken === 'string' ? accessToken.trim() : null;
    if (!token) return null;

    const isIgLoginToken = token.startsWith('IGAA');

    // Instagram Login (IGAA) user tokens can only query /me — they cannot look
    // up arbitrary IGSIDs. Skip the attempt to avoid noisy 190 errors.
    if (isIgLoginToken) {
      try {
        const response = await axios.get(`${this.instagramGraphUrl}/${userId}`, {
          params: { fields: 'name,username', access_token: token },
          timeout: 5000
        });
        const data = response.data || null;
        if (data && (data.name || data.username)) return data;
      } catch (_) {
        // Instagram Login tokens can't look up other users — this is expected
      }
      return null;
    }

    // Facebook Login path: try graph.facebook.com first, then graph.instagram.com
    const attemptsPerUrl = [
      { url: `${this.baseUrl}/${userId}`, name: 'graph.facebook.com', fieldSets: ['name,profile_pic,username', 'name,profile_pic'] },
      { url: `${this.instagramGraphUrl}/${userId}`, name: 'graph.instagram.com', fieldSets: ['name,username,profile_pic', 'name,profile_pic'] }
    ];

    for (const { url, name: urlName, fieldSets } of attemptsPerUrl) {
      for (const fields of fieldSets) {
        try {
          const response = await axios.get(url, {
            params: { fields, access_token: token },
            timeout: 5000
          });
          const data = response.data || null;
          if (data && (data.name || data.username || data.profile_pic)) {
            if (!data.profile_pic && data.profile_picture_url) {
              data.profile_pic = data.profile_picture_url;
            }
            return data;
          }
        } catch (err) {
          const msg = err.response?.data?.error?.message || err.message;
          const code = err.response?.data?.error?.code;
          if (code === 200 || code === 190 || code === 100) {
            if (!this._profileFailLogged) this._profileFailLogged = new Set();
            const logKey = `${userId}_${fields}`;
            if (!this._profileFailLogged.has(logKey)) {
              this._profileFailLogged.add(logKey);
              console.warn(`[Instagram] Profile fetch failed for userId=${userId} fields="${fields}" (code ${code}): ${msg?.substring(0, 80)}`);
            }
          } else {
            console.warn(`[Instagram] User profile ${urlName} failed for userId=${userId}:`, msg, code ? `(code ${code})` : '');
          }
        }
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
   * Query params merged into Meta Graph calls. Including `locale` makes
   * `error_user_title` / `error_user_msg` follow that locale (often Arabic/Gulf
   * when omitted, based on IG/Facebook Business asset settings). Override with
   * META_GRAPH_LOCALE (underscore form, e.g. en_US, ar_AR).
   */
  _metaGraphParams(params = {}) {
    const locale = process.env.META_GRAPH_LOCALE || 'en_US';
    return { locale, ...params };
  }

  /**
   * Returns the correct Graph API base URL depending on how Instagram was connected.
   *
   * - Facebook Login (default):  https://graph.facebook.com/v18.0
   * - Instagram Login (new):     https://graph.instagram.com/v23.0
   *
   * @param {string|null} connectionType - platformConnection.metadata.connectionType
   */
  _getApiBase(connectionType) {
    if (connectionType === 'instagram_login') {
      return this.instagramGraphUrl; // https://graph.instagram.com/v23.0
    }
    return this.baseUrl; // https://graph.facebook.com/v18.0
  }

  /**
   * Extract connection type string from a platformConnection document or metadata object.
   * Returns 'instagram_login' or null (null = default Facebook Login behaviour).
   *
   * Fallback: Instagram Login tokens always start with 'IGAA', Facebook Page
   * tokens start with 'EAA'. Use the prefix when metadata is missing.
   */
  _connectionType(platformConnection) {
    const explicit = platformConnection?.metadata?.connectionType;
    if (explicit) return explicit;

    const token = platformConnection?.accessToken || platformConnection?.access_token || '';
    if (typeof token === 'string' && token.startsWith('IGAA')) {
      return 'instagram_login';
    }
    return null;
  }

  /**
   * For Instagram Login, the Graph API requires /me/{edge} instead of /{id}/{edge}.
   * Returns 'me' for instagram_login, otherwise the businessAccountId.
   */
  _accountPath(platformConnection) {
    const connType = this._connectionType(platformConnection);
    if (connType === 'instagram_login') return 'me';
    return this._getBusinessAccountId(platformConnection);
  }

  /**
   * Fetch Instagram media (posts, reels) only. Used for Content / platform posts listing.
   * @param {Object} platformConnection - Must have accessToken and business account ID
   * @returns {Promise<Array>} Array of { id, caption, media_type, timestamp, permalink, media_url }
   */
  async getMedia(platformConnection) {
    const accessToken = platformConnection.accessToken || platformConnection.access_token;
    const businessAccountId = this._getBusinessAccountId(platformConnection);
    const connType = this._connectionType(platformConnection);
    const apiBase = this._getApiBase(connType);
    const isIgLogin = connType === 'instagram_login';
    if (!businessAccountId) {
      throw new Error('Instagram Business Account ID not found in connection');
    }
    let allMedia = [];
    let nextPage = isIgLogin
      ? `${apiBase}/me/media`
      : `${apiBase}/${businessAccountId}/media`;
    let pageCount = 0;
    const maxPages = 10;
    while (nextPage && pageCount < maxPages) {
      try {
        const mediaResponse = await axios.get(nextPage, {
          params: {
            access_token: accessToken,
            fields: 'id,caption,media_type,timestamp,permalink,media_url,like_count',
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

    // Fetch share count for each media via Insights API (in batches of 10 to avoid rate limits)
    if (allMedia.length > 0) {
      const BATCH = 10;
      for (let i = 0; i < allMedia.length; i += BATCH) {
        const batch = allMedia.slice(i, i + BATCH);
        await Promise.all(batch.map(async (media) => {
          try {
            const res = await axios.get(`${apiBase}/${media.id}/insights`, {
              params: { metric: 'shares', access_token: accessToken }
            });
            const sharesEntry = (res.data.data || []).find(d => d.name === 'shares');
            // Response can be either values[0].value or total_value.value depending on API version
            media.share_count =
              sharesEntry?.total_value?.value ??
              sharesEntry?.values?.[0]?.value ??
              0;
          } catch {
            // Insights may not be available for all media types (e.g. carousel children, stories)
            media.share_count = 0;
          }
        }));
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
      const connType = this._connectionType(platformConnection);
      const apiBase = this._getApiBase(connType);
      const isIgLogin = connType === 'instagram_login';

      if (!businessAccountId) {
        throw new Error('Instagram Business Account ID not found in connection');
      }

      console.log(`📸 [Instagram] Fetching comments for account: ${businessAccountId} [${connType || 'facebook_login'}]`);

      // Facebook Login: /{businessAccountId}/media
      // Instagram Login: /me/media (User token)
      let allMedia = [];
      let nextPage = isIgLogin
        ? `${apiBase}/me/media`
        : `${apiBase}/${businessAccountId}/media`;
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
          let commentsNextPage = `${apiBase}/${media.id}/comments`;
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
                mediaCaption: media.caption ? String(media.caption).slice(0, 200) : null,
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
                    mediaCaption: media.caption ? String(media.caption).slice(0, 200) : null,
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
        const orgId = platformConnection.organization;
        const existingIds = new Set(
          (await Interaction.find({ platformId: { $in: interactions.map(i => i.platformId) } }).select('platformId').lean())
            .map(i => i.platformId)
        );
        const chatRefMap = {};
        for (const interaction of interactions) {
          if (!existingIds.has(interaction.platformId)) {
            chatRefMap[interaction.platformId] = await generateChatRef(orgId).catch(() => ({ chatNumber: null, chatRef: null }));
          }
        }
        const bulkOps = interactions.map(interaction => {
          const { status, isRead, sentiment, ...platformFields } = interaction;
          const ref = chatRefMap[interaction.platformId] || {};
          return {
            updateOne: {
              filter: { platformId: interaction.platformId },
              update: {
                $set: platformFields,
                $setOnInsert: { status: 'unread', isRead: false, source: 'sync', sentiment: sentiment ?? null, chatNumber: ref.chatNumber ?? null, chatRef: ref.chatRef ?? null }
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
      const connType = this._connectionType(platformConnection);
      const apiBase = this._getApiBase(connType);

      // Facebook Login: use Page ID for conversations endpoint.
      // Instagram Login: platformPageId === platformUserId (IG account ID), so same fallback works.
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
      console.log(`💬 [Instagram] Fetching DMs via Page ID: ${pageId} (IG account: ${businessAccountId}) [${connType || 'facebook_login'}]`);
      console.log(`💬 [Instagram] Using token: ${tokenPreview}`);

      // Facebook Login:  graph.facebook.com/{page-id}/conversations?platform=instagram
      // Instagram Login: graph.instagram.com/me/conversations?platform=instagram
      const isIgLogin = connType === 'instagram_login';
      let allConversations = [];
      let nextPage = isIgLogin
        ? `${apiBase}/me/conversations`
        : `${apiBase}/${pageId}/conversations`;
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
            
            // Subcode 2534041 = account owner has turned off DM access from their Instagram settings.
            // This is an account-side toggle, NOT a developer/app permission issue.
            if (apiError.code === 200 && apiError.error_subcode === 2534041) {
              console.warn('⚠️  [Instagram DM] Account-level DM access is disabled for this user.');
              console.warn('   The Instagram account owner needs to enable messaging access:');
              console.warn('   Instagram → Settings → Privacy → Messages → Allow message requests');
              console.warn('   OR: Settings → Business tools and controls → Connected tools (for Business/Creator accounts)');
              console.warn('   Comments will continue to work normally.');

              // Persist the flag so the UI can show a clear warning to the account owner
              if (platformConnection._id) {
                const PlatformConnection = require('../../models/PlatformConnection');
                PlatformConnection.findByIdAndUpdate(platformConnection._id, {
                  $set: {
                    'metadata.instagramDmEnabled': false,
                    'metadata.instagramDmDisabledReason': 'Account owner has disabled Instagram DM access. Go to Instagram → Settings → Privacy → Messages and enable message requests, then resync.'
                  }
                }).catch(() => {});
              }
            } else if (apiError.code === 10 || apiError.code === 200 || apiError.code === 190) {
              // Generic permission error — likely a developer/app setup issue
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
        // DMs working — ensure flag is cleared
        if (platformConnection._id) {
          const PlatformConnection = require('../../models/PlatformConnection');
          PlatformConnection.findByIdAndUpdate(platformConnection._id, {
            $set: { 'metadata.instagramDmEnabled': true, 'metadata.instagramDmDisabledReason': null }
          }).catch(() => {});
        }
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
          let messagesNextPage = `${apiBase}/${conversation.id}/messages`;
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
              // Store timestamp in MILLISECONDS for consistent frontend rendering.
              // created_time from Graph API is an ISO string; getTime() returns ms.
              const timestamp = typeof ts === 'number'
                ? (ts < 10_000_000_000 ? ts * 1000 : ts)  // if already seconds, convert to ms
                : new Date(ts).getTime();
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
          if (!avatarUrl) avatarUrl = `${apiBase}/${authorId}/picture?type=normal`;

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
        const orgId = platformConnection.organization;
        const existingDmIds = new Set(
          (await Interaction.find({ platformId: { $in: interactions.map(i => i.platformId) } }).select('platformId').lean())
            .map(i => i.platformId)
        );
        const dmChatRefMap = {};
        for (const interaction of interactions) {
          if (!existingDmIds.has(interaction.platformId)) {
            dmChatRefMap[interaction.platformId] = await generateChatRef(orgId).catch(() => ({ chatNumber: null, chatRef: null }));
          }
        }
        const bulkOps = interactions.map(interaction => {
          const { status, isRead, sentiment, ...platformFields } = interaction;
          const ref = dmChatRefMap[interaction.platformId] || {};
          return {
            updateOne: {
              filter: { platformId: interaction.platformId },
              update: {
                $set: platformFields,
                $setOnInsert: { status: 'unread', isRead: false, source: 'sync', sentiment: sentiment ?? null, chatNumber: ref.chatNumber ?? null, chatRef: ref.chatRef ?? null }
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
   * @param {string|null} [connectionType=null] - 'instagram_login' or null (Facebook Login default)
   */
  async replyToComment(commentId, message, accessToken, connectionType = null) {
    const apiBase = this._getApiBase(connectionType);
    try {
      const response = await axios.post(
        `${apiBase}/${commentId}/replies`,
        {
          message: message
        },
        {
          params: this._metaGraphParams({ access_token: accessToken })
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
        params: this._metaGraphParams({ fields: 'id', access_token: accessToken }),
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
   * @param {string} accessToken - Page / user access token
   * @param {string} pageId - Facebook Page ID (Facebook Login) OR Instagram user ID (Instagram Login)
   * @param {boolean} [useHumanAgentTag=true] - Send with MESSAGE_TAG + HUMAN_AGENT for human agent replies
   * @param {string|null} [connectionType=null] - 'instagram_login' or null (Facebook Login default)
   */
  async sendMessage(recipientId, message, accessToken, pageId, useHumanAgentTag = true, connectionType = null) {
    const apiBase = this._getApiBase(connectionType);
    const isIgLogin = connectionType === 'instagram_login';
    let tokenPageId = null;

    try {
      // ── Instagram Login path (graph.instagram.com) ──
      // Token is a User access token; no thread control, no messaging_type/tag.
      // Endpoint: POST /{ig-user-id}/messages
      if (isIgLogin) {
        const body = {
          recipient: { id: recipientId },
          message: { text: message }
        };
        console.log(`[Instagram] sendMessage (IG Login): POST ${apiBase}/${pageId}/messages to ${recipientId}`);
        const response = await axios.post(
          `${apiBase}/${pageId}/messages`,
          body,
          { params: this._metaGraphParams({ access_token: accessToken }) }
        );
        return {
          success: true,
          platformResponseId: response.data.message_id
        };
      }

      // ── Facebook Login path (graph.facebook.com) ──
      try {
        await axios.post(`${apiBase}/${pageId}/take_thread_control`, null, {
          params: this._metaGraphParams({ recipient_id: recipientId, access_token: accessToken })
        });
        console.log('[Instagram] Thread control taken for recipient:', recipientId);
      } catch (ttcErr) {
        console.warn('[Instagram] take_thread_control failed (may already be owner):', ttcErr.response?.data?.error?.message || ttcErr.message);
      }

      try {
        const meRes = await axios.get(`${apiBase}/me`, {
          params: this._metaGraphParams({ fields: 'id', access_token: accessToken }),
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
          `${apiBase}/${pageId}/messages`,
          body,
          { params: this._metaGraphParams({ access_token: accessToken }) }
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
      // Prefer `message` — English (#code) developer text. `error_user_msg` follows Meta/account locale (often Arabic for MENA Pages).
      let userMsg = apiError?.message || apiError?.error_user_msg || error.message;
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
   * Send a Private Reply DM to the author of an Instagram comment.
   *
   * Uses `recipient.comment_id` instead of `recipient.id`, which bypasses the
   * 24-hour messaging window and works for brand-new users who have never
   * messaged the business before. Valid within 7 days of the comment.
   *
   * @param {string} commentId  - IG comment ID (the platformId stored on the Interaction)
   * @param {string} message    - Text to send
   * @param {string} accessToken - Page / user access token
   * @param {string} pageId     - Facebook Page ID (Facebook Login) or IG user ID (Instagram Login)
   * @param {string|null} [connectionType=null] - 'instagram_login' or null
   * @returns {{ success: true, platformResponseId: string }}
   */
  async sendPrivateReply(commentId, message, accessToken, pageId, connectionType = null) {
    const apiBase = this._getApiBase(connectionType);
    const isIgLogin = connectionType === 'instagram_login';
    try {
      const body = {
        recipient: { comment_id: String(commentId) },
        message: { text: message }
      };
      if (!isIgLogin) {
        body.messaging_type = 'RESPONSE';
      }
      const response = await axios.post(
        `${apiBase}/${pageId}/messages`,
        body,
        { params: this._metaGraphParams({ access_token: accessToken }) }
      );

      return {
        success: true,
        platformResponseId: response.data.message_id
      };
    } catch (error) {
      const apiError = error.response?.data?.error;
      const userMsg = apiError?.message || error.message;
      const err = new Error(userMsg);
      err.platformError = apiError;
      err.statusCode = error.response?.status;
      throw err;
    }
  }

  /**
   * Send an attachment (image, video, or file) to an Instagram DM recipient.
   * @param {string} [localFilePath] - If provided, uploads the file directly via
   *   multipart form-data instead of passing a URL for the platform to download.
   */
  async sendMessageWithAttachment(recipientId, attachmentType, attachmentUrl, caption, accessToken, pageId, useHumanAgentTag = true, localFilePath = null, connectionType = null) {
    if (!recipientId || !attachmentType || !accessToken || !pageId) {
      return { success: false, error: 'Missing recipientId, attachmentType, accessToken, or pageId' };
    }
    const allowedTypes = ['image', 'video', 'file', 'audio'];
    if (!allowedTypes.includes(attachmentType)) {
      return { success: false, error: `attachmentType must be one of: ${allowedTypes.join(', ')}` };
    }
    const apiBase = this._getApiBase(connectionType);
    const isIgLogin = connectionType === 'instagram_login';
    const fs = require('fs');
    const FormData = require('form-data');
    const useDirectUpload = localFilePath && fs.existsSync(localFilePath);

    try {
      const apiUrl = `${apiBase}/${pageId}/messages`;
      const platformType = attachmentType;

      // ── Instagram Login path: simple body, no messaging_type/tag ──
      if (isIgLogin) {
        const sendIgLogin = async () => {
          if (useDirectUpload) {
            const form = new FormData();
            form.append('recipient', JSON.stringify({ id: recipientId }));
            form.append('message', JSON.stringify({
              attachment: { type: platformType, payload: { is_reusable: false } }
            }));
            form.append('filedata', fs.createReadStream(localFilePath));
            return axios.post(apiUrl, form, {
              params: this._metaGraphParams({ access_token: accessToken }),
              headers: form.getHeaders(),
              timeout: 30000,
              maxContentLength: 100 * 1024 * 1024
            });
          }
          return axios.post(apiUrl, {
            recipient: { id: recipientId },
            message: {
              attachment: {
                type: platformType,
                payload: { url: attachmentUrl, is_reusable: false }
              }
            }
          }, { params: this._metaGraphParams({ access_token: accessToken }) });
        };

        const response = await sendIgLogin();
        if (caption && caption.trim()) {
          await this.sendMessage(recipientId, caption.trim(), accessToken, pageId, false, connectionType);
        }
        return { success: true, platformResponseId: response.data?.message_id };
      }

      // ── Facebook Login path: thread control + messaging_type/tag ──
      await axios.post(`${apiBase}/${pageId}/take_thread_control`, null, {
        params: this._metaGraphParams({ recipient_id: recipientId, access_token: accessToken })
      }).catch(() => {});

      const sendRequest = async (useTag) => {
        if (useDirectUpload) {
          const form = new FormData();
          form.append('recipient', JSON.stringify({ id: recipientId }));
          form.append('messaging_type', useTag ? 'MESSAGE_TAG' : 'RESPONSE');
          if (useTag) form.append('tag', 'HUMAN_AGENT');
          form.append('message', JSON.stringify({
            attachment: { type: platformType, payload: { is_reusable: false } }
          }));
          form.append('filedata', fs.createReadStream(localFilePath));
          return axios.post(apiUrl, form, {
            params: this._metaGraphParams({ access_token: accessToken }),
            headers: form.getHeaders(),
            timeout: 30000,
            maxContentLength: 100 * 1024 * 1024
          });
        }
        const body = {
          recipient: { id: recipientId },
          messaging_type: useTag ? 'MESSAGE_TAG' : 'RESPONSE',
          tag: useTag ? 'HUMAN_AGENT' : undefined,
          message: {
            attachment: {
              type: platformType,
              payload: { url: attachmentUrl, is_reusable: false }
            }
          }
        };
        if (!useTag) delete body.tag;
        return axios.post(apiUrl, body, {
          params: this._metaGraphParams({ access_token: accessToken })
        });
      };

      let response;
      try {
        response = await sendRequest(useHumanAgentTag);
      } catch (tagErr) {
        if (tagErr.response?.data?.error?.code === 10 || (tagErr.response?.data?.error?.message || '').toLowerCase().includes('human agent')) {
          response = await sendRequest(false);
        } else {
          throw tagErr;
        }
      }
      if (caption && caption.trim()) {
        await this.sendMessage(recipientId, caption.trim(), accessToken, pageId, false);
      }
      return { success: true, platformResponseId: response.data?.message_id };
    } catch (error) {
      const apiError = error.response?.data?.error;
      const msg = apiError?.message || apiError?.error_user_msg || error.message;
      console.error('[Instagram] sendMessageWithAttachment error:', msg);
      return { success: false, error: msg };
    }
  }

  /**
   * Resolve a /api/posts/media/:filename URL to the local disk path.
   * Returns null when the URL is not a local media URL or the file is absent.
   */
  _resolveLocalMediaPath(mediaUrl) {
    if (!mediaUrl) return null;
    const match = String(mediaUrl).match(/\/api\/posts\/media\/([^?#]+)$/);
    if (!match) return null;
    const fsSync = require('fs');
    const pathLib = require('path');
    const filename = pathLib.basename(match[1]);
    const candidate = pathLib.join(__dirname, '../../../uploads/posts', filename);
    return fsSync.existsSync(candidate) ? candidate : null;
  }

  /**
   * Upload an image binary directly to Meta's servers using multipart/form-data
   * (source parameter). This bypasses the URL-fetch step entirely, which avoids
   * the "media could not be fetched" CDN error (9004 / 2207052) that occurs when
   * Meta's CDN cannot reach the hosting server from the public internet.
   *
   * Supported by graph.facebook.com (Facebook Login) and graph.instagram.com
   * (Instagram Login) for image containers. Videos require the resumable upload
   * API and are not handled here.
   *
   * @returns {Promise<string>} container ID
   * @throws if the API call fails
   */
  async _createImageContainerBinary(platformConnection, { caption, localFilePath }) {
    const FormData = require('form-data');
    const fsLib = require('fs');

    const { accessToken } = platformConnection;
    const accountPath = this._accountPath(platformConnection);
    const apiBase = this._getApiBase(this._connectionType(platformConnection));

    const form = new FormData();
    form.append('source', fsLib.createReadStream(localFilePath));
    form.append('caption', caption || '');
    form.append('access_token', accessToken);

    console.log(`📤 [Instagram] Binary image upload to ${apiBase}/${accountPath}/media`);

    const response = await axios.post(
      `${apiBase}/${accountPath}/media`,
      form,
      {
        headers: form.getHeaders(),
        timeout: 60000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      }
    );

    console.log(`✅ [Instagram] Binary container created: ${response.data.id}`);
    return response.data.id;
  }

  /**
   * Create Instagram Media Container
   * Step 1 of publishing process.
   *
   * Strategy for images:
   *   1. If the mediaUrl resolves to a local disk file, attempt a binary
   *      (multipart source) upload — this bypasses Meta's CDN fetch step,
   *      which can fail when the hosting server is not reachable from Meta's
   *      IP ranges (error 9004 / subcode 2207052).
   *   2. On any binary-upload failure, fall back to the image_url approach.
   *
   * Videos always use the URL approach (resumable upload is handled elsewhere).
   */
  async createMediaContainer(platformConnection, { caption, mediaUrl, mediaType }) {
    const { accessToken } = platformConnection;
    const accountPath = this._accountPath(platformConnection);
    const apiBase = this._getApiBase(this._connectionType(platformConnection));

    if (!accountPath || accountPath === 'undefined') {
      throw new Error('Instagram Business Account ID not found');
    }

    console.log(`📸 [Instagram] Creating media container for account: ${accountPath}`);

    // ── Binary-first path for images ──────────────────────────────────────────
    if (mediaType === 'image') {
      const localFilePath = this._resolveLocalMediaPath(mediaUrl);
      if (localFilePath) {
        try {
          const containerId = await this._createImageContainerBinary(
            platformConnection, { caption, localFilePath }
          );
          return { containerId, mediaType };
        } catch (binaryErr) {
          const apiErr = binaryErr.response?.data?.error;
          console.warn(
            `⚠️  [Instagram] Binary upload failed (${apiErr?.code ?? binaryErr.message}), falling back to image_url`
          );
          // Fall through to URL-based approach below
        }
      }
    }

    // ── URL-based path (images without local file, or binary-upload fallback) ─
    try {
      const params = { access_token: accessToken, caption: caption || '' };

      if (mediaType === 'image') {
        params.image_url = mediaUrl;
      } else if (mediaType === 'video') {
        params.media_type = 'VIDEO';
        params.video_url = mediaUrl;
      } else {
        throw new Error('Invalid media type. Must be "image" or "video"');
      }

      const response = await axios.post(
        `${apiBase}/${accountPath}/media`,
        null,
        { params }
      );

      console.log(`✅ [Instagram] Media container created:`, response.data.id);
      return { containerId: response.data.id, mediaType };
    } catch (error) {
      console.error('❌ [Instagram] Create container error:', error.response?.data || error.message);

      const apiError = error.response?.data?.error;
      if (apiError) {
        const detailedError = new Error(apiError.message || 'Failed to create media container');
        detailedError.platformError = {
          title: apiError.error_user_title || 'Instagram Error',
          message: apiError.message || apiError.error_user_msg,
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
  async checkContainerStatus(accessToken, containerId, maxAttempts = 30, connectionType = null) {
    const apiBase = this._getApiBase(connectionType);
    console.log(`⏳ [Instagram] Checking container status: ${containerId}`);

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await axios.get(
          `${apiBase}/${containerId}`,
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
      const accountPath = this._accountPath(platformConnection);
      const apiBase = this._getApiBase(this._connectionType(platformConnection));

      console.log(`📤 [Instagram] Publishing container: ${containerId}`);

      const response = await axios.post(
        `${apiBase}/${accountPath}/media_publish`,
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
          `${apiBase}/${postId}`,
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
          message: apiError.message || apiError.error_user_msg,
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
      await this.checkContainerStatus(platformConnection.accessToken, containerId, mediaType === 'video' ? 30 : 5, this._connectionType(platformConnection));

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
      const accountPath = this._accountPath(platformConnection);
      const connType = this._connectionType(platformConnection);
      const apiBase = this._getApiBase(connType);

      console.log(`📖 [Instagram] Starting story creation for account: ${accountPath}`);

      // Pre-check: Verify URL is publicly accessible (skipped when binary upload succeeds)
      // Step 1: Create story container — binary-first for local images
      let containerId;

      if (mediaType === 'image') {
        const localFilePath = this._resolveLocalMediaPath(mediaUrl);
        if (localFilePath) {
          try {
            const FormData = require('form-data');
            const fsLib = require('fs');
            const form = new FormData();
            form.append('source', fsLib.createReadStream(localFilePath));
            form.append('media_type', 'STORIES');
            form.append('access_token', accessToken);
            console.log(`📤 [Instagram] Binary story upload`);
            const bRes = await axios.post(`${apiBase}/${accountPath}/media`, form, {
              headers: form.getHeaders(), timeout: 60000,
              maxContentLength: Infinity, maxBodyLength: Infinity
            });
            containerId = bRes.data.id;
            console.log(`✅ [Instagram] Story container (binary) created: ${containerId}`);
          } catch (bErr) {
            console.warn(`⚠️  [Instagram] Binary story upload failed, falling back to image_url: ${bErr.response?.data?.error?.message ?? bErr.message}`);
          }
        }
      }

      if (!containerId) {
        // URL-based fallback (or video path)
        await this.verifyMediaUrlAccessible(mediaUrl);
        const params = { access_token: accessToken, media_type: 'STORIES' };
        if (mediaType === 'image') params.image_url = mediaUrl;
        else if (mediaType === 'video') params.video_url = mediaUrl;
        else throw new Error('Invalid media type. Must be "image" or "video"');
        console.log(`📸 [Instagram] Creating story container (URL)`);
        const containerResponse = await axios.post(`${apiBase}/${accountPath}/media`, null, { params });
        containerId = containerResponse.data.id;
        console.log(`✅ [Instagram] Story container created: ${containerId}`);
      }

      if (mediaType === 'video') {
        await this.checkContainerStatus(accessToken, containerId, 30, connType);
      }

      console.log(`📤 [Instagram] Publishing story container: ${containerId}`);
      const publishResponse = await axios.post(
        `${apiBase}/${accountPath}/media_publish`,
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
          message: apiError.message || apiError.error_user_msg,
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
      const accountPath = this._accountPath(platformConnection);
      const connType = this._connectionType(platformConnection);
      const apiBase = this._getApiBase(connType);

      console.log(`🎬 [Instagram] Starting reel creation for account: ${accountPath}`);
      console.log(`📹 [Instagram] Video URL: ${mediaUrl}`);

      await this.verifyMediaUrlAccessible(mediaUrl);

      const params = {
        access_token: accessToken,
        media_type: 'REELS',
        video_url: mediaUrl,
        caption: caption || '',
        share_to_feed: true
      };

      console.log(`📹 [Instagram] Creating reel container with params:`, {
        media_type: params.media_type,
        video_url: params.video_url,
        share_to_feed: params.share_to_feed
      });
      const containerResponse = await axios.post(
        `${apiBase}/${accountPath}/media`,
        null,
        { params }
      );

      const containerId = containerResponse.data.id;
      console.log(`✅ [Instagram] Reel container created: ${containerId}`);

      await this.checkContainerStatus(accessToken, containerId, 30, connType);

      console.log(`📤 [Instagram] Publishing reel container: ${containerId}`);
      const publishResponse = await axios.post(
        `${apiBase}/${accountPath}/media_publish`,
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
          `${apiBase}/${reelId}`,
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
          message: apiError.message || apiError.error_user_msg,
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
      const accountPath = this._accountPath(platformConnection);
      const apiBase = this._getApiBase(this._connectionType(platformConnection));

      if (!mediaUrls || mediaUrls.length === 0) {
        throw new Error('At least one media URL is required for carousel posts');
      }

      if (mediaUrls.length > 10) {
        throw new Error('Maximum 10 media items allowed in carousel');
      }

      console.log(`📸 [Instagram] Creating carousel with ${mediaUrls.length} items`);

      // Step 1: Create containers for each media item (binary-first for images)
      const containerIds = [];
      for (let i = 0; i < mediaUrls.length; i++) {
        const mediaItem = mediaUrls[i];
        let itemContainerId = null;

        if (mediaItem.type === 'image') {
          const localFilePath = this._resolveLocalMediaPath(mediaItem.url);
          if (localFilePath) {
            try {
              const FormData = require('form-data');
              const fsLib = require('fs');
              const form = new FormData();
              form.append('source', fsLib.createReadStream(localFilePath));
              form.append('is_carousel_item', 'true');
              form.append('access_token', accessToken);
              const bRes = await axios.post(`${apiBase}/${accountPath}/media`, form, {
                headers: form.getHeaders(), timeout: 60000,
                maxContentLength: Infinity, maxBodyLength: Infinity
              });
              itemContainerId = bRes.data.id;
              console.log(`✅ [Instagram] Carousel item ${i + 1} binary created: ${itemContainerId}`);
            } catch (bErr) {
              console.warn(`⚠️  [Instagram] Binary carousel item ${i + 1} failed, falling back to URL: ${bErr.response?.data?.error?.message ?? bErr.message}`);
            }
          }
        }

        if (!itemContainerId) {
          await this.verifyMediaUrlAccessible(mediaItem.url);
          const params = { access_token: accessToken, is_carousel_item: true };
          if (mediaItem.type === 'image') {
            params.image_url = mediaItem.url;
          } else if (mediaItem.type === 'video') {
            params.media_type = 'VIDEO';
            params.video_url = mediaItem.url;
          }
          const response = await axios.post(`${apiBase}/${accountPath}/media`, null, { params });
          itemContainerId = response.data.id;
          console.log(`✅ [Instagram] Carousel item ${i + 1} (URL) created: ${itemContainerId}`);
        }

        containerIds.push(itemContainerId);
      }

      // Step 2: Create carousel container
      const carouselResponse = await axios.post(
        `${apiBase}/${accountPath}/media`,
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
          message: apiError.message || apiError.error_user_msg,
          code: apiError.code,
          subcode: apiError.error_subcode,
          type: apiError.type
        };
        throw detailedError;
      }
      
      throw new Error('Failed to create carousel post');
    }
  }

  /**
   * Given an Instagram URL or shortcode (e.g. "DWmafyLADDF" or
   * "https://www.instagram.com/p/DWmafyLADDF/"), look up all media for the
   * connected Instagram account and return the numeric media ID that matches.
   *
   * Returns { numericId, shortcode } on success, or null if not found / on error.
   * Scans up to the 200 most-recent posts (2 pages of 100).
   *
   * @param {string} igUserId  - The connected IG business account user ID
   * @param {string} accessToken
   * @param {string} input     - shortcode or full Instagram post URL
   */
  async resolveShortcodeToMediaId(igUserId, accessToken, input) {
    // Extract shortcode — handles instagram.com/p/SC and instagram.com/username/p/SC
    const urlMatch = input && input.match(/instagram\.com\/(?:[^/?#]+\/)?p\/([A-Za-z0-9_-]+)/);
    const shortcode = urlMatch ? urlMatch[1] : (input || '').trim();

    if (!shortcode) return null;

    // If the input is already a numeric ID, no resolution needed
    if (/^\d+$/.test(shortcode)) {
      return { numericId: shortcode, shortcode: null };
    }

    const fields = 'id,shortcode';
    let url = `${this.baseUrl}/${igUserId}/media`;
    let pagesChecked = 0;

    try {
      while (url && pagesChecked < 2) {
        const response = await axios.get(url, {
          params: pagesChecked === 0 ? { fields, limit: 100, access_token: accessToken } : { access_token: accessToken },
          timeout: 10000
        });

        const items = response.data?.data || [];
        const match = items.find(m => m.shortcode === shortcode);
        if (match) {
          return { numericId: match.id, shortcode: match.shortcode };
        }

        // Next page
        url = response.data?.paging?.next || null;
        pagesChecked++;
      }
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.warn(`[Instagram] resolveShortcodeToMediaId failed for shortcode="${shortcode}":`, msg);
    }

    return null;
  }

  /**
   * Resolve a numeric Graph API media ID to its public Instagram shortcode permalink.
   * e.g. "18104377792903993" → "https://www.instagram.com/p/DWfGl70lIGM/"
   * Returns null if the call fails or the ID is not a valid media.
   */
  async fetchMediaPermalink(accessToken, mediaId) {
    if (!accessToken || !mediaId) return null;
    try {
      const response = await axios.get(`${this.baseUrl}/${mediaId}`, {
        params: { fields: 'permalink', access_token: accessToken },
        timeout: 8000
      });
      const permalink = response.data?.permalink;
      if (permalink) {
        console.log(`[Instagram] Resolved media ${mediaId} → ${permalink}`);
        return permalink;
      }
    } catch (err) {
      console.warn(`[Instagram] fetchMediaPermalink failed for ${mediaId}:`, err?.response?.data?.error?.message || err.message);
    }
    return null;
  }
}

module.exports = new InstagramService();
