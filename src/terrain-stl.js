// Turns a rectangle of DEM data into printable solids and writes them as binary STL.
//
// The rectangle is axis-aligned in Web Mercator ([0, 1] world units, y down), so
// the model's top edge points north. It is scaled to true size at its center
// latitude; the Mercator stretch across a few km is far below print precision.

import earcut from 'earcut';

const EARTH_CIRCUMFERENCE = 40075016.686; // meters, at the equator
// Mapterhorn covers the whole globe up to this zoom, and higher zooms only where
// high-resolution data exists (missing tiles there are 404s).
const GLOBAL_DEM_MAXZOOM = 12;
const MAX_DEM_ZOOM = 17;
// Smallest distance (mm) between a cut and any vertex height, far below print
// precision but well above float32 rounding in the STL.
const LEVEL_GAP = 0.01;
// Smallest land value (grid cells) at a vertex, so the shore never runs through one.
const SHORE_GAP = 0.05;
// A point counts as on a segment when its distance from it is below this fraction of
// the segment's length: far above rounding, far below the spacing of the points.
const ON_EDGE = 1e-9;

/** Ground meters per world unit at the rectangle's center latitude. */
export function metersPerWorldUnit({ y0, y1 }) {
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (y0 + y1)))); // radians
  return EARTH_CIRCUMFERENCE * Math.cos(lat);
}

/**
 * Loads the DEM tiles covering `bounds` at `zoom`, or at the highest lower zoom
 * that has data for all of them. Tiles above GLOBAL_DEM_MAXZOOM exist only in
 * some regions, so mixing zooms would leave a step in the model at the edge of
 * the high-resolution data.
 * @param {object} demSource maplibre-contour DemSource
 * @param {{x0: number, y0: number, x1: number, y1: number}} bounds world units
 * @param {number} zoom preferred DEM zoom
 */
export async function loadDem(demSource, bounds, zoom) {
  const fetchTile = (z, x, y) => demSource.getDemTile(z, x, y).catch(() => null);
  for (let z = Math.min(Math.max(Math.round(zoom), 0), MAX_DEM_ZOOM); ; z--) {
    const n = 2 ** z;
    // One pixel of margin on each side for the bilinear neighbors at the edges.
    const pad = 1 / (n * 512);
    const tileOf = (w) => Math.min(Math.max(Math.floor(w * n), 0), n - 1);
    const tx0 = tileOf(bounds.x0 - pad);
    const ty0 = tileOf(bounds.y0 - pad);
    const cols = tileOf(bounds.x1 + pad) - tx0 + 1;
    const rows = tileOf(bounds.y1 + pad) - ty0 + 1;
    const highRes = z > GLOBAL_DEM_MAXZOOM;
    // Probe the center tile first, so a zoom without data costs one request.
    if (highRes && !(await fetchTile(z, tileOf((bounds.x0 + bounds.x1) / 2), tileOf((bounds.y0 + bounds.y1) / 2)))) {
      continue;
    }
    const tiles = await Promise.all(
      Array.from({ length: cols * rows }, (_, i) => fetchTile(z, tx0 + (i % cols), ty0 + Math.floor(i / cols))),
    );
    if (highRes && !tiles.every(Boolean)) continue;
    return { z, tx0, ty0, cols, rows, tiles };
  }
}

/** The DEM zoom whose pixels are no larger than `spacing` world units. */
export function demZoomFor(spacing) {
  return Math.min(Math.max(Math.ceil(Math.log2(1 / (512 * spacing))), 0), MAX_DEM_ZOOM);
}

/**
 * Samples elevations on an nx × ny grid spanning `bounds`, row by row from the
 * north edge, with bilinear interpolation across tile seams.
 * @returns {{grid: Float32Array, min: number, max: number}}
 */
export function sampleGrid(dem, bounds, nx, ny) {
  const { z, tx0, ty0, cols, rows, tiles } = dem;
  const size = tiles.find(Boolean)?.width;
  if (!size) throw new Error('No elevation data for this area');
  const scale = 2 ** z * size; // world units -> pixels at this zoom
  const gxMin = tx0 * size;
  const gyMin = ty0 * size;
  const gxMax = (tx0 + cols) * size - 1;
  const gyMax = (ty0 + rows) * size - 1;

  function pixel(gx, gy) {
    gx = Math.min(Math.max(gx, gxMin), gxMax);
    gy = Math.min(Math.max(gy, gyMin), gyMax);
    const tile = tiles[(Math.floor(gy / size) - ty0) * cols + Math.floor(gx / size) - tx0];
    return tile ? tile.data[(gy % size) * size + (gx % size)] : NaN;
  }

  const grid = new Float32Array(nx * ny);
  let min = Infinity;
  let max = -Infinity;
  for (let j = 0; j < ny; j++) {
    // Pixel values describe pixel centers, which sit half a pixel in.
    const py = (bounds.y0 + ((bounds.y1 - bounds.y0) * j) / (ny - 1)) * scale - 0.5;
    const y = Math.floor(py);
    const fy = py - y;
    for (let i = 0; i < nx; i++) {
      const px = (bounds.x0 + ((bounds.x1 - bounds.x0) * i) / (nx - 1)) * scale - 0.5;
      const x = Math.floor(px);
      const fx = px - x;
      const top = pixel(x, y) * (1 - fx) + pixel(x + 1, y) * fx;
      const bottom = pixel(x, y + 1) * (1 - fx) + pixel(x + 1, y + 1) * fx;
      const ele = top * (1 - fy) + bottom * fy;
      grid[j * nx + i] = ele;
      if (ele < min) min = ele;
      if (ele > max) max = ele;
    }
  }
  if (!Number.isFinite(min)) throw new Error('No elevation data for this area');
  // A tile that failed to load leaves holes; fill them at the lowest point.
  for (let k = 0; k < grid.length; k++) if (Number.isNaN(grid[k])) grid[k] = min;
  return { grid, min, max };
}

/** A land value kept off zero, so the shore never runs through a vertex. */
function offShore(l) {
  return l < 0 ? Math.min(l, -SHORE_GAP) : Math.max(l, SHORE_GAP);
}

/** Where the shore crosses the edge between land values lu and lv, from 0 at u to 1 at v. */
function shoreAt(lu, lv) {
  return lu / (lu - lv);
}

/**
 * The lowest and highest elevation on land, as buildBands() cuts it: the vertices on
 * land, and the shore points where the edges between land and sea cross it.
 * @param {Float32Array} grid elevations, as for buildBands()
 * @param {Float32Array} land land values, as for buildBands()
 * @returns {{min: number, max: number}} min > max if there is no land
 */
export function landRange(grid, land, nx, ny) {
  let min = Infinity;
  let max = -Infinity;
  const shore = (u, v) => {
    const lu = offShore(land[u]);
    const lv = offShore(land[v]);
    if (lu > 0 === lv > 0) return;
    const ele = grid[u] + shoreAt(lu, lv) * (grid[v] - grid[u]);
    if (ele < min) min = ele; // never above both ends, so never the max
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const v = j * nx + i;
      if (offShore(land[v]) > 0) {
        if (grid[v] < min) min = grid[v];
        if (grid[v] > max) max = grid[v];
      }
      // The triangles' edges east, south and south-east of v.
      if (i + 1 < nx) shore(v, v + 1);
      if (j + 1 < ny) shore(v, v + nx);
      if (i + 1 < nx && j + 1 < ny) shore(v, v + nx + 1);
    }
  }
  return { min, max };
}

/**
 * Builds the model as closed solids stacked between horizontal cuts, so a slicer can
 * load them as parts of one object and print each in its own filament. Band k holds
 * the model between heights levels[k] and levels[k + 1] (the last band has no top),
 * with the terrain on top, the side walls, and flat faces at its cuts. Neighboring
 * bands share their cut faces exactly and never overlap.
 *
 * With `land`, the model is also cut vertically at the shore, where `land` crosses
 * zero between two vertices, and keeps only the land. The walls then follow the shore.
 * @param {object} options
 * @param {Float32Array} options.grid elevations in meters, row by row from the north edge
 * @param {Float32Array} [options.land] per grid vertex, positive on land and negative
 *   at sea, such as its signed distance to the shore; the whole area is land without it
 * @param {number} options.nx samples per row
 * @param {number} options.ny rows
 * @param {number} options.width model width in mm (west to east)
 * @param {number} options.depth model depth in mm (north to south)
 * @param {(ele: number) => number} options.toZ model height in mm for an elevation
 * @param {number[]} options.levels ascending cut heights in mm, starting with 0 (the bed)
 * @returns {Float32Array[]} per band, its triangles as x, y, z of three vertices each,
 *   counter-clockwise seen from outside
 */
export function buildBands({ grid, land, nx, ny, width, depth, toZ, levels }) {
  const n = nx * ny;
  const dx = width / (nx - 1);
  const dy = depth / (ny - 1);
  // Grid vertices; model y points north, grid rows run from north to south.
  const X = new Float64Array(n);
  const Y = new Float64Array(n);
  const Z = new Float64Array(n);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const v = j * nx + i;
      X[v] = i * dx;
      Y[v] = (ny - 1 - j) * dy;
      Z[v] = toZ(grid[v]);
    }
  }
  levels = spaceLevels(levels);
  keepOffLevels(levels, Z);
  const L = land && Float64Array.from(land, offShore);
  const onLand = L ? (v) => L[v] > 0 : () => true;

  // Points are grid vertex indices below n, and shore points and cut crossings from
  // n on. Each is computed once per edge (and level), so all faces meeting there
  // share it exactly.
  const cx = [];
  const cy = [];
  const cz = [];
  function addPoint(x, y, z) {
    cx.push(x);
    cy.push(y);
    cz.push(z);
    return n + cx.length - 1;
  }
  const px = (p) => (p < n ? X[p] : cx[p - n]);
  const py = (p) => (p < n ? Y[p] : cy[p - n]);
  const pz = (p) => (p < n ? Z[p] : cz[p - n]);

  // Where the shore crosses grid edge u-v, with the terrain's height there.
  const shores = new Map();
  function shore(u, v) {
    if (u > v) [u, v] = [v, u];
    let p = shores.get(u * n + v);
    if (p === undefined) {
      const f = shoreAt(L[u], L[v]);
      p = addPoint(X[u] + f * (X[v] - X[u]), Y[u] + f * (Y[v] - Y[u]), Z[u] + f * (Z[v] - Z[u]));
      shores.set(u * n + v, p);
    }
    return p;
  }

  // The footprint: each cell's two triangles, counter-clockwise seen from above, cut
  // at the shore to the convex polygon on land. Polygon t is points pp[ps[t]] up to
  // pp[ps[t + 1]] (exclusive), with lowest and highest point zLo[t] and zHi[t].
  const maxPolys = 2 * (nx - 1) * (ny - 1);
  const pp = new Int32Array(4 * maxPolys); // a triangle cut by a line keeps at most 4 corners
  const ps = new Int32Array(maxPolys + 1);
  let polys = 0;
  // Its outline as segments from[b] -> to[b] with the land on their left: the parts
  // of the perimeter on land, and the shore through each polygon.
  const from = [];
  const to = [];
  function addPolygon(a, b, c) {
    const start = ps[polys];
    let end = start;
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      if (onLand(u)) pp[end++] = u;
      if (onLand(u) !== onLand(v)) pp[end++] = shore(u, v);
    }
    if (end - start < 3) return; // at sea
    ps[++polys] = end;
    // The two shore points (the only points from n on so far) are neighbors, and
    // the edge between them is the shore.
    for (let m = start; m < end; m++) {
      const p = pp[m];
      const q = pp[m + 1 < end ? m + 1 : start];
      if (p >= n && q >= n) {
        from.push(p);
        to.push(q);
      }
    }
  }
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const nw = j * nx + i;
      addPolygon(nw, nw + nx, nw + nx + 1);
      addPolygon(nw, nw + nx + 1, nw + 1);
    }
  }
  // Perimeter vertices, counter-clockwise seen from above, starting south-west.
  const ring = [];
  for (let i = 0; i < nx - 1; i++) ring.push((ny - 1) * nx + i);
  for (let j = ny - 1; j > 0; j--) ring.push(j * nx + nx - 1);
  for (let i = nx - 1; i > 0; i--) ring.push(i);
  for (let j = 0; j < ny - 1; j++) ring.push(j * nx);
  for (let e = 0; e < ring.length; e++) {
    const u = ring[e];
    const v = ring[(e + 1) % ring.length];
    if (!onLand(u) && !onLand(v)) continue;
    from.push(onLand(u) ? u : shore(u, v));
    to.push(onLand(v) ? v : shore(u, v));
  }
  keepOffLevels(levels, cz); // the shore points
  const zLo = new Float64Array(polys);
  const zHi = new Float64Array(polys);
  for (let t = 0; t < polys; t++) {
    zLo[t] = Infinity;
    zHi[t] = -Infinity;
    for (let m = ps[t]; m < ps[t + 1]; m++) {
      zLo[t] = Math.min(zLo[t], pz(pp[m]));
      zHi[t] = Math.max(zHi[t], pz(pp[m]));
    }
  }

  // Edges only run between the points so far: vertices and shore points.
  const edgeEnds = n + cx.length;
  const crossings = levels.map(() => new Map());
  function crossing(u, v, k) {
    if (u > v) [u, v] = [v, u];
    let p = crossings[k].get(u * edgeEnds + v);
    if (p === undefined) {
      const f = (levels[k] - pz(u)) / (pz(v) - pz(u));
      p = addPoint(px(u) + f * (px(v) - px(u)), py(u) + f * (py(v) - py(u)), levels[k]);
      crossings[k].set(u * edgeEnds + v, p);
    }
    return p;
  }

  // Where edge u -> v crosses level k and level k + 1 (if any), in order from u.
  function edgeCrossings(u, v, k) {
    const lo = levels[k];
    const hi = levels[k + 1] ?? Infinity;
    const zu = pz(u);
    const zv = pz(v);
    const out = [];
    if (zu < zv) {
      if (zu < lo && lo < zv) out.push(crossing(u, v, k));
      if (zu < hi && hi < zv) out.push(crossing(u, v, k + 1));
    } else {
      if (zv < hi && hi < zu) out.push(crossing(u, v, k + 1));
      if (zv < lo && lo < zu) out.push(crossing(u, v, k));
    }
    return out;
  }

  const faces = levels.map((_, k) => flatFace(k));

  return levels.map((lo, k) => {
    const hi = levels[k + 1] ?? Infinity;
    const out = [];
    const add = (a, za, b, zb, c, zc) => out.push(px(a), py(a), za, px(b), py(b), zb, px(c), py(c), zc);

    // Terrain between the cuts: each polygon clipped to lo < z < hi, still convex.
    for (let t = 0; t < polys; t++) {
      if (zHi[t] < lo || zLo[t] > hi) continue; // the cut faces cover it
      const poly = [];
      for (let m = ps[t]; m < ps[t + 1]; m++) {
        const u = pp[m];
        if (pz(u) > lo && pz(u) < hi) poly.push(u);
        poly.push(...edgeCrossings(u, pp[m + 1 < ps[t + 1] ? m + 1 : ps[t]], k));
      }
      for (let m = 1; m < poly.length - 1; m++) {
        add(poly[0], pz(poly[0]), poly[m], pz(poly[m]), poly[m + 1], pz(poly[m + 1]));
      }
    }

    // Walls: along each outline segment, from lo up to the terrain, capped at hi. The
    // outline is convex, with a zero-height tip where the terrain crosses lo.
    for (let b = 0; b < from.length; b++) {
      const u = from[b];
      const v = to[b];
      const along = [...(pz(u) > lo ? [u] : []), ...edgeCrossings(u, v, k), ...(pz(v) > lo ? [v] : [])];
      if (along.length < 2) continue;
      const outline = [[along[0], lo], [along.at(-1), lo]];
      for (let m = along.length - 1; m >= 0; m--) {
        const top = Math.min(pz(along[m]), hi);
        if (top > lo) outline.push([along[m], top]);
      }
      for (let m = 1; m < outline.length - 1; m++) add(...outline[0], ...outline[m], ...outline[m + 1]);
    }

    // The flat bottom faces down, the flat top (if this band has one) faces up.
    for (const [a, b, c] of faces[k]) add(a, lo, c, lo, b, lo);
    if (k + 1 < levels.length) for (const [a, b, c] of faces[k + 1]) add(a, hi, b, hi, c, hi);
    return Float32Array.from(out);
  });

  /**
   * Triangulates the region where the terrain is above level k, as the flat face at
   * that height: point triplets, counter-clockwise seen from above.
   */
  function flatFace(k) {
    const level = levels[k];
    // Boundary of the region with the region on its left: a contour piece in each
    // polygon the level crosses, and the parts of the outline above the level.
    const next = new Map();
    for (let t = 0; t < polys; t++) {
      if (zHi[t] < level || zLo[t] > level) continue;
      let exit = -1;
      let entry = -1;
      for (let m = ps[t]; m < ps[t + 1]; m++) {
        const u = pp[m];
        const v = pp[m + 1 < ps[t + 1] ? m + 1 : ps[t]];
        if (pz(u) > level && pz(v) < level) exit = crossing(u, v, k);
        else if (pz(u) < level && pz(v) > level) entry = crossing(u, v, k);
      }
      if (exit >= 0) next.set(exit, entry);
    }
    for (let b = 0; b < from.length; b++) {
      const u = from[b];
      const v = to[b];
      if (pz(u) > level && pz(v) > level) next.set(u, v);
      else if (pz(u) > level) next.set(u, crossing(u, v, k));
      else if (pz(v) > level) next.set(crossing(u, v, k), v);
    }

    // Chain the boundary into rings: counter-clockwise outlines and clockwise holes.
    const outlines = [];
    const holes = [];
    const seen = new Set();
    for (const start of next.keys()) {
      if (seen.has(start)) continue;
      const points = [];
      for (let p = start; !seen.has(p); p = next.get(p)) {
        if (p === undefined) throw new Error('Open contour in the model');
        seen.add(p);
        points.push(p);
      }
      const area = ringArea(points);
      (area > 0 ? outlines : holes).push({ points, area: Math.abs(area), holes: [] });
    }
    // Each hole belongs to the smallest outline around it (islands nest in holes).
    for (const hole of holes) {
      const x = px(hole.points[0]);
      const y = py(hole.points[0]);
      let owner = null;
      for (const r of outlines) {
        if ((!owner || r.area < owner.area) && insideRing(x, y, r.points)) owner = r;
      }
      owner?.holes.push(hole);
    }

    const face = [];
    for (const outline of outlines) {
      const rings = [outline.points, ...outline.holes.map((h) => h.points)];
      const ids = rings.flat();
      const coords = ids.flatMap((p) => [px(p), py(p)]);
      const starts = [];
      for (let r = 0, s = 0; r < rings.length; s += rings[r++].length) starts.push(s);
      const succ = new Int32Array(ids.length); // the next point on the same ring
      rings.forEach((points, r) => points.forEach((_, i) => (succ[starts[r] + i] = starts[r] + ((i + 1) % points.length))));

      const triangles = earcut(coords, starts.slice(1));
      // Earcut's triangles all wind the same way; make them counter-clockwise.
      let area = 0;
      for (let t = 0; t < triangles.length; t += 3) area += cross(coords, triangles[t], triangles[t + 1], triangles[t + 2]);
      if (area < 0) {
        for (let t = 0; t < triangles.length; t += 3) [triangles[t + 1], triangles[t + 2]] = [triangles[t + 2], triangles[t + 1]];
      }

      // Earcut drops boundary points on straight stretches, such as those along the
      // perimeter, but the walls and the terrain next to the face use them. So a
      // triangle edge with no triangle on its other side, which lies on the boundary,
      // must be a ring edge, or else is split at the points it passes. They are found
      // by position: earcut may drop a point where it bridges a hole to the outline,
      // and then the point is on another ring than the edge's ends.
      const edges = new Set();
      for (let t = 0; t < triangles.length; t += 3) {
        for (let e = 0; e < 3; e++) edges.add(triangles[t + e] * ids.length + triangles[t + ((e + 1) % 3)]);
      }
      const skippedOn = (p, q) => {
        if (succ[p] === q || edges.has(q * ids.length + p)) return [];
        const ex = coords[2 * q] - coords[2 * p];
        const ey = coords[2 * q + 1] - coords[2 * p + 1];
        const len2 = ex * ex + ey * ey;
        const on = [];
        for (let m = 0; m < ids.length; m++) {
          const mx = coords[2 * m] - coords[2 * p];
          const my = coords[2 * m + 1] - coords[2 * p + 1];
          const t = (mx * ex + my * ey) / len2;
          if (t > 0 && t < 1 && Math.abs(mx * ey - my * ex) <= ON_EDGE * len2) on.push([t, m]);
        }
        return on.sort((a, b) => a[0] - b[0]).map(([, m]) => m);
      };
      // Triangle a, b, c with the points skipped on each edge: a fan from the corner
      // opposite an edge with skipped points, and the same for the other edges.
      const emit = (a, b, c, ab, bc, ca) => {
        if (!ab.length) {
          if (bc.length) emit(b, c, a, bc, ca, ab);
          else if (ca.length) emit(c, a, b, ca, ab, bc);
          else face.push([ids[a], ids[b], ids[c]]);
          return;
        }
        const along = [a, ...ab, b];
        for (let s = 0; s + 1 < along.length; s++) {
          emit(along[s], along[s + 1], c, [], s + 2 === along.length ? bc : [], s ? [] : ca);
        }
      };
      for (let t = 0; t < triangles.length; t += 3) {
        const [a, b, c] = triangles.slice(t, t + 3);
        emit(a, b, c, skippedOn(a, b), skippedOn(b, c), skippedOn(c, a));
      }
    }
    return face;
  }

  function ringArea(points) {
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const q = points[(i + 1) % points.length];
      sum += px(p) * py(q) - px(q) * py(p);
    }
    return sum / 2;
  }

  function insideRing(x, y, points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const xi = px(points[i]), yi = py(points[i]);
      const xj = px(points[j]), yj = py(points[j]);
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
}

/** Twice the signed area of the 2D triangle a, b, c (indices into flat x, y coords). */
function cross(coords, a, b, c) {
  const ax = coords[2 * a];
  const ay = coords[2 * a + 1];
  return (coords[2 * b] - ax) * (coords[2 * c + 1] - ay) - (coords[2 * b + 1] - ay) * (coords[2 * c] - ax);
}

/**
 * Spaces the cuts at least 3 × LEVEL_GAP apart, so keepOffLevels() can move a vertex
 * off one cut without moving it onto the next.
 * @param {number[]} levels ascending cut heights
 * @returns {number[]} the spaced cut heights
 */
function spaceLevels(levels) {
  const out = [];
  for (const level of levels) out.push(out.length ? Math.max(level, out.at(-1) + 3 * LEVEL_GAP) : level);
  return out;
}

/**
 * Keeps vertices off the cuts: moves any vertex height closer than LEVEL_GAP to a cut
 * out to that distance. Then every crossing point is distinct from the vertices around
 * it. (Moving the cuts instead doesn't work: a fine grid has thousands of vertex
 * heights per mm.)
 * @param {number[]} levels cut heights, from spaceLevels()
 * @param {Float64Array | number[]} Z vertex heights, changed in place
 */
function keepOffLevels(levels, Z) {
  for (let v = 0; v < Z.length; v++) {
    for (const l of levels) {
      if (Math.abs(Z[v] - l) < LEVEL_GAP) Z[v] = Z[v] < l ? l - LEVEL_GAP : l + LEVEL_GAP;
    }
  }
}

/**
 * Writes triangles as one binary STL, with normals from the vertex order.
 * @param {Float32Array[]} meshes triangles as x, y, z of three vertices each
 * @param {string} header STL header text, at most 80 ASCII characters
 * @returns {ArrayBuffer}
 */
export function writeStl(meshes, header) {
  const count = meshes.reduce((sum, m) => sum + m.length / 9, 0);
  const buffer = new ArrayBuffer(84 + 50 * count);
  const view = new DataView(buffer);
  for (let k = 0; k < Math.min(header.length, 80); k++) view.setUint8(k, header.charCodeAt(k) & 0x7f);
  view.setUint32(80, count, true);
  let offset = 84;
  const write = (x, y, z) => {
    view.setFloat32(offset, x, true);
    view.setFloat32(offset + 4, y, true);
    view.setFloat32(offset + 8, z, true);
    offset += 12;
  };
  for (const m of meshes) {
    for (let t = 0; t < m.length; t += 9) {
      const ux = m[t + 3] - m[t], uy = m[t + 4] - m[t + 1], uz = m[t + 5] - m[t + 2];
      const vx = m[t + 6] - m[t], vy = m[t + 7] - m[t + 1], vz = m[t + 8] - m[t + 2];
      const n0 = uy * vz - uz * vy, n1 = uz * vx - ux * vz, n2 = ux * vy - uy * vx;
      const len = Math.hypot(n0, n1, n2) || 1;
      write(n0 / len, n1 / len, n2 / len);
      for (let i = 0; i < 9; i += 3) write(m[t + i], m[t + i + 1], m[t + i + 2]);
      offset += 2; // attribute byte count, left 0
    }
  }
  return buffer;
}
