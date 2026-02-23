import { bitmapToImageData, imageDataToWebP } from '../../infrastructure/image-processor.js';

const YIQ_THRESHOLD_SQUARED = 0.022;

const AA_MAX_NEIGHBORS_THRESHOLD = 3;

const OUT_MAGENTA_R = 255, OUT_MAGENTA_G = 0,   OUT_MAGENTA_B = 255;
const OUT_YELLOW_R  = 255, OUT_YELLOW_G  = 255, OUT_YELLOW_B  = 0;

function _yiqDistanceSq(r1, g1, b1, r2, g2, b2) {
  const nr1 = r1 / 255, ng1 = g1 / 255, nb1 = b1 / 255;
  const nr2 = r2 / 255, ng2 = g2 / 255, nb2 = b2 / 255;

  const y1 =  0.299  * nr1 + 0.587  * ng1 + 0.114  * nb1;
  const i1 =  0.596  * nr1 - 0.274  * ng1 - 0.322  * nb1;
  const q1 =  0.211  * nr1 - 0.523  * ng1 + 0.312  * nb1;

  const y2 =  0.299  * nr2 + 0.587  * ng2 + 0.114  * nb2;
  const i2 =  0.596  * nr2 - 0.274  * ng2 - 0.322  * nb2;
  const q2 =  0.211  * nr2 - 0.523  * ng2 + 0.312  * nb2;

  const dy = y1 - y2, di = i1 - i2, dq = q1 - q2;
  return 0.5053 * dy * dy + 0.299 * di * di + 0.1957 * dq * dq;
}

function _pixelAt(data, x, y, width) {
  const i = (y * width + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}

function _hasHighContrastNeighbor(data, cx, cy, cr, cg, cb, width, height) {
  let count = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) {continue;}
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) {continue;}
      const [nr, ng, nb] = _pixelAt(data, nx, ny, width);
      if (_yiqDistanceSq(cr, cg, cb, nr, ng, nb) > YIQ_THRESHOLD_SQUARED) {
        count++;
        if (count > AA_MAX_NEIGHBORS_THRESHOLD) {return false;}
      }
    }
  }
  return count > 0 && count <= AA_MAX_NEIGHBORS_THRESHOLD;
}

function _hasMatchingNeighbor(dataA, rA, gA, bA, dataB, cx, cy, width, height) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) {continue;}
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) {continue;}
      const [nr, ng, nb] = _pixelAt(dataB, nx, ny, width);
      if (_yiqDistanceSq(rA, gA, bA, nr, ng, nb) < YIQ_THRESHOLD_SQUARED) {return true;}
    }
  }
  return false;
}

function _isAntiAliased(dataA, dataB, x, y, width, height) {
  const [rA, gA, bA] = _pixelAt(dataA, x, y, width);
  const [rB, gB, bB] = _pixelAt(dataB, x, y, width);

  const aOnEdge = _hasHighContrastNeighbor(dataA, x, y, rA, gA, bA, width, height);
  const bOnEdge = _hasHighContrastNeighbor(dataB, x, y, rB, gB, bB, width, height);

  if (!aOnEdge && !bOnEdge) {return false;}

  const aMatchesNearB = _hasMatchingNeighbor(dataA, rA, gA, bA, dataB, x, y, width, height);
  const bMatchesNearA = _hasMatchingNeighbor(dataB, rB, gB, bB, dataA, x, y, width, height);

  return aMatchesNearB || bMatchesNearA;
}

function _writePixel(out, x, y, width, r, g, b, a = 255) {
  const i = (y * width + x) * 4;
  out[i]     = r;
  out[i + 1] = g;
  out[i + 2] = b;
  out[i + 3] = a;
}

function _blendGray(out, x, y, width, srcData, alpha = 64) {
  const [r, g, b] = _pixelAt(srcData, x, y, width);
  const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  const i = (y * width + x) * 4;
  out[i]     = gray;
  out[i + 1] = gray;
  out[i + 2] = gray;
  out[i + 3] = alpha;
}

async function diffBlobs(baselineBlob, compareBlob) {
  if (!baselineBlob || !compareBlob) {
    throw new TypeError('diffBlobs: both Blobs are required');
  }

  const [bm1, bm2] = await Promise.all([
    createImageBitmap(baselineBlob),
    createImageBitmap(compareBlob)
  ]);

  const outW = Math.max(bm1.width,  bm2.width);
  const outH = Math.max(bm1.height, bm2.height);

  const readCanvas = new OffscreenCanvas(outW, outH);
  const readCtx    = readCanvas.getContext('2d', { alpha: true, willReadFrequently: true });

  readCtx.clearRect(0, 0, outW, outH);
  readCtx.drawImage(bm1, 0, 0);
  const baseData = readCtx.getImageData(0, 0, outW, outH).data;

  readCtx.clearRect(0, 0, outW, outH);
  readCtx.drawImage(bm2, 0, 0);
  const cmpData = readCtx.getImageData(0, 0, outW, outH).data;

  bm1.close();
  bm2.close();

  const outImageData = new ImageData(outW, outH);
  const out          = outImageData.data;

  let diffCount = 0;

  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const [r1, g1, b1, a1] = _pixelAt(baseData, x, y, outW);
      const [r2, g2, b2, a2] = _pixelAt(cmpData,  x, y, outW);

      if (a1 === 0 && a2 === 0) {
        _writePixel(out, x, y, outW, 0, 0, 0, 0);
        continue;
      }

      const distSq = _yiqDistanceSq(r1, g1, b1, r2, g2, b2);
      const alphaDelta = Math.abs(a1 - a2);

      if (distSq <= YIQ_THRESHOLD_SQUARED && alphaDelta < 10) {
        _blendGray(out, x, y, outW, baseData, 32);
        continue;
      }

      diffCount++;

      const isAA = _isAntiAliased(baseData, cmpData, x, y, outW, outH);

      if (isAA) {
        _writePixel(out, x, y, outW, OUT_YELLOW_R, OUT_YELLOW_G, OUT_YELLOW_B, 200);
      } else {
        _writePixel(out, x, y, outW, OUT_MAGENTA_R, OUT_MAGENTA_G, OUT_MAGENTA_B, 255);
      }
    }
  }

  const blob = await imageDataToWebP(outImageData, outW, outH);

  return {
    blob,
    diffCount,
    totalPixels: outW * outH,
    diffRatio:   diffCount / (outW * outH),
    width:       outW,
    height:      outH
  };
}

export { diffBlobs, _yiqDistanceSq, YIQ_THRESHOLD_SQUARED };