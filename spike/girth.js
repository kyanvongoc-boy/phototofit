// Spike: live girth from silhouette widths while the person rotates.
// Cauchy's formula: perimeter of a convex section = ∫_0^π w(θ) dθ.
// A tape measure follows the convex hull of the body section, so this is what a tape reads.
// For a left-right symmetric body w(θ) = w(π − θ), so we only need θ in [0°, 90°] and double it.

export const BIN_DEG = 5;
export const NBINS = 90 / BIN_DEG;

const DEG = Math.PI / 180;

export function median(values) {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function binIndex(thetaDeg) {
  const t = Math.min(89.999, Math.max(0, thetaDeg));
  return Math.floor(t / BIN_DEG);
}

// Fold any yaw angle into [0°, 90°] using w(θ) = w(θ + 180°) = w(−θ).
export function foldAngle(deg) {
  let t = ((deg % 180) + 180) % 180;
  if (t > 90) t = 180 - t;
  return t;
}

// bins: array of NBINS arrays of widths (cm). Returns null until two bins have data.
export function girthFromBins(bins) {
  const pts = [];
  let filled = 0;
  let varSum = 0;
  for (let i = 0; i < NBINS; i++) {
    const b = bins[i];
    if (!b.length) continue;
    filled++;
    const m = median(b);
    pts.push([(i + 0.5) * BIN_DEG, m]);
    const mad = median(b.map((x) => Math.abs(x - m)));
    const sigma = b.length > 1 ? (1.4826 * mad) / Math.sqrt(b.length) : 1.0;
    varSum += sigma * sigma;
  }
  if (pts.length < 2) return null;

  const widthAt = (t) => {
    if (t <= pts[0][0]) return pts[0][1];
    if (t >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
    for (let k = 1; k < pts.length; k++) {
      if (t <= pts[k][0]) {
        const [t0, w0] = pts[k - 1];
        const [t1, w1] = pts[k];
        return w0 + ((w1 - w0) * (t - t0)) / (t1 - t0);
      }
    }
    return pts[pts.length - 1][1];
  };

  const step = 0.5;
  let integral = 0;
  for (let t = 0; t < 90; t += step) {
    integral += ((widthAt(t) + widthAt(t + step)) / 2) * step * DEG;
  }
  const girth = 2 * integral;

  const widths = pts.map((p) => p[1]);
  const spread = Math.max(...widths) - Math.min(...widths);
  const missing = NBINS - filled;
  const binRad = BIN_DEG * DEG;
  const noise = 2 * binRad * Math.sqrt(varSum);
  const gap = 2 * binRad * missing * (spread / 4);
  return { girth, coverage: filled / NBINS, plusMinus: noise + gap };
}

// An arm touching the torso only ever adds width, in a bump a few bins wide. Fit a smooth width curve
// w(θ) = A0 + A2·cos2θ + A4·cos4θ (fits ellipses and two-lobed chests alike) to the per-bin medians, and drop
// samples more than tolCm above it. Repeat, since the first fit is pulled up by the bumps.
export function dropArmOutliers(bins, tolCm = 1.5) {
  let cur = bins;
  for (let it = 0; it < 4; it++) {
    const rows = [];
    cur.forEach((b, i) => { if (b.length) rows.push([(i + 0.5) * BIN_DEG * DEG, median(b)]); });
    if (rows.length < 6) return cur;
    const coef = leastSquares(rows.map(([t]) => [1, Math.cos(2 * t), Math.cos(4 * t)]), rows.map((r) => r[1]));
    if (!coef) return cur;
    const fit = (t) => coef[0] + coef[1] * Math.cos(2 * t) + coef[2] * Math.cos(4 * t);
    cur = bins.map((b, i) => { const f = fit((i + 0.5) * BIN_DEG * DEG); return b.filter((w) => w - f < tolCm); });
  }
  return cur;
}

// Ordinary least squares via the normal equations (tiny systems only).
function leastSquares(X, y) {
  const n = X[0].length;
  const A = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  X.forEach((row, k) => {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) A[i][j] += row[i] * row[j];
      A[i][n] += row[i] * y[k];
    }
  });
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-9) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let j = c; j <= n; j++) A[r][j] -= f * A[c][j];
    }
  }
  return A.map((row, i) => row[n] / row[i]);
}

// Classic two-view estimate for comparison: ellipse from front width and side depth (Ramanujan).
export function ellipseGirth(wFront, wSide) {
  const a = wFront / 2;
  const b = wSide / 2;
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

// Yaw from MediaPipe world landmarks (meters): angle of the shoulder and hip lines in the x–z plane.
export function yawFromWorld(w) {
  const ang = (l, r) => Math.atan2(Math.abs(w[l].z - w[r].z), Math.abs(w[l].x - w[r].x)) / DEG;
  return (ang(11, 12) + ang(23, 24)) / 2;
}

// Yaw from 2D shoulder width relative to the frontal width seen at the start (good near 0°, weak near 90°).
export function yawFrom2D(shoulderPx, frontalShoulderPx) {
  const r = Math.min(1, shoulderPx / frontalShoulderPx);
  return Math.acos(r) / DEG;
}

// Trust the 2D estimate near the front and the world estimate towards the side.
export function combineYaw(yaw2d, yawWorld) {
  const k = Math.sin(yaw2d * DEG) ** 2;
  return (1 - k) * yaw2d + k * Math.max(yaw2d, yawWorld);
}

// Width (in mask pixels) of the foreground run on row y that contains or is nearest to xCenter.
export function runAtRow(mask, mw, mh, y, xCenter, threshold = 0.5) {
  const row = Math.round(y);
  if (row < 0 || row >= mh) return null;
  const base = row * mw;
  const fg = (x) => x >= 0 && x < mw && mask[base + x] > threshold;
  let x = Math.round(xCenter);
  if (!fg(x)) {
    let found = -1;
    for (let d = 1; d < mw * 0.1; d++) {
      if (fg(x - d)) { found = x - d; break; }
      if (fg(x + d)) { found = x + d; break; }
    }
    if (found < 0) return null;
    x = found;
  }
  let left = x;
  let right = x;
  while (fg(left - 1)) left--;
  while (fg(right + 1)) right++;
  return { left, right, width: right - left + 1 };
}

// Top and bottom rows of the person only: walk up and down from yStart inside the column band [xLo, xHi],
// stopping after maxGap empty rows, so stray mask blobs elsewhere in the frame are ignored.
export function personExtent(mask, mw, mh, xLo, xHi, yStart, maxGap = 3, threshold = 0.5, minPixels = 2) {
  const lo = Math.max(0, Math.floor(xLo)), hi = Math.min(mw - 1, Math.ceil(xHi));
  const rowHas = (y) => {
    let n = 0;
    const base = y * mw;
    for (let x = lo; x <= hi; x++) if (mask[base + x] > threshold && ++n >= minPixels) return true;
    return false;
  };
  const y0 = Math.min(mh - 1, Math.max(0, Math.round(yStart)));
  if (!rowHas(y0)) return null;
  const walk = (dir) => {
    let last = y0, gap = 0;
    for (let y = y0 + dir; y >= 0 && y < mh; y += dir) {
      if (rowHas(y)) { last = y; gap = 0; } else if (++gap > maxGap) break;
    }
    return last;
  };
  return { top: walk(-1), bottom: walk(1) };
}

// Top and bottom rows of the person in the mask (head top to soles).
export function verticalExtent(mask, mw, mh, threshold = 0.5, minPixels = 3) {
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < mh; y++) {
    let n = 0;
    const base = y * mw;
    for (let x = 0; x < mw; x++) if (mask[base + x] > threshold) n++;
    if (n >= minPixels) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  return top < 0 ? null : { top, bottom };
}
