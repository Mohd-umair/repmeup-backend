const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { protect } = require('../middlewares/auth');
const multer = require('multer');
const storageService = require('../services/storageService');
const ticketController = require('../controllers/ticketController');

// ── Multer setup (same pattern as media library) ─────────────────────────────
function createUploadStorage() {
  if (storageService.isS3Configured()) {
    return multer.memoryStorage();
  }
  const uploadPath = path.join(__dirname, '../../uploads/tickets');
  return multer.diskStorage({
    destination: (req, file, cb) => {
      try { fs.mkdirSync(uploadPath, { recursive: true }); } catch (_) {}
      cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      const ext = path.extname(file.originalname);
      cb(null, 'ticket-' + uniqueSuffix + ext);
    }
  });
}

const allowedMimeTypes = new Set([
  'image/jpeg',
  'image/jpg',
  'image/pjpeg',
  'image/png',
  'image/x-png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/heic',
  'image/heif',
  'image/avif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
  'video/mp4',
  'video/quicktime',
  'video/webm'
]);

/** When the browser sends empty or generic MIME, allow known-safe extensions only. */
const allowedExt = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.svg',
  '.heic',
  '.heif',
  '.avif',
  '.pdf',
  '.doc',
  '.docx',
  '.txt',
  '.md',
  '.mp4',
  '.mov',
  '.webm'
]);

function isTicketAttachmentAllowed(file) {
  const mime = (file.mimetype || '').toLowerCase();
  if (mime && allowedMimeTypes.has(mime)) return true;

  // Many clients send application/octet-stream or mislabel types; require a known-safe extension
  const ext = path.extname(file.originalname || '').toLowerCase();
  return Boolean(ext && allowedExt.has(ext));
}

const upload = multer({
  storage: createUploadStorage(),
  fileFilter: (req, file, cb) => {
    if (isTicketAttachmentAllowed(file)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed: images, PDF, Word, text, video.'), false);
    }
  },
  limits: { fileSize: 20 * 1024 * 1024 } // 20 MB
});

// All ticket routes require authentication
router.use(protect);

router.post('/', ticketController.raiseTicket);
router.get('/', ticketController.getMyTickets);
router.get('/:id', ticketController.getTicket);
router.post('/:id/attachments', upload.single('file'), ticketController.uploadAttachment);

module.exports = router;
