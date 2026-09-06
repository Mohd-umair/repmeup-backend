'use strict';

/**
 * Purges expired Content Studio ephemeral input images (Product Shoot
 * uploads) — both the storage object (S3/local) AND the DB record.
 *
 * WHY this job exists even though GenerationInputImage has a Mongo TTL
 * index on `expiresAt`: Mongo's TTL background task only ever deletes the
 * *document*. It has no knowledge of the S3 object or local file the
 * document points at, so relying on TTL alone would silently leak storage
 * forever (see plan "Reliability, lifecycle, and observability" —
 * "Do not rely on Mongo TTL alone"). This job runs ahead of the TTL sweep,
 * deletes the storage object first, then removes the document itself.
 *
 * Idempotent / restart-safe: re-running only ever touches documents whose
 * `expiresAt` is already in the past, and deleting an already-deleted S3
 * object or an already-removed document is a no-op.
 */

const GenerationInputImage = require('../models/GenerationInputImage');
const storageService = require('../services/storageService');
const logger = require('../config/logger');

const BATCH_SIZE = 100;

async function processContentStudioInputCleanup() {
  const now = new Date();
  let purged = 0;
  let failed = 0;

  // Loop in batches rather than one giant query — this job may run after a
  // period of downtime with a large backlog.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await GenerationInputImage.find({
      expiresAt: { $ne: null, $lte: now }
    })
      .select('_id imageUrl s3Key storageType')
      .limit(BATCH_SIZE)
      .lean();

    if (!batch.length) break;

    for (const doc of batch) {
      try {
        if (doc.s3Key) {
          await storageService.deleteObjectByKey(doc.s3Key);
        } else if (doc.storageType === 'local') {
          const fs = require('fs').promises;
          const path = require('path');
          const filePath = path.join(__dirname, '../../uploads/content-studio-inputs', path.basename(doc.imageUrl));
          await fs.unlink(filePath).catch(() => {}); // already gone is fine
        }
        await GenerationInputImage.deleteOne({ _id: doc._id });
        purged += 1;
      } catch (err) {
        failed += 1;
        logger.warn('[ContentStudioInputCleanup] failed to purge one record (will retry next run)', {
          id: doc._id, err: err.message
        });
      }
    }

    if (batch.length < BATCH_SIZE) break;
  }

  if (purged > 0 || failed > 0) {
    logger.info('[ContentStudioInputCleanup] sweep complete', { purged, failed });
  } else {
    logger.debug('[ContentStudioInputCleanup] nothing to purge');
  }

  return { purged, failed };
}

module.exports = processContentStudioInputCleanup;
