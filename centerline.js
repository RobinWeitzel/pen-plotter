// centerline.js — raster -> single-stroke polylines (for handwriting / line art).
//
// ImageTracer traces the *outline* of every inked region, so a pen stroke
// becomes a closed loop around its ink. For a plotter we want the stroke's
// centerline instead:
//   1. Binarize, fill tiny enclosed holes (they would become skeleton loops).
//   2. Zhang-Suen thinning -> 1px-wide skeleton.
//   3. Prune short spurs (thinning artifacts at stroke ends and corners).
//   4. Walk the skeleton into polylines, continuing through junctions along the
//      straightest branch so strokes stay long (fewer pen lifts).
//   5. Ramer-Douglas-Peucker simplify to remove pixel staircases.
//
// Input is an ImageData-like { width, height, data }. Output polylines are in
// pixel coordinates (y down), matching what svgToPolylines returns.

const NB = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]; // P2..P9, clockwise from north

export function centerlinePolylines(imageData, opts = {}) {
  const { width: w, height: h } = imageData;
  const threshold = opts.threshold ?? 128;
  const epsilon = opts.smoothing ?? 1;           // RDP tolerance in pixels

  const ink = binarizeMask(imageData, threshold);
  fillSmallHoles(ink, w, h, opts.maxHoleArea ?? 3);
  const inkCount = count(ink);

  const skel = ink.slice();
  zhangSuen(skel, w, h);
  removeStaircases(skel, w, h);
  const skelCount = count(skel);
  if (!skelCount) return { polylines: [], bounds: null };

  // Average stroke width ~ ink area / skeleton length. Spurs shorter than about
  // one stroke width are thinning noise, not real strokes.
  const strokeW = inkCount / skelCount;
  pruneSpurs(skel, w, h, Math.max(3, Math.round(strokeW * 1.2)));

  const raw = traceSkeleton(skel, w, h);
  const polylines = raw
    .map(p => rdp(p, epsilon))
    .filter(p => p.length >= 2);

  return { polylines, bounds: boundsOf(polylines) };
}

// ----------------------------------------------------------------------------

function binarizeMask(imageData, threshold) {
  const { width: w, height: h, data } = imageData;
  const m = new Uint8Array(w * h);
  for (let i = 0, p = 0; p < m.length; i += 4, p++) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    m[p] = lum <= threshold ? 1 : 0;
  }
  // Clear the 1px border so neighbor lookups never leave the image.
  for (let x = 0; x < w; x++) { m[x] = 0; m[(h - 1) * w + x] = 0; }
  for (let y = 0; y < h; y++) { m[y * w] = 0; m[y * w + w - 1] = 0; }
  return m;
}

function count(m) {
  let n = 0;
  for (let i = 0; i < m.length; i++) n += m[i];
  return n;
}

// Fill white regions not connected to the image border whose area is tiny.
// Pinholes inside thick ink would otherwise thin into small loops.
function fillSmallHoles(m, w, h, maxArea) {
  const seen = new Uint8Array(w * h);
  const stack = [];
  for (let start = 0; start < m.length; start++) {
    if (m[start] || seen[start]) continue;
    const region = [];
    let touchesBorder = false;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop();
      region.push(p);
      const x = p % w, y = (p / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesBorder = true;
      for (const q of [p - 1, p + 1, p - w, p + w]) {
        if (q < 0 || q >= m.length || m[q] || seen[q]) continue;
        if ((q === p - 1 || q === p + 1) && ((q / w) | 0) !== y) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    if (!touchesBorder && region.length <= maxArea) {
      for (const p of region) m[p] = 1;
    }
  }
}

function zhangSuen(m, w, h) {
  const del = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const p = y * w + x;
          if (!m[p]) continue;
          const v = NB.map(([dx, dy]) => m[p + dy * w + dx]);
          let b = 0, a = 0;
          for (let k = 0; k < 8; k++) {
            b += v[k];
            if (!v[k] && v[(k + 1) % 8]) a++;
          }
          if (b < 2 || b > 6 || a !== 1) continue;
          // v[0]=P2 N, v[2]=P4 E, v[4]=P6 S, v[6]=P8 W
          if (pass === 0) {
            if (v[0] * v[2] * v[4] || v[2] * v[4] * v[6]) continue;
          } else {
            if (v[0] * v[2] * v[6] || v[0] * v[4] * v[6]) continue;
          }
          del.push(p);
        }
      }
      for (const p of del) m[p] = 0;
      if (del.length) changed = true;
    }
  }
}

// Zhang-Suen leaves corner pixels on diagonal staircases (an L of three
// pixels where the two ends already touch diagonally). Those make fake
// junctions and leave stray pixels the tracer turns into tiny ticks. Remove
// any non-endpoint pixel whose neighbors stay connected to each other without it.
function removeStaircases(m, w, h) {
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (!m[p]) continue;
      const v = NB.map(([dx, dy]) => m[p + dy * w + dx]);
      let b = 0;
      for (const k of v) b += k;
      if (b < 2 || b > 4) continue;
      if (ringComponents(v) === 1) m[p] = 0;
    }
  }
}

// Number of 8-connected groups among the set cells of a 3x3 ring (center
// excluded). Ring order is N, NE, E, SE, S, SW, W, NW: consecutive cells always
// touch, and two orthogonal cells two apart (e.g. N and E) touch diagonally.
function ringComponents(v) {
  const parent = [0, 1, 2, 3, 4, 5, 6, 7];
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a, b) => { if (v[a] && v[b]) parent[find(a)] = find(b); };
  for (let i = 0; i < 8; i++) {
    join(i, (i + 1) % 8);
    if (i % 2 === 0) join(i, (i + 2) % 8);
  }
  const roots = new Set();
  for (let i = 0; i < 8; i++) if (v[i]) roots.add(find(i));
  return roots.size;
}

function neighbors(m, w, p) {
  const out = [];
  for (const [dx, dy] of NB) {
    const q = p + dy * w + dx;
    if (m[q]) out.push(q);
  }
  return out;
}

// Remove branches that run from an endpoint to a junction in fewer than
// maxLen pixels. Isolated short strokes (no junction) are kept — they are
// real marks like i-dots.
function pruneSpurs(m, w, h, maxLen) {
  for (let iter = 0; iter < 2; iter++) {
    const ends = [];
    for (let p = 0; p < m.length; p++) {
      if (m[p] && neighbors(m, w, p).length === 1) ends.push(p);
    }
    for (const e of ends) {
      if (!m[e]) continue;
      const path = [e];
      let prev = -1, cur = e, hitJunction = false;
      while (path.length <= maxLen) {
        const nb = neighbors(m, w, cur).filter(q => q !== prev && !path.includes(q));
        if (nb.length !== 1) { hitJunction = nb.length > 1; break; }
        prev = cur;
        cur = nb[0];
        if (neighbors(m, w, cur).length > 2) { hitJunction = true; break; }
        path.push(cur);
      }
      if (hitJunction && path.length < maxLen) {
        for (const p of path) m[p] = 0;
      }
    }
  }
}

// Walk the skeleton into polylines. Each walk extends from a start pixel in
// both directions, always taking the unvisited neighbor that turns least, and
// ends by stepping onto an already-visited neighbor (if any) so branches stay
// connected to the strokes they meet.
function traceSkeleton(m, w, h) {
  const visited = new Uint8Array(w * h);
  const polylines = [];
  const xy = (p) => [p % w, (p / w) | 0];

  const walk = (start, first) => {
    const pts = [first];
    visited[first] = 1;
    let prev = start, cur = first;
    for (;;) {
      const [cx, cy] = xy(cur), [px, py] = xy(prev);
      const dir = [cx - px, cy - py];
      let best = -1, bestScore = -Infinity, joinTo = -1;
      for (const q of neighbors(m, w, cur)) {
        if (q === prev) continue;
        if (visited[q]) { joinTo = q; continue; }
        const [qx, qy] = xy(q);
        const d = [qx - cx, qy - cy];
        const score = (dir[0] * d[0] + dir[1] * d[1]) / Math.hypot(...d);
        if (score > bestScore) { bestScore = score; best = q; }
      }
      if (best < 0) {
        if (joinTo >= 0) pts.push(joinTo);
        return pts;
      }
      visited[best] = 1;
      pts.push(best);
      prev = cur;
      cur = best;
    }
  };

  const startFrom = (s) => {
    visited[s] = 1;
    const nb = neighbors(m, w, s).filter(q => !visited[q]);
    const a = nb.length ? walk(s, nb[0]) : [];
    const rest = neighbors(m, w, s).filter(q => !visited[q]);
    const b = rest.length ? walk(s, rest[0]) : [];
    const pix = [...b.reverse(), s, ...a];
    if (pix.length >= 2) polylines.push(pix.map(xy));
  };

  // Endpoints first so open strokes are drawn end-to-end, then whatever is
  // left (closed loops, junction-to-junction segments).
  for (let p = 0; p < m.length; p++) {
    if (m[p] && !visited[p] && neighbors(m, w, p).length === 1) startFrom(p);
  }
  for (let p = 0; p < m.length; p++) {
    if (m[p] && !visited[p]) startFrom(p);
  }
  return polylines;
}

function rdp(pts, eps) {
  if (pts.length < 3 || eps <= 0) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    const [ax, ay] = pts[i], [bx, by] = pts[j];
    const len = Math.hypot(bx - ax, by - ay);
    let maxD = 0, idx = -1;
    for (let k = i + 1; k < j; k++) {
      const [px, py] = pts[k];
      const d = len === 0
        ? Math.hypot(px - ax, py - ay)
        : Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
      if (d > maxD) { maxD = d; idx = k; }
    }
    if (maxD > eps) {
      keep[idx] = 1;
      stack.push([i, idx], [idx, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}

function boundsOf(polys) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polys) for (const [x, y] of p) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}
