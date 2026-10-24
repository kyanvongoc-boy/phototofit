// Per-frame scan logic, free of DOM and MediaPipe so it can be driven by synthetic frames (scan.test.mjs).
import {
  NBINS, binIndex, foldAngle, girthFromBins, dropArmOutliers, ellipseGirth,
  yawFromWorld, yawFrom2D, combineYaw, runAtRow, personExtent,
} from "./girth.js?v=6";

// Girth from a level's raw width samples, after dropping arm-contaminated widths.
export const girthOf = (bins) => girthFromBins(dropArmOutliers(bins));

// depth: typical front-to-back depth ÷ side-to-side width of the section at BMI 22, for the instant estimate from
// the front view; perBmi: how much deeper the section gets per BMI point. Rough guesses, not yet fitted to real data.
export const LEVELS = [
  { key: "chest", name: "Ngực", color: "#5aa9ff", depth: 0.72, perBmi: 0.010 },
  { key: "waist", name: "Eo", color: "#f0b429", depth: 0.76, perBmi: 0.015 },
  { key: "hip", name: "Hông", color: "#c77dff", depth: 0.72, perBmi: 0.008 },
];
// The instant estimate guesses the depth, so it is only good to a few cm until the turn measures it.
const QUICK_PM = 5, QUICK_PM_WITH_WEIGHT = 4;
export const FRONT_FRAMES = 15;
export const MAX_SPEED = 45; // °/s of body rotation
// Lock a girth once most angles are covered (both the front and the side end), and it has stopped moving.
export const LOCK = { coverage: 0.75, stableFrames: 20, stableRange: 0.6 };

// On-screen body outline the person stands into (fractions of the frame). 60% of the frame height puts
// the person about 2 m from a phone's main camera; the same distance every time keeps the pixel scale steady.
export const GUIDE = { top: 0.2, bottom: 0.8, cx: 0.5, tolY: 0.08, tolX: 0.12, maxYaw: 30 };
// A hand-held phone and a person swaying drop out of the outline for a few frames at a time; only a longer
// drop-out restarts the hold.
const FIT_GRACE_MS = 700;

export function newScan() {
  return {
    phase: "front",               // front (stand in the outline) → rotate
    frontShoulder: [],            // 2D shoulder widths while facing the camera inside the outline
    frontalShoulderPx: 0,
    frontSince: null,             // time of the first good frontal frame
    lastFitTs: null,              // time of the last frame inside the outline
    bins: Object.fromEntries(LEVELS.map((l) => [l.key, Array.from({ length: NBINS }, () => [])])),
    history: Object.fromEntries(LEVELS.map((l) => [l.key, []])),
    locked: {},
    quick: {},                    // smoothed front width (cm) per level, for the instant estimate
    yawHist: [],
    cutFrames: 0,                 // consecutive frames with head or feet cut off
  };
}

const hasEnds = (bins) =>
  (bins[0].length || bins[1].length) && (bins[NBINS - 1].length || bins[NBINS - 2].length || bins[NBINS - 3].length);

// How the person sits against the outline: null when matched, else what to tell them.
function guideFit(ext, mh, cx, yawWorld) {
  const top = ext.top / mh, bottom = ext.bottom / mh;
  const size = bottom - top, target = GUIDE.bottom - GUIDE.top;
  const mid = (top + bottom) / 2, targetMid = (GUIDE.top + GUIDE.bottom) / 2;
  if (size > target + GUIDE.tolY) return "Lùi ra xa một chút cho vừa khung";
  if (size < target - GUIDE.tolY) return "Bước lại gần camera cho vừa khung";
  // Tilting the phone up moves the person down in the picture.
  if (mid < targetMid - GUIDE.tolY) return "Ngửa camera lên một chút cho vừa khung";
  if (mid > targetMid + GUIDE.tolY) return "Chúc camera xuống một chút cho vừa khung";
  // Facing the camera, the image's left is the person's right.
  if (cx < GUIDE.cx - GUIDE.tolX) return "Bước sang trái một chút";
  if (cx > GUIDE.cx + GUIDE.tolX) return "Bước sang phải một chút";
  if (yawWorld > GUIDE.maxYaw) return "Quay mặt thẳng vào camera";
  return null;
}

// f: { lm, wl, mask, mw, mh, vw, vh, ts }   (lm normalized image landmarks, wl world landmarks in meters)
// opts: { heightCm, lv: { chest, waist, hip } }
// Returns what to say/show and what to draw; updates s in place.
export function scanFrame(s, f, opts) {
  const { lm, wl, mask, mw, mh, vw, vh, ts } = f;
  const vis = (i) => lm[i].visibility ?? 1;
  // Side-on, the far shoulder, hip, knee and ankle are hidden and their visibility drops, so one of each pair is enough.
  const visible = [[11, 12], [23, 24], [25, 26]].every(([a, b]) => Math.max(vis(a), vis(b)) > 0.5);

  // Person's extent: only the silhouette connected to the hips, inside the landmarks' column band.
  const xs = lm.map((p) => p.x);
  const padX = (Math.max(...xs) - Math.min(...xs)) * 0.25 + 0.02;
  const hipX = (lm[23].x + lm[24].x) / 2, hipY = ((lm[23].y + lm[24].y) / 2) * mh;
  let ext = personExtent(mask, mw, mh, (Math.min(...xs) - padX) * mw, (Math.max(...xs) + padX) * mw, hipY, Math.round(mh * 0.02));
  // A floor shadow attached to the feet would make the person look taller: cap the soles just below the feet landmarks.
  const footY = Math.max(...[27, 28, 29, 30, 31, 32].map((i) => lm[i].y));
  if (ext) ext = { top: ext.top, bottom: Math.min(ext.bottom, Math.round((footY + 0.015) * mh)) };
  const edge = Math.max(1, Math.round(mh * 0.005));
  const headCut = !ext || ext.top <= edge || lm[0].y < 0.03;
  const feetCut = !ext || ext.bottom >= mh - 1 - edge || footY > 0.99 || Math.max(vis(27), vis(28)) < 0.3;
  const inFrame = !headCut && !feetCut;
  s.cutFrames = inFrame ? 0 : s.cutFrames + 1;

  // Scale from the person's full height in the mask (top of head to soles).
  const cmPerVideoPx = ext ? opts.heightCm / ((ext.bottom - ext.top) * (vh / mh)) : NaN;
  const cmPerMaskX = cmPerVideoPx * (vw / mw);

  const yawWorld = foldAngle(yawFromWorld(wl));
  const fitMsg = inFrame ? guideFit(ext, mh, hipX, yawWorld) : "Đứng vào khung hình người";
  const fitNow = inFrame && visible && !fitMsg;
  if (fitNow) s.lastFitTs = ts;
  // Inside the outline, or only just out of it: keep the outline green and the hold going.
  const fit = fitNow || (s.lastFitTs != null && ts - s.lastFitTs <= FIT_GRACE_MS);

  // Front phase: ~1 s standing inside the outline, facing the camera, gives the frontal shoulder width; then scanning starts.
  // Shoulder width relative to the person's height in the picture, so a hand-held phone moving closer or further
  // away doesn't read as turning.
  const personPx = ext ? (ext.bottom - ext.top) * (vh / mh) : NaN;
  const shoulderPx = Math.hypot((lm[11].x - lm[12].x) * vw, (lm[11].y - lm[12].y) * vh) / personPx;
  if (s.phase === "front") {
    if (fit) {
      // Only frames really inside the outline give the frontal shoulder width; grace frames just keep the clock.
      if (fitNow) s.frontShoulder.push(shoulderPx);
      s.frontSince ??= ts;
      if (s.frontShoulder.length >= FRONT_FRAMES && ts - s.frontSince >= 1000) {
        // A high percentile rather than the max: one wobbly frame shouldn't set "facing the camera".
        const sorted = [...s.frontShoulder].sort((a, b) => a - b);
        s.frontalShoulderPx = sorted[Math.floor(sorted.length * 0.8)];
        s.phase = "rotate";
      }
    } else {
      // Out of the outline for longer than the grace: restart the hold, so the frontal width comes from one stance.
      s.frontShoulder = [];
      s.frontSince = null;
    }
  }
  // Yaw (body rotation), folded into [0°, 90°].
  const yaw = s.frontalShoulderPx
    ? foldAngle(combineYaw(yawFrom2D(shoulderPx, s.frontalShoulderPx), yawFromWorld(wl)))
    : yawWorld;

  // Rotation speed over the last 0.6 s.
  s.yawHist.push([ts, yaw]);
  while (s.yawHist.length && ts - s.yawHist[0][0] > 600) s.yawHist.shift();
  const [t0, y0] = s.yawHist[0];
  const speed = ts - t0 > 200 ? Math.abs(yaw - y0) / ((ts - t0) / 1000) : 0;

  // While rotating, stay roughly on the spot (the scale was set at this distance).
  const onSpot = Math.abs(hipX - GUIDE.cx) < GUIDE.tolX * 2;
  const ok = s.phase === "rotate" && visible && inFrame && onSpot && isFinite(yaw) && speed <= MAX_SPEED;

  // Measurement levels from landmarks (normalized → mask coords).
  const mid = (a, b) => ({ x: (lm[a].x + lm[b].x) / 2, y: (lm[a].y + lm[b].y) / 2 });
  const S = mid(11, 12), Hp = mid(23, 24), K = mid(25, 26);
  const lerp = (p, q, t) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
  const at = { chest: lerp(S, Hp, opts.lv.chest), waist: lerp(S, Hp, opts.lv.waist), hip: lerp(Hp, K, opts.lv.hip) };

  const spans = [];
  for (const l of LEVELS) {
    const p = at[l.key];
    const run = runAtRow(mask, mw, mh, p.y * mh, p.x * mw);
    if (!run) continue;
    // Reject if an arm (shoulder → wrist, so the forearm counts too) is merged into the silhouette edge at this level.
    let armMerged = false;
    for (const [sh, el] of [[11, 15], [12, 16]]) {
      const ys = lm[sh].y, ye = lm[el].y;
      if (p.y > Math.min(ys, ye) && p.y < Math.max(ys, ye)) {
        const ax = (lm[sh].x + (lm[el].x - lm[sh].x) * ((p.y - ys) / (ye - ys))) * mw;
        const e = (run.right - run.left) * 0.15;
        if ((ax > run.left && ax < run.left + e) || (ax < run.right && ax > run.right - e)) armMerged = true;
      }
    }
    spans.push({ key: l.key, color: l.color, row: Math.round(p.y * mh), left: run.left, right: run.right, armMerged });

    // Instant estimate: as soon as the person is in view and facing the camera, smooth the front width.
    if (inFrame && visible && !armMerged && yaw < 20 && isFinite(cmPerMaskX)) {
      const w = run.width * cmPerMaskX;
      s.quick[l.key] = s.quick[l.key] == null ? w : s.quick[l.key] * 0.8 + w * 0.2;
    }

    if (!ok || armMerged || s.locked[l.key]) continue;
    const bins = s.bins[l.key];
    bins[binIndex(yaw)].push(run.width * cmPerMaskX);
    const g = girthOf(bins);
    if (!g) continue;
    const h = s.history[l.key];
    h.push(g.girth);
    if (h.length > LOCK.stableFrames) h.shift();
    const range = Math.max(...h) - Math.min(...h);
    if (g.coverage >= LOCK.coverage && hasEnds(bins) && h.length === LOCK.stableFrames && range < LOCK.stableRange) {
      s.locked[l.key] = g;
    }
  }

  // Guidance. Only complain about framing after ~10 bad frames in a row, so one noisy frame doesn't nag.
  const cutLong = s.cutFrames >= 10;
  const allLocked = LEVELS.every((l) => s.locked[l.key]);
  let say = null;
  if (cutLong && headCut && feetCut) say = "Lùi ra xa hơn, chưa thấy cả đầu và chân";
  else if (cutLong && headCut) say = "Chưa thấy đỉnh đầu: ngửa máy lên một chút hoặc lùi ra";
  else if (cutLong && feetCut) say = "Chưa thấy bàn chân: hạ máy thấp hơn hoặc lùi ra";
  else if (!inFrame) say = null; // brief cut-off: keep the previous message
  else if (!visible) say = "Đứng rõ trong khung, không che vai hông";
  else if (s.phase === "front") say = fit ? "Vừa khung rồi, giữ yên" : fitMsg;
  else if (allLocked) say = "Xong! Đã khoá cả ba số đo";
  else if (!onSpot) say = "Xoay tại chỗ, đừng bước đi";
  else if (speed > MAX_SPEED) say = "Xoay chậm lại";
  // A quarter turn (front → side-on) is enough: hold side-on until the numbers lock.
  else if (LEVELS.every((l) => s.locked[l.key] || hasEnds(s.bins[l.key]))) say = "Giữ yên tư thế nghiêng một chút";
  else say = "Xoay chậm sang ngang, tới khi đứng nghiêng";

  // Progress line: which step we are on and why a frame is not counted.
  let status;
  if (s.phase === "front") {
    status = fit
      ? `Bước 2/3 · vừa khung, giữ yên ${Math.min(s.frontShoulder.length, FRONT_FRAMES)}/${FRONT_FRAMES}`
      : `Bước 1/3 · đứng vào khung${headCut ? " (thiếu đầu)" : ""}${feetCut ? " (thiếu chân)" : ""}${!visible ? " (vai/hông/gối bị che)" : ""}`;
  } else if (allLocked) {
    status = "Xong · khoá 3/3";
  } else {
    const open = LEVELS.filter((l) => !s.locked[l.key]);
    const cov = open.reduce((n, l) => n + s.bins[l.key].filter((b) => b.length).length, 0) / (open.length * NBINS);
    const why = speed > MAX_SPEED ? " (xoay nhanh)" : !inFrame ? " (ra khỏi khung)" : !visible ? " (bị che)" : !onSpot ? " (bước khỏi chỗ)" : "";
    status = `Bước 3/3 · đang quét ${Math.round(cov * 100)}% · khoá ${LEVELS.length - open.length}/3${ok ? "" : " · bỏ qua khung này" + why}`;
  }

  return { say, status, ok, fit, visible, headCut, feetCut, yaw, speed, cmPerVideoPx, ext, spans, live: liveValues(s, opts) };
}

// Which 5° turn bins have a reading for any level still being measured (for the on-screen turn gauge).
export function coveredBins(s) {
  const open = LEVELS.filter((l) => !s.locked[l.key]);
  return Array.from({ length: NBINS }, (_, i) => open.length === 0 || open.some((l) => s.bins[l.key][i].length > 0));
}

// What to show next to each level right now: locked value, the turn's running estimate once it has both
// a front and a side reading, or else the instant front-view estimate (deeper sections for a higher BMI).
export function liveValues(s, opts = {}) {
  const bmi = opts.weightKg > 0 && opts.heightCm > 0 ? opts.weightKg / (opts.heightCm / 100) ** 2 : null;
  const dBmi = bmi == null ? 0 : Math.min(38, Math.max(17, bmi)) - 22;
  const out = {};
  for (const l of LEVELS) {
    const locked = s.locked[l.key];
    if (locked) { out[l.key] = { value: locked.girth, pm: locked.plusMinus, kind: "locked" }; continue; }
    const g = hasEnds(s.bins[l.key]) ? girthOf(s.bins[l.key]) : null;
    if (g) { out[l.key] = { value: g.girth, pm: g.plusMinus, kind: "scanning" }; continue; }
    const w = s.quick[l.key];
    if (w != null) {
      out[l.key] = { value: ellipseGirth(w, w * (l.depth + l.perBmi * dBmi)), pm: bmi == null ? QUICK_PM : QUICK_PM_WITH_WEIGHT, kind: "quick" };
    }
  }
  return out;
}
