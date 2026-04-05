const KnowledgeBase = require('../models/KnowledgeBase');
const pdf = require('pdf-parse');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { escapeRegex } = require('../utils/sanitize');
const { parsePagination, paginationMeta } = require('../utils/pagination');
const { runWithAiContextAndUsageId } = require('../services/aiRequestContext');

const KB_SOURCE_ENUM = ['manual', 'pdf', 'url', 'import'];

/**
 * Org-wide KB analytics (not filtered by list search) for dashboard sidebar.
 */
function buildKbAnalyticsPipeline(organizationMatch) {
  return [
    { $match: organizationMatch },
    {
      $facet: {
        counts: [
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              active: { $sum: { $cond: [{ $ne: ['$isActive', false] }, 1, 0] } },
              inactive: { $sum: { $cond: [{ $eq: ['$isActive', false] }, 1, 0] } },
              used: { $sum: { $cond: [{ $gt: [{ $ifNull: ['$usageCount', 0] }, 0] }, 1, 0] } },
              neverUsed: { $sum: { $cond: [{ $lte: [{ $ifNull: ['$usageCount', 0] }, 0] }, 1, 0] } },
              totalUsage: { $sum: { $ifNull: ['$usageCount', 0] } },
              avgTrainingWeight: { $avg: { $ifNull: ['$trainingWeight', 5] } },
              highWeight: {
                $sum: { $cond: [{ $gte: [{ $ifNull: ['$trainingWeight', 5] }, 9] }, 1, 0] }
              },
              midWeight: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $gte: [{ $ifNull: ['$trainingWeight', 5] }, 5] },
                        { $lte: [{ $ifNull: ['$trainingWeight', 5] }, 8] }
                      ]
                    },
                    1,
                    0
                  ]
                }
              },
              lowWeight: {
                $sum: { $cond: [{ $lte: [{ $ifNull: ['$trainingWeight', 5] }, 4] }, 1, 0] }
              }
            }
          }
        ],
        topUsed: [
          { $match: { usageCount: { $gt: 0 } } },
          { $sort: { usageCount: -1 } },
          { $limit: 8 },
          { $project: { title: 1, usageCount: 1, source: 1, type: 1 } }
        ],
        bySource: [{ $group: { _id: '$source', count: { $sum: 1 } } }],
        byType: [{ $group: { _id: '$type', count: { $sum: 1 } } }, { $sort: { count: -1 } }],
        topTags: [
          { $unwind: { path: '$tags', preserveNullAndEmptyArrays: false } },
          { $group: { _id: '$tags', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 8 }
        ]
      }
    }
  ];
}

function formatKbAnalytics(facetRow) {
  const row = facetRow || {};
  const c = row.counts?.[0] || {};
  const bySource = { manual: 0, pdf: 0, url: 0, import: 0 };
  (row.bySource || []).forEach(({ _id, count }) => {
    if (_id != null && Object.prototype.hasOwnProperty.call(bySource, _id)) {
      bySource[_id] = count;
    }
  });
  const avg = c.avgTrainingWeight;
  return {
    totalEntries: c.total || 0,
    activeCount: c.active || 0,
    inactiveCount: c.inactive || 0,
    usedEntries: c.used || 0,
    neverUsedEntries: c.neverUsed || 0,
    totalUsage: c.totalUsage || 0,
    avgTrainingWeight: avg != null ? Math.round(avg * 10) / 10 : 0,
    highWeightCount: c.highWeight || 0,
    midWeightCount: c.midWeight || 0,
    lowWeightCount: c.lowWeight || 0,
    topUsed: (row.topUsed || []).map((d) => ({
      _id: d._id,
      title: d.title,
      usageCount: d.usageCount,
      source: d.source,
      type: d.type
    })),
    bySource,
    byType: (row.byType || []).map(({ _id, count }) => ({ type: _id || 'general', count })),
    topTags: (row.topTags || []).map(({ _id, count }) => ({ tag: _id, count }))
  };
}

// Services (Dependency Injection - SOLID Principle)
const webScraperService = require('../services/webScraperService');
const contentSummarizerService = require('../services/contentSummarizerService');
const aiCreditService = require('../services/aiCreditService');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../../uploads/knowledge-base');
    try {
      await fs.mkdir(uploadDir, { recursive: true });
      cb(null, uploadDir);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

/**
 * Get knowledge base entries (paginated; same envelope as GET /api/users)
 * GET /api/knowledge-base
 */
exports.getAllKnowledgeBase = async (req, res) => {
  try {
    const { category, search, source } = req.query;
    let { page, limit } = parsePagination(req.query);
    const orgId = req.user.organization._id || req.user.organization;

    const query = { organization: orgId };

    if (category) {
      query.category = category;
    }

    if (source && KB_SOURCE_ENUM.includes(source)) {
      query.source = source;
    }

    if (search && typeof search === 'string' && search.trim()) {
      const escapedSearch = escapeRegex(search.trim());
      query.$or = [
        { title: { $regex: escapedSearch, $options: 'i' } },
        { content: { $regex: escapedSearch, $options: 'i' } },
        { tags: { $regex: escapedSearch, $options: 'i' } }
      ];
    }

    const total = await KnowledgeBase.countDocuments(query);
    const pages = Math.ceil(total / limit) || 1;
    if (page > pages) page = pages;
    const skip = (page - 1) * limit;

    const orgMatch = { organization: orgId };

    const [knowledgeBase, analyticsAgg] = await Promise.all([
      KnowledgeBase.find(query)
        .sort({ priority: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('createdBy', 'firstName lastName email')
        .lean(),
      KnowledgeBase.aggregate(buildKbAnalyticsPipeline(orgMatch))
    ]);

    const analytics = formatKbAnalytics(analyticsAgg[0]);

    res.json({
      success: true,
      data: knowledgeBase,
      pagination: paginationMeta(total, page, limit),
      analytics
    });
  } catch (error) {
    console.error('Get knowledge base error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch knowledge base'
    });
  }
};

/**
 * Get single knowledge base entry
 * GET /api/knowledge-base/:id
 */
exports.getKnowledgeBaseById = async (req, res) => {
  try {
    const knowledgeBase = await KnowledgeBase.findOne({
      _id: req.params.id,
      organization: req.user.organization
    }).populate('createdBy', 'firstName lastName email');

    if (!knowledgeBase) {
      return res.status(404).json({
        success: false,
        error: 'Knowledge base entry not found'
      });
    }

    res.json({
      success: true,
      data: knowledgeBase
    });
  } catch (error) {
    console.error('Get knowledge base by ID error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch knowledge base entry'
    });
  }
};

/**
 * Create knowledge base from manual text
 * POST /api/knowledge-base/manual
 */
exports.createManualKnowledgeBase = async (req, res) => {
  try {
    const {
      title, content, category, tags, priority, metadata,
      trainingContext, trainingWeight, isTrainingData, isActive,
      templateFields
    } = req.body;

    const knowledgeBase = new KnowledgeBase({
      title,
      content,
      category,
      tags: tags || [],
      priority: priority || 1,
      trainingContext: trainingContext || '',
      trainingWeight: trainingWeight != null ? Number(trainingWeight) : 5,
      isTrainingData: isTrainingData !== undefined ? Boolean(isTrainingData) : true,
      isActive: isActive !== undefined ? Boolean(isActive) : true,
      templateFields: Array.isArray(templateFields) ? templateFields : [],
      source: 'manual',
      metadata: metadata || {},
      organization: req.user.organization,
      createdBy: req.user.id
    });

    await knowledgeBase.save();

    res.status(201).json({
      success: true,
      data: knowledgeBase,
      message: 'Knowledge base entry created successfully'
    });
  } catch (error) {
    console.error('Create manual knowledge base error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create knowledge base entry'
    });
  }
};

/**
 * Create knowledge base from PDF
 * POST /api/knowledge-base/pdf
 */
exports.createPDFKnowledgeBase = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No PDF file uploaded'
      });
    }

    // Read and parse PDF
    const dataBuffer = await fs.readFile(req.file.path);
    const pdfData = await pdf(dataBuffer);

    const { title, category, tags, priority } = req.body;

    const knowledgeBase = new KnowledgeBase({
      title: title || req.file.originalname,
      content: pdfData.text,
      category: category || 'document',
      tags: tags ? JSON.parse(tags) : [],
      priority: priority || 1,
      source: 'pdf',
      metadata: {
        fileName: req.file.originalname,
        filePath: req.file.path,
        fileSize: req.file.size,
        pages: pdfData.numpages,
        uploadedAt: new Date()
      },
      organization: req.user.organization,
      createdBy: req.user.id
    });

    await knowledgeBase.save();

    res.status(201).json({
      success: true,
      data: knowledgeBase,
      message: 'Knowledge base created from PDF successfully'
    });
  } catch (error) {
    console.error('Create PDF knowledge base error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process PDF file'
    });
  }
};

/**
 * Create knowledge base from website URL
 * POST /api/knowledge-base/url
 * 
 * Uses WebScraperService and ContentSummarizerService (SOLID principles)
 */
exports.createURLKnowledgeBase = async (req, res) => {
  let kbCreditsDeducted = 0;
  const kbOrgId = req.user.organization._id || req.user.organization;
  try {
    const { url, title, category, tags, priority, focus = 'overview', targetWordCount, targetTagCount } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'URL is required'
      });
    }

    // Step 1: Estimate and check AI credits
    const estimatedCredits = aiCreditService.calculateCreditsFromWordCount(
      targetWordCount || 2000,
      targetTagCount || 10
    );

    console.log(`💰 [KB] Estimated credits: ${estimatedCredits}`);

    const creditCheck = await aiCreditService.checkCredits(
      req.user.organization._id || req.user.organization,
      estimatedCredits
    );

    if (!creditCheck.allowed) {
      console.warn(`❌ [KB] AI credit limit reached for org ${req.user.organization._id || req.user.organization}`);
      return res.status(403).json({
        success: false,
        error: creditCheck.error || 'Insufficient AI credits',
        code: creditCheck.code || 'AI_CREDITS_EXCEEDED',
        data: {
          current: creditCheck.current,
          limit: creditCheck.limit,
          remaining: creditCheck.remaining,
          needed: estimatedCredits,
          exceededBy: creditCheck.exceededBy
        }
      });
    }

    // Step 2: Scrape the website (WebScraperService - Single Responsibility)
    console.log(`🔍 [KB] Scraping URL: ${url}`);
    const scrapedData = await webScraperService.scrape(url);
    console.log(`✅ [KB] Scraped content length: ${scrapedData.content.length} characters`);

    // Step 2: Generate AI summary (ContentSummarizerService - Single Responsibility)
    console.log(`🤖 [KB] Generating AI summary...`);
    const { result: summaryData, aiApiUsageId } = await runWithAiContextAndUsageId(
      {
        organizationId: kbOrgId,
        userId: req.user._id,
        feature: 'knowledge_base.from_url'
      },
      () =>
        contentSummarizerService.summarize(scrapedData.content, {
          title: title || scrapedData.title,
          url: url,
          focus: focus,
          targetWordCount: targetWordCount ? parseInt(targetWordCount, 10) : undefined,
          targetTagCount: targetTagCount ? parseInt(targetTagCount, 10) : undefined
        })
    );
    console.log(`✅ [KB] Summary generated: ${summaryData.summaryLength} characters (${summaryData.compressionRatio} of original)`);

    // Step 3: Get content statistics
    const contentStats = webScraperService.getContentStats(scrapedData.content);

    // Step 4: Create knowledge base entry with AI summary
    const knowledgeBase = new KnowledgeBase({
      title: title || scrapedData.title || url,
      content: summaryData.summary, // Store AI summary, not raw dump
      category: category || 'website',
      tags: tags || summaryData.tags || [],
      keywords: summaryData.tags || [],
      priority: priority || 1,
      source: 'url',
      metadata: {
        url: url,
        scrapedAt: scrapedData.scrapedAt,
        description: scrapedData.description,
        originalContentLength: contentStats.charCount,
        originalWordCount: contentStats.wordCount,
        summaryLength: summaryData.summaryLength,
        compressionRatio: summaryData.compressionRatio,
        keyPoints: summaryData.keyPoints,
        headings: scrapedData.metadata.headings,
        ...scrapedData.metadata
      },
      organization: req.user.organization,
      createdBy: req.user.id
    });

    await knowledgeBase.save();

    // Step 5: Deduct actual AI credits used
    const actualWordCount = summaryData.summary.trim().split(/\s+/).length;
    const actualCost = aiCreditService.calculateCreditsFromWordCount(
      actualWordCount,
      summaryData.tags.length
    );

    await aiCreditService.deductCredits(
      kbOrgId,
      actualCost,
      {
        operation: 'knowledge_base_from_url',
        userId: req.user._id,
        url: url,
        wordCount: actualWordCount,
        tagCount: summaryData.tags.length
      },
      { aiApiUsageId }
    );
    kbCreditsDeducted = actualCost;

    res.status(201).json({
      success: true,
      data: {
        ...knowledgeBase.toObject(),
        summaryStats: {
          originalLength: contentStats.charCount,
          summaryLength: summaryData.summaryLength,
          compressionRatio: summaryData.compressionRatio,
          keyPointsCount: summaryData.keyPoints.length,
          tagsCount: summaryData.tags.length
        },
        creditsUsed: actualCost
      },
      message: 'Knowledge base created from URL with AI summary successfully'
    });
  } catch (error) {
    console.error('Create URL knowledge base error:', error);
    
    if (kbCreditsDeducted > 0) {
      await aiCreditService.rollbackCredits(kbOrgId, kbCreditsDeducted, { operation: 'knowledge_base_from_url', userId: req.user?._id, reason: error.message });
    }

    let errorMessage = 'Failed to process URL. Please check the URL and try again.';
    if (error.message.includes('timeout')) {
      errorMessage = 'The website took too long to respond. Please try again or use a different URL.';
    } else if (error.message.includes('not found') || error.message.includes('404')) {
      errorMessage = 'URL not found. Please check the URL and try again.';
    } else if (error.message.includes('whitelist') || error.message.includes('localhost')) {
      errorMessage = 'Invalid URL. Localhost and private IPs are not allowed.';
    } else if (error.message.includes('Insufficient content')) {
      errorMessage = 'The website has insufficient content to summarize. It may require JavaScript to render.';
    } else if (error.message.includes('Failed to summarize')) {
      errorMessage = 'Failed to generate summary. Please try again.';
    }

    res.status(500).json({
      success: false, error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * Update knowledge base entry
 * PUT /api/knowledge-base/:id
 */
exports.updateKnowledgeBase = async (req, res) => {
  try {
    const {
      title, content, category, tags, priority, metadata, isActive,
      trainingContext, trainingWeight, isTrainingData, templateFields
    } = req.body;

    const knowledgeBase = await KnowledgeBase.findOne({
      _id: req.params.id,
      organization: req.user.organization
    });

    if (!knowledgeBase) {
      return res.status(404).json({
        success: false,
        error: 'Knowledge base entry not found'
      });
    }

    if (title !== undefined)           knowledgeBase.title = title;
    if (content !== undefined)         knowledgeBase.content = content;
    if (category !== undefined)        knowledgeBase.category = category;
    if (tags !== undefined)            knowledgeBase.tags = tags;
    if (priority !== undefined)        knowledgeBase.priority = priority;
    if (metadata !== undefined)        knowledgeBase.metadata = { ...knowledgeBase.metadata, ...metadata };
    if (isActive !== undefined)        knowledgeBase.isActive = isActive;
    if (trainingContext !== undefined)  knowledgeBase.trainingContext = trainingContext;
    if (trainingWeight !== undefined)   knowledgeBase.trainingWeight = Number(trainingWeight);
    if (isTrainingData !== undefined)   knowledgeBase.isTrainingData = Boolean(isTrainingData);
    if (Array.isArray(templateFields))  knowledgeBase.templateFields = templateFields;

    knowledgeBase.updatedBy = req.user.id;

    await knowledgeBase.save();

    res.json({
      success: true,
      data: knowledgeBase,
      message: 'Knowledge base updated successfully'
    });
  } catch (error) {
    console.error('Update knowledge base error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update knowledge base entry'
    });
  }
};

/**
 * Delete knowledge base entry
 * DELETE /api/knowledge-base/:id
 */
exports.deleteKnowledgeBase = async (req, res) => {
  try {
    const knowledgeBase = await KnowledgeBase.findOne({
      _id: req.params.id,
      organization: req.user.organization
    });

    if (!knowledgeBase) {
      return res.status(404).json({
        success: false,
        error: 'Knowledge base entry not found'
      });
    }

    // Delete associated file if it's a PDF
    if (knowledgeBase.source === 'pdf' && knowledgeBase.metadata.filePath) {
      try {
        await fs.unlink(knowledgeBase.metadata.filePath);
      } catch (err) {
        console.error('Error deleting file:', err);
      }
    }

    await knowledgeBase.deleteOne();

    res.json({
      success: true,
      message: 'Knowledge base entry deleted successfully'
    });
  } catch (error) {
    console.error('Delete knowledge base error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete knowledge base entry'
    });
  }
};

/**
 * Get knowledge base categories
 * GET /api/knowledge-base/categories
 */
exports.getCategories = async (req, res) => {
  try {
    const categories = await KnowledgeBase.distinct('category', {
      organization: req.user.organization
    });

    res.json({
      success: true,
      data: categories
    });
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch categories'
    });
  }
};

// Export upload middleware
exports.upload = upload;

