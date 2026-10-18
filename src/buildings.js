// Buildings from the GlobalBuildingAtlas: footprints with heights, read in a worker
// (buildings-worker.js) straight from its GeoParquet files. The map gets them as
// vector tiles through a custom protocol, and the 3D print raises them on the terrain
// like the ski lift ridges, so the model stays one closed surface.

const PROTOCOL = 'gba';
// The print reads every row group under its area, about 1 MB and 16000 buildings each,
// so the area is capped.
const MAX_PRINT_GROUPS = 32;

/**
 * @param {object} options
 * @param {string} options.url folder with the GeoParquet files, one per 5° cell
 * @param {number} options.minHeight meters; lower buildings are raised to it
 */
export function createBuildingSource({ url, minHeight }) {
  let worker = null; // started on the first request
  const pending = new Map(); // request id -> { resolve, reject }
  let nextId = 0;

  function request(message) {
    if (!worker) {
      worker = new Worker(new URL('./buildings-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data: { id, error, tooLarge, ...result } }) => {
        const { resolve, reject } = pending.get(id);
        pending.delete(id);
        if (error === undefined) resolve(result);
        else reject(tooLarge ? new RangeError(error) : new Error(error));
      };
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, base: url, minHeight, ...message });
    });
  }

  return {
    /** Vector tiles with a `buildings` layer of polygons that have a `height` in meters. */
    tileUrl: `${PROTOCOL}://{z}/{x}/{y}`,
    setupMaplibre(maplibregl) {
      maplibregl.addProtocol(PROTOCOL, async ({ url: tileUrl }) => {
        const [z, x, y] = tileUrl.slice(PROTOCOL.length + 3).split('/').map(Number);
        const { buffer } = await request({ type: 'tile', z, x, y });
        return { data: buffer };
      });
    },
    /**
     * Loads the buildings that meet `bounds`, extended by `pad`.
     * @param {{x0: number, y0: number, x1: number, y1: number}} bounds world units
     * @param {number} pad world units
     * @returns {Promise<Buildings>} building b has rings ringStarts[b] up to
     *   ringStarts[b + 1] (exclusive), the first its outline and any others its holes;
     *   ring r has points pointStarts[r] up to pointStarts[r + 1], as x, y world
     *   coordinates in xy; heights[b] is its height in meters
     * @throws {RangeError} if the area has too many buildings
     */
    async load({ x0, y0, x1, y1 }, pad) {
      const bounds = { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
      return (await request({ type: 'area', bounds, maxGroups: MAX_PRINT_GROUPS })).buildings;
    },
  };
}

/**
 * How much the buildings raise each grid vertex, in meters: up to a flat roof at the
 * building's height above the lowest ground under it, from half a grid cell inside
 * its outline on. The raise falls to 0 at half a cell outside, so the walls slope
 * over one cell and run between the vertices rather than along them, like the ski
 * lift ridges. Where buildings meet, the higher one wins. The grid spans `bounds` with
 * nx × ny vertices, row by row from the north edge, like sampleGrid().
 * @param {Buildings} buildings from load()
 * @param {Float32Array} grid elevations in meters
 * @returns {{raise: Float32Array, count: number, highest: number, top: number} | null}
 *   the raise per vertex, how many buildings raise a vertex, the largest raise, and the
 *   highest roof's elevation, in meters; null if no building reaches a vertex
 */
export function buildingField({ heights, ringStarts, pointStarts, xy }, grid, bounds, nx, ny) {
  // Grid coordinates: i from 0 to nx - 1 west to east, j from 0 to ny - 1 north to south.
  const sx = (nx - 1) / (bounds.x1 - bounds.x0);
  const sy = (ny - 1) / (bounds.y1 - bounds.y0);
  const raise = new Float32Array(nx * ny);
  let count = 0;
  let highest = 0;
  let top = -Infinity;
  for (let b = 0; b < heights.length; b++) {
    const first = pointStarts[ringStarts[b]];
    const end = pointStarts[ringStarts[b + 1]];
    const gx = new Float64Array(end - first);
    const gy = new Float64Array(end - first);
    for (let p = first; p < end; p++) {
      gx[p - first] = (xy[2 * p] - bounds.x0) * sx;
      gy[p - first] = (xy[2 * p + 1] - bounds.y0) * sy;
    }
    // The vertices within half a cell of the footprint.
    let i0 = Infinity;
    let j0 = Infinity;
    let i1 = -Infinity;
    let j1 = -Infinity;
    for (let p = 0; p < gx.length; p++) {
      i0 = Math.min(i0, gx[p]);
      j0 = Math.min(j0, gy[p]);
      i1 = Math.max(i1, gx[p]);
      j1 = Math.max(j1, gy[p]);
    }
    i0 = Math.max(Math.ceil(i0 - 0.5), 0);
    j0 = Math.max(Math.ceil(j0 - 0.5), 0);
    i1 = Math.min(Math.floor(i1 + 0.5), nx - 1);
    j1 = Math.min(Math.floor(j1 + 0.5), ny - 1);
    if (i0 > i1 || j0 > j1) continue;

    // Rings as start and end in gx, gy.
    const rings = [];
    for (let r = ringStarts[b]; r < ringStarts[b + 1]; r++) rings.push([pointStarts[r] - first, pointStarts[r + 1] - first]);
    // The ground is the lowest terrain under the footprint: at its corners, and at the
    // vertices inside.
    let ground = Infinity;
    for (let p = 0; p < gx.length; p++) ground = Math.min(ground, gridAt(grid, nx, ny, gx[p], gy[p]));
    const reached = [];
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const { inside, distance } = locate(i, j, gx, gy, rings);
        const share = inside ? Math.min(0.5 + distance, 1) : 0.5 - distance;
        if (share <= 0) continue;
        reached.push(j * nx + i, share);
        if (inside) ground = Math.min(ground, grid[j * nx + i]);
      }
    }
    const roof = ground + heights[b];
    let raised = false;
    for (let k = 0; k < reached.length; k += 2) {
      const v = reached[k];
      const r = reached[k + 1] * (roof - grid[v]);
      if (r > raise[v]) {
        raise[v] = r;
        raised = true;
        highest = Math.max(highest, r);
        top = Math.max(top, grid[v] + r);
      }
    }
    if (raised) count++;
  }
  return count ? { raise, count, highest, top } : null;
}

/** Whether grid point x, y is inside the rings (even-odd), and its distance from them. */
function locate(x, y, gx, gy, rings) {
  let inside = false;
  let d2 = Infinity;
  for (const [start, end] of rings) {
    for (let p = start, q = end - 1; p < end; q = p++) {
      const ax = gx[q];
      const ay = gy[q];
      const bx = gx[p];
      const by = gy[p];
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.min(Math.max(((x - ax) * dx + (y - ay) * dy) / len2, 0), 1) : 0;
      d2 = Math.min(d2, (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2);
    }
  }
  return { inside, distance: Math.sqrt(d2) };
}

/** The grid's elevation at grid point x, y, interpolated bilinearly; clamped to the grid. */
function gridAt(grid, nx, ny, x, y) {
  x = Math.min(Math.max(x, 0), nx - 1);
  y = Math.min(Math.max(y, 0), ny - 1);
  const i = Math.min(Math.floor(x), nx - 2);
  const j = Math.min(Math.floor(y), ny - 2);
  const fx = x - i;
  const fy = y - j;
  const v = j * nx + i;
  const north = grid[v] * (1 - fx) + grid[v + 1] * fx;
  const south = grid[v + nx] * (1 - fx) + grid[v + nx + 1] * fx;
  return north * (1 - fy) + south * fy;
}

/**
 * @typedef {object} Buildings
 * @property {Float32Array} heights
 * @property {Uint32Array} ringStarts
 * @property {Uint32Array} pointStarts
 * @property {Float64Array} xy
 */
