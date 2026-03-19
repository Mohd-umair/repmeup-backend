const axios = require('axios');
const Interaction = require('../../models/Interaction');

// Currently active Marketing API version (YYYYMM). Update when LinkedIn sunsets older versions.
const LINKEDIN_API_VERSION = '202510';

class LinkedInService {
  constructor() {
    this.apiURL = 'https://api.linkedin.com/v2';
  }

  /**
   * URN used to list posts during sync (same author as where content lives).
   * Company Page when org URN exists unless LINKEDIN_POST_AS_PERSON forces member;
   * otherwise member/person URN so personal-only connections still sync.
   */
  resolveSyncAuthorUrn(connection) {
    const organizationUrn = connection.platformData?.organizationUrn;
    const personUrn =
      connection.platformData?.personUrn ||
      (connection.platformUserId ? `urn:li:person:${connection.platformUserId}` : null);
    const postAsPerson = process.env.LINKEDIN_POST_AS_PERSON === 'true';
    if (postAsPerson && personUrn) return personUrn;
    if (organizationUrn) return organizationUrn;
    return personUrn;
  }

  /**
   * Normalize a v2 ugcPosts element into the shape used by sync (id + commentary).
   */
  normalizeUgcPostElement(el) {
    if (!el || typeof el !== 'object') return el;
    let commentary = el.commentary;
    const share = el.specificContent?.['com.linkedin.ugc.ShareContent'];
    if (!commentary && share?.shareCommentary?.text) {
      commentary = share.shareCommentary.text;
    }
    return {
      ...el,
      id: el.id,
      commentary: commentary || ''
    };
  }

  /**
   * List posts by author via v2 ugcPosts finder (works for person and org when permitted).
   * GET /v2/ugcPosts?q=authors&authors=List(urlEncodedUrn)
   * LinkedIn returns ugcPosts.FINDER-authors.NO_VERSION without LinkedIn-Version header.
   * @see https://learn.microsoft.com/en-us/linkedin/compliance/integrations/shares/ugc-post-api
   */
  async fetchPostsByAuthorUgcV2(accessToken, authorUrn, limit = 50) {
    const encodedUrn = encodeURIComponent(authorUrn);
    const authorsParam = `List(${encodedUrn})`;
    const count = Math.min(limit, 100);
    const url = `${this.apiURL}/ugcPosts?q=authors&authors=${authorsParam}&count=${count}&sortBy=LAST_MODIFIED`;
    const versionsToTry = [LINKEDIN_API_VERSION, '202511', '202509', '202506', '202505'];
    let lastError;

    for (const linkedInVersion of versionsToTry) {
      try {
        const response = await axios.get(url, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': linkedInVersion
          }
        });
        const elements = response.data?.elements || [];
        const normalized = elements.map(e => this.normalizeUgcPostElement(e));
        if (normalized.length > 0) {
          console.log(
            `📊 [LinkedIn] v2 ugcPosts finder (${linkedInVersion}): ${normalized.length} post(s) for author`
          );
        }
        return normalized;
      } catch (error) {
        lastError = error;
        const status = error.response?.status;
        const code = error.response?.data?.code;
        const message = (error.response?.data?.message || '').toLowerCase();
        // 403 ACCESS_DENIED is a product/scope gate — do not spin versions (message may contain "NO_VERSION" as permission id)
        if (status === 403 || code === 'ACCESS_DENIED') {
          console.warn(
            '⚠️  [LinkedIn] v2 ugcPosts finder denied (scopes/product).',
            error.response?.data || error.message
          );
          break;
        }
        const isVersionError =
          code === 'INVALID_VERSION' ||
          code === 'NONEXISTENT_VERSION' ||
          message.includes('not active') ||
          message.includes('is not active');
        if (isVersionError) {
          console.warn(
            `⚠️  [LinkedIn] ugcPosts finder version ${linkedInVersion} rejected, trying next...`
          );
          continue;
        }
        console.warn(
          '⚠️  [LinkedIn] v2 ugcPosts finder failed:',
          error.response?.data || error.message
        );
        break;
      }
    }
    if (lastError && lastError.response?.status !== 403) {
      console.warn(
        '⚠️  [LinkedIn] v2 ugcPosts finder exhausted versions:',
        lastError.response?.data || lastError.message
      );
    }
    return [];
  }

  /**
   * List posts by author — REST Posts API (LinkedIn docs: Find Posts by Authors).
   * Query param order matters for Rest.li: **author** must appear before **q=author**
   * (axios `params` object order can produce ILLEGAL_ARGUMENT otherwise).
   * Note: Some tenants return 400 for person URNs here; use ugcPosts for members in that case.
   */
  async fetchPostsByAuthorREST(accessToken, authorUrn, limit = 50) {
    const versionsToTry = [LINKEDIN_API_VERSION, '202511', '202509'];
    const count = Math.min(limit, 100);
    const encAuthor = encodeURIComponent(authorUrn);
    let lastError;

    for (const linkedInVersion of versionsToTry) {
      try {
        const url = `https://api.linkedin.com/rest/posts?author=${encAuthor}&q=author&count=${count}&sortBy=LAST_MODIFIED`;
        const response = await axios.get(url, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': linkedInVersion
          }
        });
        const elements = response.data?.elements || [];
        if (elements.length > 0) {
          console.log(`📊 [LinkedIn] REST posts finder: ${elements.length} post(s) for author`);
        }
        return elements;
      } catch (error) {
        lastError = error;
        const status = error.response?.status;
        const code = error.response?.data?.code;
        const message = (error.response?.data?.message || '').toLowerCase();
        if (status === 403 || code === 'ACCESS_DENIED') {
          console.warn(
            '⚠️  [LinkedIn] REST posts finder denied (partnerApiPostsExternal / Community Management).',
            error.response?.data || error.message
          );
          break;
        }
        const isVersionError =
          code === 'INVALID_VERSION' ||
          code === 'NONEXISTENT_VERSION' ||
          message.includes('not active') ||
          message.includes('is not active');
        if (isVersionError) {
          console.warn(`⚠️  [LinkedIn] REST posts finder version ${linkedInVersion} failed, trying next...`);
          continue;
        }
        console.warn(
          '⚠️  [LinkedIn] REST posts finder failed:',
          error.response?.data || error.message
        );
        break;
      }
    }
    return [];
  }

  /**
   * Post URN for socialActions (share or ugcPost) from a post element.
   */
  resolvePostUrn(post) {
    const id = post?.id || post?.['$URN'];
    if (!id) return null;
    if (String(id).startsWith('urn:li:')) return id;
    return null;
  }

  /**
   * Fetch all interactions (posts and comments) from LinkedIn
   */
  async fetchAllInteractions(connection) {
    try {
      console.log('🔄 [LinkedIn] Starting sync for organization:', connection.platformData?.organizationName || 'Personal');
      
      const accessToken = connection.accessToken;
      const authorUrn = this.resolveSyncAuthorUrn(connection);

      if (!authorUrn) {
        console.log('⚠️  [LinkedIn] No author URN (organization or person). Reconnect LinkedIn.');
        return { count: 0, interactions: [] };
      }

      console.log(`🔄 [LinkedIn] Sync author URN: ${authorUrn}`);

      const allInteractions = [];

      const isPersonAuthor = authorUrn.includes('urn:li:person:');

      // Member/personal: /rest/posts often returns ILLEGAL_ARGUMENT; try ugcPosts first.
      // Organization: REST with correct param order first, then ugcPosts, then legacy v2 /posts.
      let posts = [];
      if (isPersonAuthor) {
        posts = await this.fetchPostsByAuthorUgcV2(accessToken, authorUrn);
        if (posts.length === 0) {
          posts = await this.fetchPostsByAuthorREST(accessToken, authorUrn);
        }
      } else {
        posts = await this.fetchPostsByAuthorREST(accessToken, authorUrn);
        if (posts.length === 0) {
          posts = await this.fetchPostsByAuthorUgcV2(accessToken, authorUrn);
        }
      }
      if (posts.length === 0) {
        posts = await this.fetchOrganizationPosts(accessToken, authorUrn);
      }

      if (posts.length === 0) {
        console.warn(
          '⚠️  [LinkedIn] No posts to sync — check logs above for 403/400.\n' +
            '  • partnerApiPostsExternal.FINDER-author (403) → Community Management API approval + org token scopes (e.g. r_organization_social).\n' +
            '  • ugcPosts.FINDER-authors… (403) → LinkedIn is denying the authors finder; same tier/scopes as listing UGC (org or member read).\n' +
            '    (".NO_VERSION" in the message is LinkedIn’s permission id, not “missing header” — requests already send LinkedIn-Version.)\n' +
            '  • ILLEGAL_ARGUMENT on v2/posts → legacy finder rejected; harmless if REST/ugc work after approval.\n' +
            'Reconnect LinkedIn after LinkedIn enables products/scopes on your app.'
        );
      } else {
        console.log(`📊 [LinkedIn] Found ${posts.length} posts to scan for comments`);
      }
      
      // For each post, fetch comments
      for (const post of posts) {
        const postUrn = this.resolvePostUrn(post);
        if (!postUrn) {
          console.warn('⚠️  [LinkedIn] Skipping post without URN id:', JSON.stringify(post).slice(0, 200));
          continue;
        }

        // Fetch comments for this post
        const comments = await this.fetchPostComments(accessToken, postUrn);
        console.log(`💬 [LinkedIn] Found ${comments.length} comments for post ${postUrn}`);
        
        // Transform comments to interactions
        for (const comment of comments) {
          const commentInteraction = await this.transformCommentToInteraction(comment, post, connection);
          allInteractions.push(commentInteraction);
        }
      }

      // Upsert interactions to database
      let savedCount = 0;
      for (const interactionData of allInteractions) {
        try {
          const { status, isRead, sentiment, ...platformFields } = interactionData;
          await Interaction.findOneAndUpdate(
            {
              platformId: interactionData.platformId,
              organization: connection.organization
            },
            {
              $set: platformFields,
              $setOnInsert: { status: 'unread', isRead: false, sentiment: sentiment ?? null }
            },
            {
              upsert: true,
              new: true,
              setDefaultsOnInsert: true
            }
          );
          savedCount++;
        } catch (error) {
          console.error(`❌ [LinkedIn] Failed to save interaction ${interactionData.platformId}:`, error.message);
        }
      }

      console.log(`✅ [LinkedIn] Sync complete: ${savedCount} interactions saved`);
      
      // Update connection stats
      await connection.updateSyncStats(savedCount, true);
      
      return {
        count: savedCount,
        interactions: allInteractions
      };
    } catch (error) {
      console.error('❌ [LinkedIn] Sync error:', error.message);
      console.error('❌ [LinkedIn] Error details:', error.response?.data || error);
      
      // Log error to connection
      if (connection && connection.logError) {
        await connection.logError(error);
      }
      
      // Return error details instead of throwing
      const errorMessage = error.response?.data?.message || 
                          error.response?.data?.error_description ||
                          error.message || 
                          'Failed to sync LinkedIn';
      
      // Check for specific LinkedIn API errors
      if (error.response?.status === 403) {
        throw new Error('LinkedIn API access denied. Please ensure "Share on LinkedIn" product is approved and r_organization_social scope is enabled.');
      } else if (error.response?.status === 401) {
        throw new Error('LinkedIn access token expired. Please reconnect your LinkedIn account.');
      } else if (error.response?.status === 404) {
        throw new Error('LinkedIn organization not found. Please verify you are an admin of the Company Page.');
      }
      
      throw new Error(`LinkedIn sync failed: ${errorMessage}`);
    }
  }

  /**
   * Legacy v2 /posts finder (last resort). Same Rest.li rule: author before q=author.
   */
  async fetchOrganizationPosts(accessToken, authorUrn, limit = 50) {
    const count = Math.min(limit, 100);
    const encAuthor = encodeURIComponent(authorUrn);
    const url = `${this.apiURL}/posts?author=${encAuthor}&q=author&count=${count}&sortBy=LAST_MODIFIED`;
    const versionsToTry = [LINKEDIN_API_VERSION, '202511', '202509'];
    let lastError;

    for (const linkedInVersion of versionsToTry) {
      try {
        const response = await axios.get(url, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': linkedInVersion
          }
        });
        const elements = response.data?.elements || [];
        if (elements.length > 0) {
          console.log(`📊 [LinkedIn] Legacy v2 /posts: ${elements.length} post(s)`);
        }
        return elements;
      } catch (error) {
        lastError = error;
        const status = error.response?.status;
        const code = error.response?.data?.code;
        const message = (error.response?.data?.message || '').toLowerCase();
        if (status === 403 || code === 'ACCESS_DENIED') break;
        const isVersionError =
          code === 'INVALID_VERSION' ||
          code === 'NONEXISTENT_VERSION' ||
          message.includes('not active') ||
          message.includes('is not active');
        if (isVersionError) continue;
        console.error('❌ [LinkedIn] Legacy v2 /posts failed:', error.response?.data || error.message);
        break;
      }
    }
    return [];
  }

  /**
   * Fetch comments for a post (share or ugcPost URN).
   * Prefer REST socialActions (current LinkedIn docs); fall back to v2.
   */
  async fetchPostComments(accessToken, postUrn) {
    const versionsToTry = [LINKEDIN_API_VERSION, '202511', '202509'];
    const encoded = encodeURIComponent(postUrn);

    for (const linkedInVersion of versionsToTry) {
      try {
        const response = await axios.get(
          `https://api.linkedin.com/rest/socialActions/${encoded}/comments`,
          {
            params: { count: 100 },
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'X-Restli-Protocol-Version': '2.0.0',
              'LinkedIn-Version': linkedInVersion
            }
          }
        );
        return response.data?.elements || [];
      } catch (error) {
        const code = error.response?.data?.code;
        const message = (error.response?.data?.message || '').toLowerCase();
        const isVersionError =
          code === 'INVALID_VERSION' ||
          code === 'NONEXISTENT_VERSION' ||
          message.includes('version') ||
          message.includes('not active');
        if (isVersionError) continue;
        console.warn(
          '⚠️  [LinkedIn] REST comments failed, trying v2:',
          error.response?.data?.message || error.message
        );
        break;
      }
    }

    try {
      const response = await axios.get(
        `${this.apiURL}/socialActions/${encodeURIComponent(postUrn)}/comments`,
        {
          params: { count: 100 },
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': LINKEDIN_API_VERSION
          }
        }
      );
      return response.data.elements || [];
    } catch (error) {
      console.error('❌ [LinkedIn] Failed to fetch comments:', error.response?.data || error.message);
      return [];
    }
  }

  /**
   * Transform LinkedIn post to Interaction model
   */
  async transformPostToInteraction(post, connection) {
    const postId = post.id || post['$URN'];
    
    return {
      platformId: postId,
      platform: 'linkedin',
      type: 'post',
      content: post.commentary || post.text || '',
      author: {
        id: post.author,
        name: connection.platformData?.organizationName || 'Organization',
        username: connection.platformUsername,
        profilePicture: connection.platformProfilePicture
      },
      platformCreatedAt: new Date(post.createdAt || post.created?.time),
      platformUrl: post.permalink || `https://www.linkedin.com/feed/update/${postId}`,
      metadata: {
        likes: post.likesSummary?.totalLikes || 0,
        comments: post.commentsSummary?.totalComments || 0,
        shares: post.sharesSummary?.totalShares || 0,
        visibility: post.visibility || 'PUBLIC'
      },
      organization: connection.organization,
      platformConnection: connection._id,
      status: 'unread'
    };
  }

  /**
   * Transform LinkedIn comment to Interaction model
   */
  async transformCommentToInteraction(comment, post, connection) {
    const postId = this.resolvePostUrn(post) || post.id || post['$URN'];
    const commentId =
      comment.commentUrn || comment.id || comment['$URN'] || `${postId}:${comment.id}`;

    return {
      platformId: commentId,
      platform: 'linkedin',
      type: 'comment',
      content: comment.message?.text || comment.text || '',
      author: {
        id: comment.actor || comment.author,
        name: comment.actor ? 'LinkedIn User' : 'Unknown',
        username: null,
        profilePicture: null
      },
      parentId: postId,
      platformCreatedAt: new Date(
        comment.created?.time || comment.createdAt || comment.lastModified?.time
      ),
      platformUrl: `https://www.linkedin.com/feed/update/${postId}`,
      metadata: {
        likes: comment.likesSummary?.totalLikes || 0,
        postContent: post.commentary || post.text || ''
      },
      organization: connection.organization,
      platformConnection: connection._id,
      status: 'unread'
    };
  }

  /**
   * Reply to a LinkedIn comment
   */
  async replyToComment(connection, interactionId, replyText) {
    try {
      const interaction = await Interaction.findById(interactionId);
      
      if (!interaction) {
        throw new Error('Interaction not found');
      }

      const accessToken = connection.accessToken;
      const parentCommentUrn = interaction.platformId;
      const postUrn = interaction.parentId;

      console.log('💬 [LinkedIn] Replying to comment:', parentCommentUrn);

      const response = await axios.post(
        `${this.apiURL}/socialActions/${encodeURIComponent(postUrn)}/comments`,
        {
          actor: connection.platformData?.organizationUrn,
          message: {
            text: replyText
          },
          parentComment: parentCommentUrn
        },
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': LINKEDIN_API_VERSION,
            'Content-Type': 'application/json'
          }
        }
      );

      const replyId = response.headers['x-restli-id'] || response.data.id;

      console.log('✅ [LinkedIn] Reply posted successfully:', replyId);

      return {
        status: 'sent',
        platformResponseId: replyId,
        platformUrl: `https://www.linkedin.com/feed/update/${postUrn}`
      };
    } catch (error) {
      console.error('❌ [LinkedIn] Failed to post reply:', error.response?.data || error.message);
      return {
        status: 'failed',
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Post a comment on a LinkedIn post
   */
  async postComment(connection, postUrn, commentText) {
    try {
      const accessToken = connection.accessToken;
      const organizationUrn = connection.platformData?.organizationUrn;

      console.log('💬 [LinkedIn] Posting comment on post:', postUrn);

      const response = await axios.post(
        `${this.apiURL}/socialActions/${encodeURIComponent(postUrn)}/comments`,
        {
          actor: organizationUrn,
          message: {
            text: commentText
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': LINKEDIN_API_VERSION,
            'Content-Type': 'application/json'
          }
        }
      );

      const commentId = response.headers['x-restli-id'] || response.data.id;

      console.log('✅ [LinkedIn] Comment posted successfully:', commentId);

      return {
        status: 'sent',
        platformResponseId: commentId,
        platformUrl: `https://www.linkedin.com/feed/update/${postUrn}`
      };
    } catch (error) {
      console.error('❌ [LinkedIn] Failed to post comment:', error.response?.data || error.message);
      return {
        status: 'failed',
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Upload an image for a feed post via Images API, then return urn:li:image:… for REST Posts.
   * @see https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api
   */
  async uploadImageForFeedPost(accessToken, ownerUrn, imageBuffer, contentType = 'image/jpeg') {
    const versionsToTry = [LINKEDIN_API_VERSION, '202511', '202509'];
    let lastError;

    for (const linkedInVersion of versionsToTry) {
      try {
        const initRes = await axios.post(
          'https://api.linkedin.com/rest/images?action=initializeUpload',
          { initializeUploadRequest: { owner: ownerUrn } },
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'X-Restli-Protocol-Version': '2.0.0',
              'LinkedIn-Version': linkedInVersion,
              'Content-Type': 'application/json'
            }
          }
        );

        const value = initRes.data?.value || initRes.data;
        const uploadUrl = value?.uploadUrl;
        const imageUrn = value?.image;

        if (!uploadUrl || !imageUrn) {
          throw new Error(
            `LinkedIn image init missing uploadUrl/image. Response: ${JSON.stringify(initRes.data).slice(0, 500)}`
          );
        }

        console.log(`📤 [LinkedIn] Uploading image (${imageBuffer.length} bytes) → ${imageUrn}`);

        try {
          await axios.put(uploadUrl, imageBuffer, {
            headers: { 'Content-Type': contentType },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 120000
          });
        } catch (putErr) {
          const st = putErr.response?.status;
          if (st === 400 || st === 415 || st === 406) {
            const FormData = require('form-data');
            const form = new FormData();
            const ext =
              contentType === 'image/png' ? 'png' : contentType === 'image/gif' ? 'gif' : 'jpg';
            form.append('file', imageBuffer, { filename: `post.${ext}`, contentType });
            await axios.put(uploadUrl, form, {
              headers: form.getHeaders(),
              maxBodyLength: Infinity,
              maxContentLength: Infinity,
              timeout: 120000
            });
          } else {
            throw putErr;
          }
        }

        console.log('✅ [LinkedIn] Image upload complete');
        return imageUrn;
      } catch (error) {
        lastError = error;
        const code = error.response?.data?.code;
        const message = (error.response?.data?.message || '').toLowerCase();
        const isVersionError =
          code === 'INVALID_VERSION' ||
          code === 'NONEXISTENT_VERSION' ||
          message.includes('version') ||
          message.includes('not active');
        if (isVersionError) {
          console.warn(`⚠️  [LinkedIn] Image init version ${linkedInVersion} failed, trying next...`);
          continue;
        }
        break;
      }
    }

    console.error('❌ [LinkedIn] Image upload failed:', lastError?.response?.data || lastError?.message);
    const msg =
      lastError?.response?.data?.message ||
      lastError?.response?.data?.error_description ||
      lastError?.message ||
      'Failed to upload image to LinkedIn';
    throw new Error(msg);
  }

  /**
   * Create a new LinkedIn post.
   * Uses REST Posts API only (ugcPosts is deprecated and returns NO_VERSION).
   * Supports both Person URN (w_member_social) and Organization URN (w_organization_social).
   *
   * @param {object|null} media - Optional `{ imageBuffer, contentType }` — image is uploaded to LinkedIn first.
   *        Plain URLs are not accepted; LinkedIn requires urn:li:image:… from their upload flow.
   */
  async createPost(connection, postText, media = null) {
    const accessToken = connection.accessToken;
    const organizationUrn = connection.platformData?.organizationUrn;
    const personUrn = connection.platformData?.personUrn
      ? connection.platformData.personUrn
      : `urn:li:person:${connection.platformUserId}`;

    /**
     * Default: post as Company Page when organizationUrn exists (RepMeUp org use case).
     * LinkedIn returns ACCESS_DENIED partnerApiPostsExternal.CREATE until Community Management API is approved for org posting.
     * Set LINKEDIN_POST_AS_PERSON=true to always use the member (person) as author when personUrn is available
     * (Share on LinkedIn + w_member_social). Same flag helps when org is saved but you only have member scopes.
     */
    const postAsPerson = process.env.LINKEDIN_POST_AS_PERSON === 'true';
    let author = organizationUrn || personUrn;
    if (postAsPerson && personUrn) {
      if (organizationUrn) {
        console.log(
          'ℹ️  [LinkedIn] LINKEDIN_POST_AS_PERSON=true — posting as member, not Company Page:',
          personUrn
        );
      }
      author = personUrn;
    }

    if (!author) {
      throw new Error('No LinkedIn author URN available. Reconnect your LinkedIn account.');
    }

    console.log(`📝 [LinkedIn] Creating post as ${author}...`);

    let mediaUrns = [];
    if (media?.imageBuffer && Buffer.isBuffer(media.imageBuffer)) {
      const ct = media.contentType || 'image/jpeg';
      const urn = await this.uploadImageForFeedPost(accessToken, author, media.imageBuffer, ct);
      mediaUrns = [urn];
    }

    return this._createPostREST(accessToken, author, postText, mediaUrns);
  }

  /**
   * REST Posts API — single endpoint for member and organization posting.
   * POST https://api.linkedin.com/rest/posts
   * Uses a supported LinkedIn-Version to avoid NO_VERSION / sunset errors.
   */
  async _createPostREST(accessToken, author, postText, mediaUrls = []) {
    const postData = {
      author,
      commentary: postText || ' ',
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: []
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false
    };

    if (mediaUrls.length > 0) {
      postData.content = {
        media: { title: (postText || '').substring(0, 100), id: mediaUrls[0] }
      };
    }

    // Use currently active Marketing API versions (YYYYMM). 202401/202410 are sunset.
    const versionsToTry = [LINKEDIN_API_VERSION, '202511', '202509'];
    let lastError;

    for (const linkedInVersion of versionsToTry) {
      try {
        const response = await axios.post(
          'https://api.linkedin.com/rest/posts',
          postData,
          {
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'X-Restli-Protocol-Version': '2.0.0',
              'LinkedIn-Version': linkedInVersion,
              'Content-Type': 'application/json'
            }
          }
        );

        const postId = response.headers['x-restli-id'] || response.data?.id;
        console.log('✅ [LinkedIn] Post created:', postId);
        return { postId, postUrl: `https://www.linkedin.com/feed/update/${postId}` };
      } catch (error) {
        lastError = error;
        const code = error.response?.data?.code;
        const message = (error.response?.data?.message || '').toLowerCase();
        const isVersionError = code === 'INVALID_VERSION' || code === 'NONEXISTENT_VERSION' || message.includes('version') || message.includes('not active');
        if (isVersionError) {
          console.warn(`⚠️  [LinkedIn] Version ${linkedInVersion} failed, trying next...`);
          continue;
        }
        break;
      }
    }

    console.error('❌ [LinkedIn] REST Posts API error:', lastError?.response?.data || lastError?.message);

    const apiMessage = lastError?.response?.data?.message || '';
    const isPermissionDenied = lastError?.response?.status === 403 ||
      lastError?.response?.data?.code === 'ACCESS_DENIED' ||
      apiMessage.includes('partnerApiPostsExternal') ||
      apiMessage.includes('Not enough permissions');

    if (isPermissionDenied) {
      const isOrgAuthor = author && String(author).includes('urn:li:organization');
      const hintOrg =
        'Posting as a **Company Page** requires LinkedIn to approve **Community Management API** (and scopes like w_organization_social). ' +
        'Apply in the Developer Portal → Products, or contact LinkedIn Developer Support.';
      const hintMember =
        'Posting as a **personal profile** needs the **Share on LinkedIn** product and **w_member_social** on the token. ' +
        'Set LINKEDIN_POST_AS_PERSON=true in .env to force member posting when a page is connected, then reconnect OAuth so the token includes w_member_social.';
      throw new Error(
        `LinkedIn denied post creation (partnerApiPostsExternal). ${isOrgAuthor ? hintOrg : hintMember} ` +
        `Details: ${apiMessage || 'ACCESS_DENIED'}`
      );
    }

    throw new Error(
      lastError?.response?.data?.message ||
      lastError?.response?.data?.error_description ||
      lastError?.message ||
      'Failed to create LinkedIn post'
    );
  }

  /**
   * Delete a comment
   */
  async deleteComment(connection, commentUrn) {
    try {
      const accessToken = connection.accessToken;

      console.log('🗑️  [LinkedIn] Deleting comment:', commentUrn);

      await axios.delete(
        `${this.apiURL}/socialActions/${encodeURIComponent(commentUrn)}`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': LINKEDIN_API_VERSION
          }
        }
      );

      console.log('✅ [LinkedIn] Comment deleted successfully');

      return { status: 'deleted' };
    } catch (error) {
      console.error('❌ [LinkedIn] Failed to delete comment:', error.response?.data || error.message);
      return {
        status: 'failed',
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Get post analytics
   */
  async getPostAnalytics(connection, postUrn) {
    try {
      const accessToken = connection.accessToken;

      const response = await axios.get(
        `${this.apiURL}/posts/${encodeURIComponent(postUrn)}`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': LINKEDIN_API_VERSION
          }
        }
      );

      return {
        likes: response.data.likesSummary?.totalLikes || 0,
        comments: response.data.commentsSummary?.totalComments || 0,
        shares: response.data.sharesSummary?.totalShares || 0,
        impressions: response.data.impressionCount || 0
      };
    } catch (error) {
      console.error('❌ [LinkedIn] Failed to fetch analytics:', error.response?.data || error.message);
      return null;
    }
  }
}

module.exports = new LinkedInService();

