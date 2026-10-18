// The sea for the 3D print export: the water polygons of the chosen classes (the
// ocean), read straight from OpenMapTiles vector tiles, and turned into a value per
// print grid vertex that says which side of the shore it is on and how far away.

import { clipSegment, loadTiles, lowerDistances } from './vector-tiles.js';

// Distances to the shore are measured up to this many grid cells. Only the vertices
// next to the shore need them, to place it between the vertices.
export const SHORE_REACH = 2;

/**
 * Loads the sea polygons in the vector tiles covering `bounds`, extended by `pad`.
 * @param {object} source
 * @param {string} source.tileJson TileJSON URL of an OpenMapTiles vector tile source
 * @param {string} source.layer the source layer with the water polygons
 * @param {string[]} source.classes `class` values that count as sea
 * @param {{x0: number, y0: number, x1: number, y1: number}} bounds world units
 * @param {number} zoom preferred tile zoom, capped at the source's maxzoom
 * @param {number} pad world units
 * @returns {Promise<{square: number[], polygons: Float64Array[][]}[]>} per tile, its
 *   square [x0, y0, x1, y1] and its sea polygons as rings of x, y world coordinates
 */
export async function loadSea({ tileJson, layer, classes }, bounds, zoom, pad) {
  // A tile that didn't load can't tell land from sea, so the whole coastline fails.
  const tiles = await loadTiles({
    tileJson,
    layer,
    filter: (feature) => feature.type === 3 && classes.includes(feature.properties.class),
    bounds,
    zoom,
    pad,
  });
  return tiles.map(({ square, features }) => ({ square, polygons: features }));
}

/**
 * The signed distance from each grid vertex to the shore, in grid cells: positive on
 * land, negative at sea, and ±SHORE_REACH further away. The grid spans `bounds` with
 * nx × ny vertices, row by row from the north edge, like sampleGrid().
 * @param {{square: number[], polygons: Float64Array[][]}[]} tiles from loadSea()
 * @returns {{land: Float32Array, seaShare: number} | null} null if no vertex is at sea
 */
export function landField(tiles, bounds, nx, ny) {
  // Grid coordinates: i from 0 to nx - 1 west to east, j from 0 to ny - 1 north to south.
  const sx = (nx - 1) / (bounds.x1 - bounds.x0);
  const sy = (ny - 1) / (bounds.y1 - bounds.y0);
  const sea = new Uint8Array(nx * ny);
  const dist = new Float32Array(nx * ny).fill(SHORE_REACH);

  for (const { square, polygons } of tiles) {
    // A tile's polygons reach into its buffer, past its square, and are cut off
    // there. So each tile only decides about the vertices in its own square
    // (half-open, so every vertex is in exactly one), and only the shore inside its
    // square counts, leaving out the cut-off edges.
    const gx0 = (square[0] - bounds.x0) * sx;
    const gy0 = (square[1] - bounds.y0) * sy;
    const gx1 = (square[2] - bounds.x0) * sx;
    const gy1 = (square[3] - bounds.y0) * sy;
    const i0 = Math.max(Math.ceil(gx0), 0);
    const i1 = Math.min(Math.ceil(gx1), nx);
    const j0 = Math.max(Math.ceil(gy0), 0);
    const j1 = Math.min(Math.ceil(gy1), ny);

    for (const polygon of polygons) {
      const rings = polygon.map((ring) => ring.map((w, k) => (k % 2 ? (w - bounds.y0) * sy : (w - bounds.x0) * sx)));

      // Mark the vertices inside the polygon, row by row (even-odd, so holes work).
      const rows = Array.from({ length: Math.max(j1 - j0, 0) }, () => []);
      for (const ring of rings) {
        forEachEdge(ring, (ax, ay, bx, by) => {
          // Rows y with min(ay, by) <= y < max(ay, by), so a vertex counts once.
          const lo = Math.max(Math.ceil(Math.min(ay, by)), j0);
          const hi = Math.min(Math.ceil(Math.max(ay, by)), j1);
          for (let j = lo; j < hi; j++) rows[j - j0].push(ax + ((j - ay) * (bx - ax)) / (by - ay));
        });
      }
      rows.forEach((xs, r) => {
        xs.sort((a, b) => a - b);
        const row = (j0 + r) * nx;
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const end = Math.min(Math.ceil(xs[k + 1]), i1);
          for (let i = Math.max(Math.ceil(xs[k]), i0); i < end; i++) sea[row + i] = 1;
        }
      });

      // Distances to the shore, for the vertices near it.
      for (const ring of rings) {
        forEachEdge(ring, (ax, ay, bx, by) => {
          const seg = clipSegment(ax, ay, bx, by, gx0, gy0, gx1, gy1);
          if (seg) lowerDistances(dist, nx, ny, SHORE_REACH, ...seg);
        });
      }
    }
  }

  let seaCount = 0;
  const land = new Float32Array(nx * ny);
  for (let v = 0; v < land.length; v++) {
    seaCount += sea[v];
    land[v] = sea[v] ? -dist[v] : dist[v];
  }
  return seaCount ? { land, seaShare: seaCount / land.length } : null;
}

/** Calls fn(ax, ay, bx, by) for each edge of a ring of x, y pairs, closed or not. */
function forEachEdge(ring, fn) {
  for (let k = 0; k < ring.length; k += 2) {
    const next = (k + 2) % ring.length;
    fn(ring[k], ring[k + 1], ring[next], ring[next + 1]);
  }
}
