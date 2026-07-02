const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const baileysLib = join(process.cwd(), 'node_modules', 'baileys', 'lib');

function replaceInFile(relativePath, replacements) {
  const filePath = join(baileysLib, relativePath);

  if (!existsSync(filePath)) {
    throw new Error(`Baileys file not found: ${relativePath}`);
  }

  let source = readFileSync(filePath, 'utf8');

  for (const { from, to, marker } of replacements) {
    if (marker && source.includes(marker)) {
      continue;
    }

    if (!source.includes(from)) {
      if (source.includes(to)) {
        continue;
      }

      throw new Error(`Patch target not found in ${relativePath}: ${from.slice(0, 120)}`);
    }

    source = source.replace(from, to);
  }

  writeFileSync(filePath, source, 'utf8');
}

replaceInFile('Defaults/index.js', [
  {
    marker: 'NEWSLETTER_MEDIA_PATH_MAP',
    from: `export const MEDIA_PATH_MAP = {
    image: '/mms/image',
    video: '/mms/video',
    document: '/mms/document',
    audio: '/mms/audio',
    sticker: '/mms/image',
    'thumbnail-link': '/mms/image',
    'product-catalog-image': '/product/image',
    'md-app-state': '',
    'md-msg-hist': '/mms/md-app-state',
    'biz-cover-photo': '/pps/biz-cover-photo'
};`,
    to: `export const MEDIA_PATH_MAP = {
    image: '/mms/image',
    video: '/mms/video',
    document: '/mms/document',
    audio: '/mms/audio',
    sticker: '/mms/image',
    'thumbnail-link': '/mms/image',
    'product-catalog-image': '/product/image',
    'md-app-state': '',
    'md-msg-hist': '/mms/md-app-state',
    'biz-cover-photo': '/pps/biz-cover-photo'
};
export const NEWSLETTER_MEDIA_PATH_MAP = {
    image: '/newsletter/newsletter-image',
    video: '/newsletter/newsletter-video',
    document: '/newsletter/newsletter-document',
    audio: '/newsletter/newsletter-audio',
    sticker: '/newsletter/newsletter-image',
    'thumbnail-link': '/newsletter/newsletter-image'
};`,
  },
]);

replaceInFile('Utils/messages-media.js', [
  {
    marker: 'NEWSLETTER_MEDIA_PATH_MAP',
    from: `import { DEFAULT_ORIGIN, MEDIA_HKDF_KEY_MAPPING, MEDIA_PATH_MAP } from '../Defaults/index.js';`,
    to: `import { DEFAULT_ORIGIN, MEDIA_HKDF_KEY_MAPPING, MEDIA_PATH_MAP, NEWSLETTER_MEDIA_PATH_MAP } from '../Defaults/index.js';`,
  },
  {
    marker: 'newsletter }) =>',
    from: `export const getWAUploadToServer = ({ customUploadHosts, fetchAgent, logger, options }, refreshMediaConn) => {
    return async (filePath, { mediaType, fileEncSha256B64, timeoutMs }) => {`,
    to: `export const getWAUploadToServer = ({ customUploadHosts, fetchAgent, logger, options }, refreshMediaConn) => {
    return async (filePath, { mediaType, fileEncSha256B64, timeoutMs, newsletter }) => {`,
  },
  {
    marker: 'server_thumb_gen=1',
    from: `            const url = \`https://\${hostname}\${MEDIA_PATH_MAP[mediaType]}/\${fileEncSha256B64}?auth=\${auth}&token=\${fileEncSha256B64}\`;`,
    to: `            const mediaPathMap = newsletter ? NEWSLETTER_MEDIA_PATH_MAP : MEDIA_PATH_MAP;
            const serverThumbGen = newsletter ? '&server_thumb_gen=1' : '';
            const url = \`https://\${hostname}\${mediaPathMap[mediaType]}/\${fileEncSha256B64}?auth=\${auth}&token=\${fileEncSha256B64}\${serverThumbGen}\`;`,
  },
  {
    marker: 'thumbnailDirectPath: result.thumbnail_info?.thumbnail_direct_path',
    from: `                        fbid: result.fbid,
                        ts: result.ts`,
    to: `                        fbid: result.fbid,
                        thumbnailDirectPath: result.thumbnail_info?.thumbnail_direct_path,
                        thumbnailSha256: result.thumbnail_info?.thumbnail_sha256,
                        ts: result.ts`,
  },
]);

replaceInFile('Utils/messages.js', [
  {
    marker: 'newsletter:' ,
    from: `    const cacheableKey = typeof uploadData.media === 'object' &&
        'url' in uploadData.media &&
        !!uploadData.media.url &&
        !!options.mediaCache &&
        mediaType + ':' + uploadData.media.url.toString();`,
    to: `    const isNewsletter = !!options.jid && isJidNewsletter(options.jid);
    const cacheableKey = typeof uploadData.media === 'object' &&
        'url' in uploadData.media &&
        !!uploadData.media.url &&
        !!options.mediaCache &&
        mediaType + ':' + (isNewsletter ? 'newsletter:' : 'normal:') + uploadData.media.url.toString();`,
  },
  {
    from: `    const isNewsletter = !!options.jid && isJidNewsletter(options.jid);
    if (isNewsletter) {`,
    to: `    if (isNewsletter) {`,
  },
  {
    marker: 'newsletter: isNewsletter',
    from: `        const { mediaUrl, directPath } = await options.upload(filePath, {
            fileEncSha256B64: fileSha256B64,
            mediaType: mediaType,
            timeoutMs: options.mediaUploadTimeoutMs
        });`,
    to: `        const { directPath, thumbnailDirectPath, thumbnailSha256 } = await options.upload(filePath, {
            fileEncSha256B64: fileSha256B64,
            mediaType: mediaType,
            timeoutMs: options.mediaUploadTimeoutMs,
            newsletter: isNewsletter
        });`,
  },
  {
    marker: "thumbnailSha256: thumbnailSha256 ? Buffer.from(thumbnailSha256, 'base64') : undefined,",
    from: `                url: mediaUrl,
                directPath,
                fileSha256,
                fileLength,
                ...uploadData,
                media: undefined`,
    to: `                directPath,
                fileSha256,
                fileLength,
                thumbnailDirectPath,
                thumbnailSha256: thumbnailSha256 ? Buffer.from(thumbnailSha256, 'base64') : undefined,
                ...uploadData,
                media: undefined`,
  },
]);

replaceInFile('Socket/messages-send.js', [
  {
    marker: "attrs: extraAttrs",
    from: `                binaryNodeContent.push({
                    tag: 'plaintext',
                    attrs: {},
                    content: bytes
                });`,
    to: `                binaryNodeContent.push({
                    tag: 'plaintext',
                    attrs: extraAttrs,
                    content: bytes
                });`,
  },
]);

console.log('Baileys newsletter media patch applied');
