// The sea for the 3D print export: the water polygons of the chosen classes (the
// ocean), read straight from OpenMapTiles vector tiles, and turned into a value per
// print grid vertex that says which side of the shore it is on and how far away.

import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';

// Distances to the shore are measured up to this many grid cells. Only the vertices
// next to the shore need them, to place it between the vertices.
export const SHORE_REACH = 2;

const tileJsons = new Map(); // TileJSON URL -> its request

function tileJsonOf(url) {
  if (!tileJsons.has(url)) {
    const request = fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`TileJSON: HTTP ${response.status}`);
        return response.json();
      })
      .catch((err) => {
        tileJsons.delete(url); // try again next time
        throw err;
      });
    tileJsons.set(url, request);
  }
  return tileJsons.get(url);
}

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
  const { tiles: [template], maxzoom = 14 } = await tileJsonOf(tileJson);
  const z = Math.min(Math.max(Math.round(zoom), 0), maxzoom);
  const n = 2 ** z;
  const tileOf = (w) => Math.min(Math.max(Math.floor(w * n), 0), n - 1);
  const requests = [];
  for (let y = tileOf(bounds.y0 - pad); y <= tileOf(bounds.y1 + pad); y++) {
    for (let x = tileOf(bounds.x0 - pad); x <= tileOf(bounds.x1 + pad); x++) {
      requests.push(loadTile(template, z, x, y, layer, classes));
    }
  }
  return Promise.all(requests);
}

async function loadTile(template, z, x, y, layerName, classes) {
  const url = template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  const response = await fetch(url);
  // A tile that didn't load can't tell land from sea, so the whole coastline fails.
  if (!response.ok) throw new Error(`Coastline tile ${z}/${x}/${y}: HTTP ${response.status}`);
  const layer = new VectorTile(new PbfReader(new Uint8Array(await response.arrayBuffer()))).layers[layerName];
  const n = 2 ** z;
  const polygons = [];
  for (let f = 0; f < (layer?.length ?? 0); f++) {
    const feature = layer.feature(f);
    if (feature.type !== 3 || !classes.includes(feature.properties.class)) continue;
    const toWorld = (p) => [(x + p.x / layer.extent) / n, (y + p.y / layer.extent) / n];
    polygons.push(feature.loadGeometry().map((ring) => Float64Array.from(ring.flatMap(toWorld))));
  }
  return { square: [x / n, y / n, (x + 1) / n, (y + 1) / n], polygons };
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
          if (seg) measure(...seg);
        });
      }
    }
  }

  // Lowers dist[] around segment a-b, in pieces of at most one cell, so only
  // vertices near the segment are visited.
  function measure(ax, ay, bx, by) {
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
    for (let s = 0; s < steps; s++) {
      const x0 = ax + ((bx - ax) * s) / steps;
      const y0 = ay + ((by - ay) * s) / steps;
      const x1 = ax + ((bx - ax) * (s + 1)) / steps;
      const y1 = ay + ((by - ay) * (s + 1)) / steps;
      const iEnd = Math.min(Math.floor(Math.max(x0, x1) + SHORE_REACH), nx - 1);
      const jEnd = Math.min(Math.floor(Math.max(y0, y1) + SHORE_REACH), ny - 1);
      for (let j = Math.max(Math.ceil(Math.min(y0, y1) - SHORE_REACH), 0); j <= jEnd; j++) {
        for (let i = Math.max(Math.ceil(Math.min(x0, x1) - SHORE_REACH), 0); i <= iEnd; i++) {
          const d = segmentDistance(i, j, ax, ay, bx, by);
          if (d < dist[j * nx + i]) dist[j * nx + i] = d;
        }
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

/** Segment a-b clipped to the rectangle x0..x1 × y0..y1 (Liang-Barsky), or null. */
function clipSegment(ax, ay, bx, by, x0, y0, x1, y1) {
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]]) {
    if (p === 0) {
      if (q < 0) return null;
    } else if (p < 0) {
      t0 = Math.max(t0, q / p);
    } else {
      t1 = Math.min(t1, q / p);
    }
  }
  return t0 <= t1 ? [ax + t0 * dx, ay + t0 * dy, ax + t1 * dx, ay + t1 * dy] : null;
}

function segmentDistance(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.min(Math.max(((x - ax) * dx + (y - ay) * dy) / len2, 0), 1) : 0;
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}
