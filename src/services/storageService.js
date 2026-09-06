/**
 * Object storage: AWS S3 (or compatible) when configured, otherwise local disk only.
 *
 * Env (S3):
 *   AWS_REGION=us-east-1
 *   AWS_S3_BUCKET=your-bucket
 *   AWS_ACCESS_KEY_ID=...
 *   AWS_SECRET_ACCESS_KEY=...
 *   AWS_S3_PUBLIC_BASE_URL=https://cdn.example.com   (optional; CloudFront or custom domain)
 *   AWS_S3_KEY_PREFIX=repmeup                        (optional key prefix)
 *
 * Bucket policy: allow s3:GetObject for public reads on uploaded prefixes, or use CloudFront.
 * Do not rely on ACLs (many buckets have ACLs disabled).
 */

const path = require('path');
const fs = require('fs').promises;

let _s3Client = null;

function env(name) {
  return (process.env[name] || '').trim();
}

function isS3Configured() {
  return !!(env('AWS_S3_BUCKET') && env('AWS_ACCESS_KEY_ID') && env('AWS_SECRET_ACCESS_KEY'));
}

function getKeyPrefix() {
  const p = (env('AWS_S3_KEY_PREFIX') || 'repmeup').replace(/^\/+|\/+$/g, '');
  return p ? `${p}/` : '';
}

function getS3Client() {
  if (_s3Client) return _s3Client;
  if (!isS3Configured()) return null;
  const { S3Client } = require('@aws-sdk/client-s3');
  const { NodeHttpHandler } = require('@smithy/node-http-handler');
  _s3Client = new S3Client({
    region: env('AWS_REGION') || 'us-east-1',
    requestHandler: new NodeHttpHandler({ requestTimeout: 15000, connectionTimeout: 10000 }),
    ...(env('AWS_S3_ENDPOINT')
      ? { endpoint: env('AWS_S3_ENDPOINT'), forcePathStyle: true }
      : {})
  });
  return _s3Client;
}

/**
 * Public URL for an object key (virtual-hosted–style unless AWS_S3_PUBLIC_BASE_URL set).
 */
function publicUrlForKey(key) {
  const base = env('AWS_S3_PUBLIC_BASE_URL').replace(/\/$/, '');
  if (base) {
    return `${base}/${key}`;
  }
  const bucket = env('AWS_S3_BUCKET');
  const region = env('AWS_REGION') || 'us-east-1';
  if (region === 'us-east-1') {
    return `https://${bucket}.s3.amazonaws.com/${key}`;
  }
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}

/**
 * @param {string} key - full S3 object key (including prefix)
 * @param {Buffer} body
 * @param {string} contentType
 * @returns {Promise<{ key: string, publicUrl: string }>}
 */
async function uploadBuffer(key, body, contentType) {
  const client = getS3Client();
  if (!client) {
    throw new Error('S3 is not configured');
  }
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  console.log(`[S3] Uploading: bucket=${env('AWS_S3_BUCKET')} key=${key} size=${body.length}`);
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: env('AWS_S3_BUCKET'),
        Key: key,
        Body: body,
        ContentType: contentType || 'application/octet-stream'
      })
    );
  } catch (e) {
    console.error('[S3] PutObject failed:', e.message, { key, bucket: env('AWS_S3_BUCKET') });
    throw e;
  }
  const url = publicUrlForKey(key);
  console.log(`[S3] Upload OK: ${url}`);
  return { key, publicUrl: url };
}

/**
 * @param {string} key
 */
async function deleteObjectByKey(key) {
  if (!key || !isS3Configured()) return;
  const client = getS3Client();
  if (!client) return;
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  try {
    await client.send(
      new DeleteObjectCommand({
        Bucket: env('AWS_S3_BUCKET'),
        Key: key
      })
    );
  } catch (e) {
    console.warn('[S3] DeleteObject failed:', key, e.message);
  }
}

/**
 * If url points at this bucket (or CDN mirroring it), delete the object. Best-effort.
 */
async function deleteObjectFromPublicUrl(url) {
  if (!url || !isS3Configured() || !/^https?:\/\//i.test(String(url))) return;
  try {
    const u = new URL(String(url));
    const pathname = u.pathname.replace(/^\//, '');
    if (!pathname) return;
    const bucket = env('AWS_S3_BUCKET');
    const publicBase = env('AWS_S3_PUBLIC_BASE_URL').replace(/\/$/, '');
    if (publicBase && String(url).startsWith(publicBase)) {
      const key = String(url).slice(publicBase.length + 1).split('?')[0];
      if (key) await deleteObjectByKey(key);
      return;
    }
    if (u.hostname.includes(`${bucket}.s3`) || u.hostname === `s3.${env('AWS_REGION') || 'us-east-1'}.amazonaws.com`) {
      await deleteObjectByKey(pathname);
      return;
    }
    if (pathname.startsWith(getKeyPrefix())) {
      await deleteObjectByKey(pathname);
    }
  } catch (_) {
    /* ignore */
  }
}

/**
 * Build key under prefix for org-scoped posts / library media.
 */
function buildPostsKey(organizationId, filename) {
  const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${getKeyPrefix()}posts/${organizationId}/${safeName}`;
}

function buildLogoKey(organizationId, filename) {
  const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${getKeyPrefix()}logos/${organizationId}/${safeName}`;
}

/**
 * Build key for a Content Studio ephemeral input image (Product Shoot
 * uploads). Kept under its own prefix — distinct from `brand-references/`
 * (durable style library) and `posts/` (published output) — so cleanup of
 * expired ephemeral uploads can never touch either of those.
 */
function buildContentStudioInputKey(organizationId, filename) {
  const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${getKeyPrefix()}content-studio/inputs/${organizationId}/${Date.now()}-${safeName}`;
}

/**
 * Resolve a value stored in mediaStoragePath / similar: return a public URL for platforms.
 */
function resolvePublicUrl(mediaRef, req) {
  if (!mediaRef) return '';
  if (/^https?:\/\//i.test(String(mediaRef))) {
    return String(mediaRef);
  }
  const filename = path.basename(mediaRef);
  let baseUrl = process.env.BASE_URL || process.env.API_URL;
  if (!baseUrl && req && req.get && req.get('host')) {
    const protocol = req.protocol || 'https';
    baseUrl = `${protocol}://${req.get('host')}`;
  }
  if (!baseUrl) {
    baseUrl = 'https://repmeup.in';
  }
  baseUrl = baseUrl.replace(/\/api\/?$/, '');
  return `${baseUrl}/api/posts/media/${filename}`;
}

module.exports = {
  isS3Configured,
  uploadBuffer,
  deleteObjectByKey,
  deleteObjectFromPublicUrl,
  publicUrlForKey,
  buildPostsKey,
  buildLogoKey,
  buildContentStudioInputKey,
  resolvePublicUrl
};
