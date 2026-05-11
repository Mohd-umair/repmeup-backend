/**
 * Instagram DM — PDF / file attachments for Meta Send API
 *
 * Meta can fail when it must fetch a private or non-HTTPS URL. We always prefer
 * multipart upload from a local path. This module validates PDFs and materializes
 * a temp file when only a public URL is available.
 *
 * @see https://developers.facebook.com/docs/messenger-platform/send-messages#attachments
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const axios = require('axios');
const logger = require('../config/logger');

/** Conservative limit aligned with Messenger / IG file attachments (MB varies by product; 25MB is safe). */
const MAX_INSTAGRAM_DM_FILE_BYTES = 25 * 1024 * 1024;

const PDF_MAGIC = Buffer.from('%PDF-');

function isPdfBuffer(buf) {
  return buf && buf.length >= 5 && buf.slice(0, 5).equals(PDF_MAGIC);
}

/**
 * Resolve /api/posts/media/:filename to local disk (same tree as media uploads).
 */
function resolveLocalPostsMediaPath(attachmentUrl) {
  if (!attachmentUrl) return null;
  const urlStr = String(attachmentUrl);
  const apiMatch = urlStr.match(/\/api\/posts\/media\/([^?#]+)/);
  const rawName = apiMatch ? apiMatch[1] : path.basename(urlStr.split('?')[0]);
  if (!rawName) return null;
  const safe = path.basename(decodeURIComponent(rawName));
  const candidate = path.join(__dirname, '../../uploads/posts', safe);
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * @param {string} filePath
 * @throws {Error}
 */
async function assertValidPdfFile(filePath) {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) {
    throw new Error('Attachment path is not a file.');
  }
  if (stat.size === 0) {
    throw new Error('PDF is empty.');
  }
  if (stat.size > MAX_INSTAGRAM_DM_FILE_BYTES) {
    throw new Error(
      `PDF is too large for Instagram DMs (max ${Math.round(MAX_INSTAGRAM_DM_FILE_BYTES / (1024 * 1024))}MB).`
    );
  }

  const fd = await fsp.open(filePath, 'r');
  try {
    const head = Buffer.alloc(Math.min(8 * 1024, stat.size));
    const { bytesRead } = await fd.read(head, 0, head.length, 0);
    if (!isPdfBuffer(head.slice(0, bytesRead))) {
      throw new Error(
        'File is not a valid PDF. Instagram DM file messages require a real PDF document.'
      );
    }
  } finally {
    await fd.close();
  }
}

/**
 * Download PDF from HTTPS URL into a temp file (validated).
 *
 * @returns {Promise<string>} absolute path (caller must delete)
 */
async function downloadPdfToTemp(attachmentUrl) {
  const tmp = path.join(
    os.tmpdir(),
    `ig-dm-pdf-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.pdf`
  );

  const response = await axios.get(String(attachmentUrl), {
    responseType: 'arraybuffer',
    maxContentLength: MAX_INSTAGRAM_DM_FILE_BYTES + 1,
    maxBodyLength: MAX_INSTAGRAM_DM_FILE_BYTES + 1,
    timeout: 60000,
    validateStatus: (s) => s >= 200 && s < 300,
    headers: { Accept: 'application/pdf,*/*' }
  });

  const buf = Buffer.from(response.data);
  if (buf.length > MAX_INSTAGRAM_DM_FILE_BYTES) {
    throw new Error(
      `PDF exceeds Instagram DM size limit (${Math.round(MAX_INSTAGRAM_DM_FILE_BYTES / (1024 * 1024))}MB).`
    );
  }
  if (!isPdfBuffer(buf)) {
    throw new Error(
      'URL did not return a PDF. Use a direct link to a .pdf file, or upload the PDF from your device / media library.'
    );
  }

  await fsp.writeFile(tmp, buf, { mode: 0o600 });
  return tmp;
}

/**
 * Ensure we have a readable local PDF path for Instagram DM multipart upload.
 *
 * @param {object} opts
 * @param {string} [opts.attachmentUrl]
 * @param {string|null} [opts.attachmentLocalPath] — already resolved by inbox (uploads/posts)
 * @returns {Promise<{ localPath: string, cleanupPaths: string[] }>}
 */
async function prepareInstagramDmPdfAttachment({ attachmentUrl, attachmentLocalPath }) {
  const cleanupPaths = [];
  let localPath =
    attachmentLocalPath && fs.existsSync(attachmentLocalPath) ? attachmentLocalPath : null;

  if (!localPath && attachmentUrl) {
    localPath = resolveLocalPostsMediaPath(attachmentUrl);
  }

  if (!localPath && attachmentUrl && /^https?:\/\//i.test(String(attachmentUrl))) {
    let tmp = null;
    try {
      tmp = await downloadPdfToTemp(attachmentUrl);
      cleanupPaths.push(tmp);
      localPath = tmp;
      tmp = null;
      logger.info('[instagramDmPdfAttachment] Materialized PDF from URL for IG DM multipart upload');
    } catch (err) {
      if (tmp) {
        await fsp.unlink(tmp).catch(() => {});
      }
      const msg = err.response?.status === 413 ? 'PDF from URL is too large.' : err.message;
      logger.warn('[instagramDmPdfAttachment] URL download or validation failed', {
        message: msg,
        status: err.response?.status
      });
      throw new Error(
        msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT')
          ? 'Could not download the PDF from that URL. Check the link or upload from your media library.'
          : msg || 'Could not prepare PDF for Instagram.'
      );
    }
  }

  if (!localPath) {
    throw new Error(
      'Could not access the PDF on disk. Re-upload the file or pick it from the media library again.'
    );
  }

  const materializedFromUrl = cleanupPaths.includes(localPath);
  if (!materializedFromUrl) {
    await assertValidPdfFile(localPath);
  }

  return { localPath, cleanupPaths };
}

async function cleanupTempFiles(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return;
  await Promise.all(
    paths.map(async (p) => {
      try {
        if (p && typeof p === 'string' && fs.existsSync(p)) {
          await fsp.unlink(p);
        }
      } catch (e) {
        logger.warn('[instagramDmPdfAttachment] temp cleanup failed:' + p, { error: e.message });
      }
    })
  );
}

module.exports = {
  MAX_INSTAGRAM_DM_FILE_BYTES,
  prepareInstagramDmPdfAttachment,
  cleanupTempFiles,
  resolveLocalPostsMediaPath,
  isPdfBuffer
};
