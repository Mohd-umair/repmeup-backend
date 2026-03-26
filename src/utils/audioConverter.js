const path = require('path');
const fs = require('fs');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfmpegPath(ffmpegPath);

/**
 * Convert an audio file (e.g. webm from browser MediaRecorder) to m4a (AAC).
 * m4a is supported by both Facebook Messenger and Instagram DM APIs.
 *
 * @param {string} inputPath - Absolute path to the source audio file
 * @returns {Promise<string>} Absolute path to the converted .m4a file
 */
function convertToM4a(inputPath) {
  const outputPath = inputPath.replace(/\.[^.]+$/, '.m4a');

  if (outputPath === inputPath) {
    return Promise.resolve(inputPath);
  }

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioCodec('aac')
      .audioBitrate('128k')
      .audioChannels(1)
      .outputOptions('-movflags', '+faststart')
      .output(outputPath)
      .on('end', () => {
        console.log(`[AudioConverter] Converted ${path.basename(inputPath)} → ${path.basename(outputPath)}`);
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.error(`[AudioConverter] Failed to convert ${path.basename(inputPath)}:`, err.message);
        reject(err);
      })
      .run();
  });
}

module.exports = { convertToM4a };
