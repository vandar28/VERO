const cloudinary = require('cloudinary').v2;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const API_KEY = process.env.CLOUDINARY_API_KEY;
const API_SECRET = process.env.CLOUDINARY_API_SECRET;
const IS_CONFIGURED = !!(CLOUD_NAME && API_KEY && API_SECRET);

if (IS_CONFIGURED) {
  cloudinary.config({
    cloud_name: CLOUD_NAME,
    api_key: API_KEY,
    api_secret: API_SECRET,
    secure: true
  });
  console.log('✅ Cloudinary настроен');
} else {
  console.error('❌ Cloudinary не настроен. На Render локальные uploads не используются, потому медиа будут отклоняться.');
}

function resourceTypeForMime(mimeType, originalName) {
  const mime = String(mimeType || '').toLowerCase();
  const ext = path.extname(originalName || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/') || mime.startsWith('audio/')) return 'video';
  if (['.mp4','.webm','.mov','.m4v','.ogv','.3gp','.avi','.mkv','.mp3','.wav','.ogg','.m4a','.aac','.flac'].includes(ext)) return 'video';
  return 'raw';
}

async function uploadMedia(fileBuffer, originalName, mimeType, folder = 'uploads') {
  if (!IS_CONFIGURED) throw new Error('Cloudinary не настроен');

  const resource_type = resourceTypeForMime(mimeType, originalName);
  const nameWithoutExt = path.parse(originalName || 'file').name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  const public_id = crypto.randomUUID() + '_' + nameWithoutExt;

  const options = {
    folder,
    resource_type,
    public_id,
    use_filename: false,
    unique_filename: false,
    overwrite: false
  };

  if (resource_type === 'image') {
    options.transformation = [{ width: 1200, height: 1200, crop: 'limit', quality: 'auto', fetch_format: 'auto' }];
  }

  const result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
    stream.end(fileBuffer);
  });

  return {
    url: result.secure_url,
    public_id: result.public_id,
    resource_type: result.resource_type,
    duration: Number.isFinite(Number(result.duration)) ? Number(result.duration) : null,
    width: result.width || null,
    height: result.height || null,
    bytes: result.bytes || fileBuffer.length,
    format: result.format || null
  };
}

async function uploadFile(fileBuffer, originalName, mimeType, folder = 'uploads') {
  const result = await uploadMedia(fileBuffer, originalName, mimeType, folder);
  return result.url;
}

async function deleteFile(fileUrl) {
  if (!fileUrl || !IS_CONFIGURED || !String(fileUrl).startsWith('http')) return;
  try {
    const url = new URL(fileUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    const uploadIndex = parts.indexOf('upload');
    if (uploadIndex === -1) return;

    let after = parts.slice(uploadIndex + 1);
    if (after[0] && /^v\d+$/.test(after[0])) after = after.slice(1);
    let publicId = after.join('/').replace(/\.[^/.]+$/, '');

    const resourceType = fileUrl.includes('/video/upload/') ? 'video' :
      fileUrl.includes('/raw/upload/') ? 'raw' : 'image';

    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, invalidate: true });
  } catch (error) {
    console.error('❌ Cloudinary delete:', error.message);
  }
}

async function getFileInfo(fileUrl) {
  if (!IS_CONFIGURED || !fileUrl || !String(fileUrl).startsWith('http')) return null;
  try {
    const url = new URL(fileUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    const uploadIndex = parts.indexOf('upload');
    if (uploadIndex === -1) return null;
    let after = parts.slice(uploadIndex + 1);
    if (after[0] && /^v\d+$/.test(after[0])) after = after.slice(1);
    const publicId = after.join('/').replace(/\.[^/.]+$/, '');
    const resourceType = fileUrl.includes('/video/upload/') ? 'video' :
      fileUrl.includes('/raw/upload/') ? 'raw' : 'image';
    return await cloudinary.api.resource(publicId, { resource_type: resourceType });
  } catch (error) {
    return null;
  }
}

module.exports = { uploadFile, uploadMedia, deleteFile, getFileInfo, isConfigured: IS_CONFIGURED };
