// gcode.js — image / SVG -> polylines -> G-code.
//
// Responsibilities:
//   1. SVG string -> array of polylines (mm), via Paper.js for path flattening.
//   2. Raster (HTMLImageElement / canvas) -> SVG via ImageTracer, then route 1.
//   3. Transform polylines to fit paper with margin (or explicit W×H).
//   4. Greedy nearest-neighbor reorder to minimize pen-up travel.
//   5. Emit Grbl G-code with configurable pen-up / pen-down / feed.
//
// Polyline = [[x0,y0],[x1,y1],...]  in millimeters, paper coordinate system
// (origin bottom-left after final transform).

// ----------------------------------------------------------------------------
// SVG -> polylines using Paper.js (paper-core, no DOM canvas needed for this).

let paperReady = false;
function ensurePaper() {
  if (paperReady) return;
  if (typeof paper === 'undefined') throw new Error('paper.js not loaded');
  // Paper needs a project to operate on.
  paper.setup(new paper.Size(1000, 1000));
  paperReady = true;
}

export function svgToPolylines(svgString, toleranceMm = 0.1) {
  ensurePaper();
  // Clear any prior children.
  paper.project.activeLayer.removeChildren();

  const item = paper.project.importSVG(svgString, { expandShapes: true, insert: true });
  if (!item) return { polylines: [], bounds: null };

  // Apply current transforms onto geometry.
  item.applyMatrix = true;

  const polys = [];
  const walk = (node) => {
    if (node instanceof paper.Path) {
      const poly = pathToPolyline(node, toleranceMm);
      if (poly.length >= 2) polys.push(poly);
    } else if (node instanceof paper.CompoundPath) {
      for (const child of node.children) walk(child);
    } else if (node.children && node.children.length) {
      for (const child of node.children) walk(child);
    }
  };
  walk(item);

  const bounds = item.bounds;
  return {
    polylines: polys,
    bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
  };
}

function pathToPolyline(path, tolerance) {
  // Adaptive subdivision via paper's built-in flatten().
  const cloned = path.clone({ insert: false });
  cloned.flatten(tolerance);
  const out = [];
  for (const seg of cloned.segments) out.push([seg.point.x, seg.point.y]);
  if (cloned.closed && cloned.segments.length) {
    const first = cloned.segments[0].point;
    out.push([first.x, first.y]);
  }
  return out;
}

// ----------------------------------------------------------------------------
// Raster -> SVG via ImageTracer, then SVG -> polylines.

export function rasterToPolylines(imageData, opts) {
  if (typeof ImageTracer === 'undefined') throw new Error('ImageTracer not loaded');
  const tracerOpts = {
    ltres: opts.smoothing ?? 1,
    qtres: 1,
    pathomit: Math.max(8, Math.round((opts.minPathLength ?? 1) * 8)),
    numberofcolors: 2,
    colorquantcycles: 1,
    blurradius: 0,
    strokewidth: 1,
    // Threshold via grayscale palette: <= thresh black, otherwise white.
    pal: [
      { r: 0, g: 0, b: 0, a: 255 },
      { r: 255, g: 255, b: 255, a: 255 },
    ],
  };
  // Apply threshold by binarizing the imageData first; ImageTracer with a
  // 2-color palette + binarized input gives clean traces.
  const binarized = binarize(imageData, opts.threshold ?? 128);
  const svgString = ImageTracer.imagedataToSVG(binarized, tracerOpts);
  return svgToPolylines(svgString, opts.tolerance ?? 0.1);
}

function binarize(imageData, threshold) {
  const out = new ImageData(imageData.width, imageData.height);
  const src = imageData.data;
  const dst = out.data;
  for (let i = 0; i < src.length; i += 4) {
    const lum = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
    const v = lum <= threshold ? 0 : 255;
    dst[i] = dst[i + 1] = dst[i + 2] = v;
    dst[i + 3] = 255;
  }
  return out;
}

// ----------------------------------------------------------------------------
// Layout: scale + center polylines into the paper's drawable area.

export function layoutPolylines(polys, srcBounds, opts) {
  // opts: { paperW, paperH, margin, fit:'fit'|'explicit', outW, outH }
  if (!polys.length || !srcBounds) return [];
  const drawW = opts.paperW - 2 * opts.margin;
  const drawH = opts.paperH - 2 * opts.margin;

  let scale, offX, offY;
  if (opts.fit === 'explicit') {
    const sx = opts.outW / srcBounds.width;
    const sy = opts.outH / srcBounds.height;
    scale = Math.min(sx, sy);
    const w = srcBounds.width * scale;
    const h = srcBounds.height * scale;
    offX = opts.margin + (drawW - w) / 2;
    offY = opts.margin + (drawH - h) / 2;
  } else {
    const sx = drawW / srcBounds.width;
    const sy = drawH / srcBounds.height;
    scale = Math.min(sx, sy);
    const w = srcBounds.width * scale;
    const h = srcBounds.height * scale;
    offX = opts.margin + (drawW - w) / 2;
    offY = opts.margin + (drawH - h) / 2;
  }

  // Paper.js gives y-down. Flip to plotter convention (y-up).
  return polys.map(poly => poly.map(([x, y]) => {
    const tx = (x - srcBounds.x) * scale + offX;
    const ty = opts.paperH - ((y - srcBounds.y) * scale + offY);
    return [tx, ty];
  }));
}

// Remap paper-coords (origin bottom-left, Y up) into plotter machine-coords
// based on which corner the user parked zero at.
export function applyOrigin(polys, origin, paperW, paperH) {
  if (!origin || origin === 'bl') return polys;
  const flipX = origin === 'br' || origin === 'tr';
  const flipY = origin === 'tl' || origin === 'tr';
  return polys.map(poly => poly.map(([x, y]) => [
    flipX ? paperW - x : x,
    flipY ? paperH - y : y,
  ]));
}

// ----------------------------------------------------------------------------
// Greedy nearest-neighbor reorder. Allows reversing a polyline if its end is
// closer than its start.

export function reorderPolylines(polys) {
  if (polys.length < 2) return polys.slice();
  const remaining = polys.map(p => p.slice());
  const out = [];
  let cursor = [0, 0];
  while (remaining.length) {
    let bestIdx = 0;
    let bestDist = Infinity;
    let bestReverse = false;
    for (let i = 0; i < remaining.length; i++) {
      const p = remaining[i];
      const ds = dist2(cursor, p[0]);
      const de = dist2(cursor, p[p.length - 1]);
      if (ds < bestDist) { bestDist = ds; bestIdx = i; bestReverse = false; }
      if (de < bestDist) { bestDist = de; bestIdx = i; bestReverse = true; }
    }
    let chosen = remaining.splice(bestIdx, 1)[0];
    if (bestReverse) chosen.reverse();
    out.push(chosen);
    cursor = chosen[chosen.length - 1];
  }
  return out;
}

function dist2(a, b) {
  const dx = a[0] - b[0], dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

// ----------------------------------------------------------------------------
// Emit G-code.

export function emitGcode(polys, opts) {
  // opts: { feed, penUp, penDown, travelFeed (default 8000) }
  const travelFeed = opts.travelFeed ?? 8000;
  const out = [];
  out.push('; pen-plotter-pwa generated');
  out.push('G21');                  // mm
  out.push('G90');                  // absolute
  out.push('G92 X0 Y0');           // assume head parked at origin
  out.push(opts.penUp);

  for (const poly of polys) {
    if (poly.length < 2) continue;
    const [x0, y0] = poly[0];
    out.push(opts.penUp);
    out.push(`G0 X${fmt(x0)} Y${fmt(y0)} F${travelFeed}`);
    out.push(opts.penDown);
    for (let i = 1; i < poly.length; i++) {
      const [x, y] = poly[i];
      out.push(`G1 X${fmt(x)} Y${fmt(y)} F${opts.feed}`);
    }
  }

  out.push(opts.penUp);
  out.push(`G0 X0 Y0 F${travelFeed}`);
  return out.join('\n') + '\n';
}

function fmt(n) {
  // Three decimals is plenty for mm; trim trailing zeros.
  return (Math.round(n * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '');
}

// ----------------------------------------------------------------------------
// Drop tiny polylines (in mm), to avoid noise from raster tracing.

export function filterShortPolylines(polys, minLenMm) {
  if (!minLenMm) return polys;
  return polys.filter(p => polylineLength(p) >= minLenMm);
}

function polylineLength(p) {
  let total = 0;
  for (let i = 1; i < p.length; i++) {
    const dx = p[i][0] - p[i - 1][0];
    const dy = p[i][1] - p[i - 1][1];
    total += Math.hypot(dx, dy);
  }
  return total;
}
