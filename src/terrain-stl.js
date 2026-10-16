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

/**
 * Builds the model as closed solids stacked between horizontal cuts, so a slicer can
 * load them as parts of one object and print each in its own filament. Band k holds
 * the model between heights levels[k] and levels[k + 1] (the last band has no top),
 * with the terrain on top, the side walls, and flat faces at its cuts. Neighboring
 * bands share their cut faces exactly and never overlap.
 * @param {object} options
 * @param {Float32Array} options.grid elevations in meters, row by row from the north edge
 * @param {number} options.nx samples per row
 * @param {number} options.ny rows
 * @param {number} options.width model width in mm (west to east)
 * @param {number} options.depth model depth in mm (north to south)
 * @param {(ele: number) => number} options.toZ model height in mm for an elevation
 * @param {number[]} options.levels ascending cut heights in mm, starting with 0 (the bed)
 * @returns {Float32Array[]} per band, its triangles as x, y, z of three vertices each,
 *   counter-clockwise seen from outside
 */
export function buildBands({ grid, nx, ny, width, depth, toZ, levels }) {
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
  levels = separateLevels(levels, Z);

  // Each cell is two triangles, counter-clockwise seen from above.
  const tris = new Int32Array(6 * (nx - 1) * (ny - 1));
  for (let j = 0, t = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++, t += 6) {
      const nw = j * nx + i;
      tris.set([nw, nw + nx, nw + nx + 1, nw, nw + nx + 1, nw + 1], t);
    }
  }
  // Perimeter vertices, counter-clockwise seen from above, starting south-west.
  const ring = [];
  for (let i = 0; i < nx - 1; i++) ring.push((ny - 1) * nx + i);
  for (let j = ny - 1; j > 0; j--) ring.push(j * nx + nx - 1);
  for (let i = nx - 1; i > 0; i--) ring.push(i);
  for (let j = 0; j < ny - 1; j++) ring.push(j * nx);

  // Points are grid vertex indices below n, and cut crossings from n on. A crossing is
  // computed once per grid edge and level, so all faces meeting there share it exactly.
  const cx = [];
  const cy = [];
  const cz = [];
  const crossings = levels.map(() => new Map());
  function crossing(u, v, k) {
    if (u > v) [u, v] = [v, u];
    let p = crossings[k].get(u * n + v);
    if (p === undefined) {
      const f = (levels[k] - Z[u]) / (Z[v] - Z[u]);
      p = n + cx.length;
      cx.push(X[u] + f * (X[v] - X[u]));
      cy.push(Y[u] + f * (Y[v] - Y[u]));
      cz.push(levels[k]);
      crossings[k].set(u * n + v, p);
    }
    return p;
  }
  const px = (p) => (p < n ? X[p] : cx[p - n]);
  const py = (p) => (p < n ? Y[p] : cy[p - n]);
  const pz = (p) => (p < n ? Z[p] : cz[p - n]);

  // Where edge u -> v crosses level k and level k + 1 (if any), in order from u.
  function edgeCrossings(u, v, k) {
    const lo = levels[k];
    const hi = levels[k + 1] ?? Infinity;
    const out = [];
    if (Z[u] < Z[v]) {
      if (Z[u] < lo && lo < Z[v]) out.push(crossing(u, v, k));
      if (Z[u] < hi && hi < Z[v]) out.push(crossing(u, v, k + 1));
    } else {
      if (Z[v] < hi && hi < Z[u]) out.push(crossing(u, v, k + 1));
      if (Z[v] < lo && lo < Z[u]) out.push(crossing(u, v, k));
    }
    return out;
  }

  const faces = levels.map((_, k) => flatFace(k));

  return levels.map((lo, k) => {
    const hi = levels[k + 1] ?? Infinity;
    const out = [];
    const add = (a, za, b, zb, c, zc) => out.push(px(a), py(a), za, px(b), py(b), zb, px(c), py(c), zc);

    // Terrain between the cuts: each triangle clipped to lo < z < hi, a convex polygon.
    for (let t = 0; t < tris.length; t += 3) {
      const z0 = Z[tris[t]], z1 = Z[tris[t + 1]], z2 = Z[tris[t + 2]];
      if (Math.max(z0, z1, z2) < lo || Math.min(z0, z1, z2) > hi) continue; // the cut faces cover it
      const poly = [];
      for (let e = 0; e < 3; e++) {
        const u = tris[t + e];
        if (Z[u] > lo && Z[u] < hi) poly.push(u);
        poly.push(...edgeCrossings(u, tris[t + ((e + 1) % 3)], k));
      }
      for (let m = 1; m < poly.length - 1; m++) {
        add(poly[0], pz(poly[0]), poly[m], pz(poly[m]), poly[m + 1], pz(poly[m + 1]));
      }
    }

    // Walls: along each perimeter edge, from lo up to the terrain, capped at hi. The
    // outline is convex, with a zero-height tip where the terrain crosses lo.
    for (let e = 0; e < ring.length; e++) {
      const u = ring[e];
      const v = ring[(e + 1) % ring.length];
      const along = [...(Z[u] > lo ? [u] : []), ...edgeCrossings(u, v, k), ...(Z[v] > lo ? [v] : [])];
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
    // triangle the level crosses, and the parts of the perimeter above the level.
    const next = new Map();
    for (let t = 0; t < tris.length; t += 3) {
      let exit = -1;
      let entry = -1;
      for (let e = 0; e < 3; e++) {
        const u = tris[t + e];
        const v = tris[t + ((e + 1) % 3)];
        if (Z[u] > level && Z[v] < level) exit = crossing(u, v, k);
        else if (Z[u] < level && Z[v] > level) entry = crossing(u, v, k);
      }
      if (exit >= 0) next.set(exit, entry);
    }
    for (let e = 0; e < ring.length; e++) {
      const u = ring[e];
      const v = ring[(e + 1) % ring.length];
      if (Z[u] > level && Z[v] > level) next.set(u, v);
      else if (Z[u] > level) next.set(u, crossing(u, v, k));
      else if (Z[v] > level) next.set(crossing(u, v, k), v);
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
      const where = rings.flatMap((points, r) => points.map((_, i) => [r, i]));

      // Earcut drops collinear boundary points, such as those along the perimeter,
      // but the walls and the terrain next to the face use them. Split each triangle
      // at the points it skipped, so every edge is shared by exactly two triangles.
      const skippedOn = (i, j) => {
        const [r, a] = where[i];
        const [rj, b] = where[j];
        if (r !== rj) return [];
        const len = rings[r].length;
        for (const [from, steps, reverse] of [[a, (b - a + len) % len, false], [b, (a - b + len) % len, true]]) {
          const skipped = [];
          for (let s = 1; s < steps; s++) {
            const m = starts[r] + ((from + s) % len);
            if (cross(coords, i, m, j) !== 0) break; // a diagonal, not a boundary edge
            skipped.push(m);
          }
          if (steps > 1 && skipped.length === steps - 1) return reverse ? skipped.reverse() : skipped;
        }
        return [];
      };
      const emit = (a, b, c) => {
        for (const [p, q, o] of [[a, b, c], [b, c, a], [c, a, b]]) {
          const skipped = skippedOn(p, q);
          if (skipped.length) {
            let prev = p;
            for (const m of [...skipped, q]) {
              emit(prev, m, o);
              prev = m;
            }
            return;
          }
        }
        face.push([ids[a], ids[b], ids[c]]);
      };
      const triangles = earcut(coords, starts.slice(1));
      for (let t = 0; t < triangles.length; t += 3) {
        const [a, b, c] = triangles.slice(t, t + 3);
        if (cross(coords, a, b, c) > 0) emit(a, b, c);
        else emit(a, c, b);
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
 * Keeps vertices off the cuts: spaces the cuts at least 3 × LEVEL_GAP apart, then
 * moves any vertex height closer than LEVEL_GAP to a cut out to that distance. Then
 * every crossing point is distinct from the vertices around it. (Moving the cuts
 * instead doesn't work: a fine grid has thousands of vertex heights per mm.)
 * @param {number[]} levels cut heights
 * @param {Float64Array} Z vertex heights, changed in place
 * @returns {number[]} the spaced cut heights
 */
function separateLevels(levels, Z) {
  const out = [];
  for (const level of levels) out.push(out.length ? Math.max(level, out.at(-1) + 3 * LEVEL_GAP) : level);
  for (let v = 0; v < Z.length; v++) {
    for (const l of out) {
      if (Math.abs(Z[v] - l) < LEVEL_GAP) Z[v] = Z[v] < l ? l - LEVEL_GAP : l + LEVEL_GAP;
    }
  }
  return out;
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
