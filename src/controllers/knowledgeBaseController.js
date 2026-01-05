const KnowledgeBase = require('../models/KnowledgeBase');
const pdf = require('pdf-parse');
const axios = require('axios');
const cheerio = require('cheerio');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;

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
 * Get all knowledge base entries
 * GET /api/knowledge-base
 */
exports.getAllKnowledgeBase = async (req, res) => {
  try {
    const { category, search, page = 1, limit = 20 } = req.query;

    const query = { organization: req.user.organization };

    if (category) {
      query.category = category;
    }

    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { content: { $regex: search, $options: 'i' } },
        { tags: { $regex: search, $options: 'i' } }
      ];
    }

    const knowledgeBase = await KnowledgeBase.find(query)
      .sort({ priority: -1, createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .populate('createdBy', 'firstName lastName email');

    const count = await KnowledgeBase.countDocuments(query);

    res.json({
      success: true,
      data: {
        knowledgeBase,
        pagination: {
          total: count,
          page: parseInt(page),
          pages: Math.ceil(count / limit)
        }
      }
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
    const { title, content, category, tags, priority, metadata } = req.body;

    const knowledgeBase = new KnowledgeBase({
      title,
      content,
      category,
      tags: tags || [],
      priority: priority || 1,
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
 */
exports.createURLKnowledgeBase = async (req, res) => {
  try {
    const { url, title, category, tags, priority } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'URL is required'
      });
    }

    // Fetch and parse website
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ORM-Bot/1.0)'
      },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);

    // Extract title if not provided
    const pageTitle = title || $('title').text() || url;

    // Remove script and style tags
    $('script, style, nav, footer, header').remove();

    // Extract main content
    const content = $('body').text().replace(/\s+/g, ' ').trim();

    // Extract metadata
    const description = $('meta[name="description"]').attr('content') || '';
    const keywords = $('meta[name="keywords"]').attr('content') || '';

    const knowledgeBase = new KnowledgeBase({
      title: pageTitle,
      content: content,
      category: category || 'website',
      tags: tags || [],
      priority: priority || 1,
      source: 'url',
      metadata: {
        url: url,
        scrapedAt: new Date(),
        description: description,
        keywords: keywords
      },
      organization: req.user.organization,
      createdBy: req.user.id
    });

    await knowledgeBase.save();

    res.status(201).json({
      success: true,
      data: knowledgeBase,
      message: 'Knowledge base created from URL successfully'
    });
  } catch (error) {
    console.error('Create URL knowledge base error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to scrape website. Please check the URL and try again.'
    });
  }
};

/**
 * Update knowledge base entry
 * PUT /api/knowledge-base/:id
 */
exports.updateKnowledgeBase = async (req, res) => {
  try {
    const { title, content, category, tags, priority, metadata, isActive } = req.body;

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

    // Update fields
    if (title) knowledgeBase.title = title;
    if (content) knowledgeBase.content = content;
    if (category) knowledgeBase.category = category;
    if (tags) knowledgeBase.tags = tags;
    if (priority !== undefined) knowledgeBase.priority = priority;
    if (metadata) knowledgeBase.metadata = { ...knowledgeBase.metadata, ...metadata };
    if (isActive !== undefined) knowledgeBase.isActive = isActive;

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

