const WEBP_QUALITY = 0.85;

async function cropToWebP(sourceBlob, rect) {
  if (!sourceBlob || !(sourceBlob instanceof Blob)) {
    throw new TypeError('cropToWebP: sourceBlob must be a Blob');
  }

  const { x, y, width, height } = rect;

  if (!Number.isFinite(x) || !Number.isFinite(y) ||
      !Number.isFinite(width) || !Number.isFinite(height) ||
      width <= 0 || height <= 0) {
    throw new RangeError(`cropToWebP: degenerate rect ${JSON.stringify(rect)}`);
  }

  const bitmap = await createImageBitmap(sourceBlob);

  const clampedX = Math.max(0, Math.min(x, bitmap.width));
  const clampedY = Math.max(0, Math.min(y, bitmap.height));
  const clampedW = Math.min(width,  bitmap.width  - clampedX);
  const clampedH = Math.min(height, bitmap.height - clampedY);

  if (clampedW <= 0 || clampedH <= 0) {
    bitmap.close();
    throw new RangeError(
      `cropToWebP: rect ${JSON.stringify(rect)} lies outside bitmap ` +
      `${bitmap.width}x${bitmap.height}`
    );
  }

  const canvas = new OffscreenCanvas(clampedW, clampedH);
  const ctx    = canvas.getContext('2d', { alpha: true, willReadFrequently: false });

  ctx.drawImage(bitmap, -clampedX, -clampedY);
  bitmap.close();

  return canvas.convertToBlob({ type: 'image/webp', quality: WEBP_QUALITY });
}

async function bitmapToImageData(blob, targetWidth, targetHeight) {
  const bitmap = await createImageBitmap(blob);
  const w = targetWidth  ?? bitmap.width;
  const h = targetHeight ?? bitmap.height;

  const canvas = new OffscreenCanvas(w, h);
  const ctx    = canvas.getContext('2d', { alpha: true, willReadFrequently: true });

  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  return { imageData: ctx.getImageData(0, 0, w, h), width: w, height: h };
}

async function imageDataToWebP(imageData, width, height) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx    = canvas.getContext('2d', { alpha: true, willReadFrequently: false });
  ctx.putImageData(imageData, 0, 0);
  return canvas.convertToBlob({ type: 'image/webp', quality: WEBP_QUALITY });
}

/**
 * Converts a Blob to a base64 data URI using only APIs available in a
 * Service Worker (no FileReader, no DOM).
 *
 * The chunked String.fromCharCode approach prevents call-stack overflows on
 * large Hi-DPI images (a 2560×1600 WebP can exceed 1 MB of binary data,
 * which would blow the stack in a single `btoa(String.fromCharCode(...bytes))`
 * spread call on most JS engines).
 *
 * @param {Blob} blob
 * @param {string} [mimeType='image/webp']
 * @returns {Promise<string>}  e.g. "data:image/webp;base64,AAAA..."
 */
async function blobToDataUri(blob, mimeType = 'image/webp') {
  if (!(blob instanceof Blob)) {
    throw new TypeError(`blobToDataUri: expected Blob, got ${typeof blob}`);
  }

  let buffer;
  try {
    buffer = await blob.arrayBuffer();
  } catch (err) {
    throw new Error(`blobToDataUri: arrayBuffer() failed (blob.size=${blob.size}): ${err.message}`);
  }

  const bytes     = new Uint8Array(buffer);
  const chunkSize = 8192;
  let   binary    = '';

  try {
    for (let i = 0; i < bytes.length; i += chunkSize) {
      // subarray is zero-copy; spread operates on ≤8192 elements — safe below V8 arg-spread limit
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return `data:${mimeType};base64,${btoa(binary)}`;
  } catch (err) {
    // btoa throws InvalidCharacterError (impossible here — all bytes are 0-255) or, in
    // pathological cases, the binary string exceeds V8's max string length (~512 MB).
    throw new Error(
      `blobToDataUri: base64 encoding failed for ${blob.size}-byte blob: ${err.message}`
    );
  }
}

export { cropToWebP, bitmapToImageData, imageDataToWebP, blobToDataUri, WEBP_QUALITY };