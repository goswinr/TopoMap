// Turns a rectangle of DEM data into a printable solid and writes it as binary STL.
//
// The rectangle is axis-aligned in Web Mercator ([0, 1] world units, y down), so
// the model's top edge points north. It is scaled to true size at its center
// latitude; the Mercator stretch across a few km is far below print precision.

const EARTH_CIRCUMFERENCE = 40075016.686; // meters, at the equator
// Mapterhorn covers the whole globe up to this zoom, and higher zooms only where
// high-resolution data exists (missing tiles there are 404s).
const GLOBAL_DEM_MAXZOOM = 12;
const MAX_DEM_ZOOM = 17;

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
 * Builds a closed solid from the grid: the terrain on top, four side walls and a
 * flat bottom at z = 0, as binary STL in millimeters.
 * @param {object} options
 * @param {Float32Array} options.grid elevations in meters, row by row from the north edge
 * @param {number} options.nx samples per row
 * @param {number} options.ny rows
 * @param {number} options.width model width in mm (west to east)
 * @param {number} options.depth model depth in mm (north to south)
 * @param {(ele: number) => number} options.toZ model height in mm for an elevation
 * @param {string} options.header STL header text, at most 80 ASCII characters
 * @returns {ArrayBuffer}
 */
export function buildStl({ grid, nx, ny, width, depth, toZ, header }) {
  const dx = width / (nx - 1);
  const dy = depth / (ny - 1);
  // Model y points north, grid rows run from north to south.
  const top = (i, j) => [i * dx, (ny - 1 - j) * dy, toZ(grid[j * nx + i])];

  // Perimeter grid points, counter-clockwise seen from above, starting south-west.
  const ring = [];
  for (let i = 0; i < nx - 1; i++) ring.push([i, ny - 1]);
  for (let j = ny - 1; j > 0; j--) ring.push([nx - 1, j]);
  for (let i = nx - 1; i > 0; i--) ring.push([i, 0]);
  for (let j = 0; j < ny - 1; j++) ring.push([0, j]);

  const count = 2 * (nx - 1) * (ny - 1) + 3 * ring.length;
  const buffer = new ArrayBuffer(84 + 50 * count);
  const view = new DataView(buffer);
  for (let k = 0; k < Math.min(header.length, 80); k++) view.setUint8(k, header.charCodeAt(k) & 0x7f);
  view.setUint32(80, count, true);

  let offset = 84;
  function write(x, y, z) {
    view.setFloat32(offset, x, true);
    view.setFloat32(offset + 4, y, true);
    view.setFloat32(offset + 8, z, true);
    offset += 12;
  }
  // Vertices counter-clockwise seen from outside, as STL expects.
  function triangle(a, b, c) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const n0 = uy * vz - uz * vy, n1 = uz * vx - ux * vz, n2 = ux * vy - uy * vx;
    const len = Math.hypot(n0, n1, n2) || 1;
    write(n0 / len, n1 / len, n2 / len);
    write(a[0], a[1], a[2]);
    write(b[0], b[1], b[2]);
    write(c[0], c[1], c[2]);
    offset += 2; // attribute byte count, left 0
  }

  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const nw = top(i, j), ne = top(i + 1, j), sw = top(i, j + 1), se = top(i + 1, j + 1);
      triangle(nw, sw, se);
      triangle(nw, se, ne);
    }
  }
  // Walls between each perimeter edge and the bed, and the bottom as a fan
  // around its center, so every edge is shared by exactly two triangles.
  const center = [width / 2, depth / 2, 0];
  for (let k = 0; k < ring.length; k++) {
    const p = top(...ring[k]);
    const q = top(...ring[(k + 1) % ring.length]);
    const pBed = [p[0], p[1], 0];
    const qBed = [q[0], q[1], 0];
    triangle(pBed, qBed, q);
    triangle(pBed, q, p);
    triangle(center, qBed, pBed);
  }
  return buffer;
}
