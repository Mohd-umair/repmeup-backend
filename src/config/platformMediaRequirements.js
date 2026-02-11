/**
 * Platform Media Requirements
 * Defines image/video requirements for each social media platform
 */

const PLATFORM_MEDIA_REQUIREMENTS = {
  facebook: {
    image: {
      maxFileSize: 8 * 1024 * 1024, // 8 MB
      minWidth: 600,
      minHeight: 315,
      recommendedWidth: 1200,
      recommendedHeight: 630,
      aspectRatio: '1.91:1',
      formats: ['jpg', 'jpeg', 'png'],
      description: 'Facebook recommends 1200x630px with a 1.91:1 aspect ratio'
    },
    video: {
      maxFileSize: 1024 * 1024 * 1024, // 1 GB
      minDuration: 1, // seconds
      maxDuration: 240, // 4 minutes
      formats: ['mp4', 'mov'],
      description: 'Videos up to 4 minutes, max 1GB'
    }
  },
  instagram: {
    image: {
      maxFileSize: 8 * 1024 * 1024, // 8 MB
      minWidth: 320,
      minHeight: 320,
      recommendedWidth: 1080,
      recommendedHeight: 1080,
      aspectRatios: {
        square: '1:1',
        portrait: '4:5',
        landscape: '1.91:1'
      },
      formats: ['jpg', 'jpeg', 'png'],
      description: 'Instagram supports square (1080x1080), portrait (1080x1350), or landscape (1080x566)'
    },
    video: {
      maxFileSize: 100 * 1024 * 1024, // 100 MB
      minDuration: 3,
      maxDuration: 60,
      formats: ['mp4', 'mov'],
      description: 'Videos between 3-60 seconds, max 100MB'
    },
    story: {
      image: {
        maxFileSize: 8 * 1024 * 1024,
        recommendedWidth: 1080,
        recommendedHeight: 1920,
        aspectRatio: '9:16',
        formats: ['jpg', 'jpeg', 'png'],
        description: 'Stories should be 1080x1920 (9:16 vertical)'
      },
      video: {
        maxFileSize: 100 * 1024 * 1024,
        maxDuration: 15,
        formats: ['mp4', 'mov'],
        description: 'Story videos up to 15 seconds'
      }
    },
    reel: {
      video: {
        maxFileSize: 100 * 1024 * 1024,
        minDuration: 3,
        maxDuration: 90,
        recommendedWidth: 1080,
        recommendedHeight: 1920,
        aspectRatio: '9:16',
        formats: ['mp4', 'mov'],
        description: 'Reels 3-90 seconds, 1080x1920 (9:16 vertical)'
      }
    }
  },
  linkedin: {
    image: {
      maxFileSize: 5 * 1024 * 1024, // 5 MB
      minWidth: 552,
      minHeight: 368,
      recommendedWidth: 1200,
      recommendedHeight: 627,
      aspectRatio: '1.91:1',
      formats: ['jpg', 'jpeg', 'png', 'gif'],
      description: 'LinkedIn recommends 1200x627px with a 1.91:1 aspect ratio'
    },
    video: {
      maxFileSize: 200 * 1024 * 1024, // 200 MB
      minDuration: 3,
      maxDuration: 600, // 10 minutes
      formats: ['mp4', 'mov'],
      description: 'Videos 3 seconds to 10 minutes, max 200MB'
    }
  }
};

/**
 * Validate media file against platform requirements
 * @param {string} platform - Platform name (facebook, instagram, linkedin)
 * @param {string} mediaType - Media type (image, video)
 * @param {number} fileSize - File size in bytes
 * @param {string} fileExtension - File extension (jpg, png, mp4, etc.)
 * @param {string} postType - Post type (post, story, reel, short)
 * @param {Object} dimensions - Optional: { width, height }
 * @returns {Object} { valid: boolean, errors: string[], warnings: string[] }
 */
function validateMedia(platform, mediaType, fileSize, fileExtension, postType = 'post', dimensions = null) {
  const errors = [];
  const warnings = [];

  // Get requirements
  const platformReqs = PLATFORM_MEDIA_REQUIREMENTS[platform.toLowerCase()];
  
  if (!platformReqs) {
    errors.push(`Platform ${platform} is not supported`);
    return { valid: false, errors, warnings };
  }

  // Get media type requirements based on post type
  let mediaReqs;
  if (postType === 'story' && platformReqs.story) {
    mediaReqs = platformReqs.story[mediaType];
  } else if (postType === 'reel' && platformReqs.reel) {
    mediaReqs = platformReqs.reel[mediaType];
  } else {
    mediaReqs = platformReqs[mediaType];
  }

  if (!mediaReqs) {
    errors.push(`${mediaType} is not supported for ${platform} ${postType}`);
    return { valid: false, errors, warnings };
  }

  // Validate file size
  if (fileSize > mediaReqs.maxFileSize) {
    const maxSizeMB = (mediaReqs.maxFileSize / (1024 * 1024)).toFixed(2);
    const currentSizeMB = (fileSize / (1024 * 1024)).toFixed(2);
    errors.push(`File size ${currentSizeMB}MB exceeds ${platform} limit of ${maxSizeMB}MB`);
  }

  // Validate file format
  const ext = fileExtension.toLowerCase().replace('.', '');
  if (!mediaReqs.formats.includes(ext)) {
    errors.push(`Format .${ext} is not supported. Use: ${mediaReqs.formats.join(', ')}`);
  }

  // Validate dimensions if provided
  if (dimensions && mediaReqs.minWidth && mediaReqs.minHeight) {
    if (dimensions.width < mediaReqs.minWidth || dimensions.height < mediaReqs.minHeight) {
      errors.push(`Image is too small. Minimum ${mediaReqs.minWidth}x${mediaReqs.minHeight}px`);
    }

    // Warn if not recommended size
    if (mediaReqs.recommendedWidth && mediaReqs.recommendedHeight) {
      if (dimensions.width < mediaReqs.recommendedWidth || dimensions.height < mediaReqs.recommendedHeight) {
        warnings.push(`For best quality, use ${mediaReqs.recommendedWidth}x${mediaReqs.recommendedHeight}px`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Get human-readable requirements for a platform
 * @param {string} platform - Platform name
 * @param {string} postType - Post type
 * @returns {Object} Formatted requirements
 */
function getRequirementsText(platform, postType = 'post') {
  const platformReqs = PLATFORM_MEDIA_REQUIREMENTS[platform.toLowerCase()];
  
  if (!platformReqs) {
    return null;
  }

  // Get requirements based on post type
  let imageReqs, videoReqs;
  if (postType === 'story' && platformReqs.story) {
    imageReqs = platformReqs.story.image;
    videoReqs = platformReqs.story.video;
  } else if (postType === 'reel' && platformReqs.reel) {
    videoReqs = platformReqs.reel.video;
  } else {
    imageReqs = platformReqs.image;
    videoReqs = platformReqs.video;
  }

  return {
    platform,
    postType,
    image: imageReqs ? {
      maxSize: `${(imageReqs.maxFileSize / (1024 * 1024)).toFixed(0)}MB`,
      dimensions: imageReqs.recommendedWidth && imageReqs.recommendedHeight
        ? `${imageReqs.recommendedWidth}x${imageReqs.recommendedHeight}px`
        : 'See platform guidelines',
      formats: imageReqs.formats.map(f => f.toUpperCase()).join(', '),
      description: imageReqs.description
    } : null,
    video: videoReqs ? {
      maxSize: `${(videoReqs.maxFileSize / (1024 * 1024)).toFixed(0)}MB`,
      duration: videoReqs.maxDuration 
        ? `${videoReqs.minDuration || 0}s - ${videoReqs.maxDuration}s`
        : 'See platform guidelines',
      formats: videoReqs.formats.map(f => f.toUpperCase()).join(', '),
      description: videoReqs.description
    } : null
  };
}

module.exports = {
  PLATFORM_MEDIA_REQUIREMENTS,
  validateMedia,
  getRequirementsText
};
