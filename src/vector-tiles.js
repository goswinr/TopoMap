// Vector tiles under the 3D print area, read straight from their source rather than
// from the map, so they don't depend on the view: the sea (coast.js) and the ski lifts
// (lifts.js). Also the print grid's distances to their lines, which both need.

import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';

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
 * Loads the features of one layer in the vector tiles covering `bounds`, extended by `pad`.
 * @param {object} options
 * @param {string} options.tileJson TileJSON URL of the vector tile source
 * @param {string} options.layer the source layer to read
 * @param {(feature: import('@mapbox/vector-tile').VectorTileFeature) => boolean} options.filter
 *   which features to keep
 * @param {{x0: number, y0: number, x1: number, y1: number}} options.bounds world units
 * @param {number} options.zoom preferred tile zoom
 * @param {number} [options.minzoom] lowest zoom with the data needed; the source's
 *   maxzoom caps both
 * @param {number} [options.pad] world units
 * @param {number} [options.maxTiles] more tiles than this throw a RangeError
 * @returns {Promise<{square: number[], features: Float64Array[][]}[]>} per tile, its
 *   square [x0, y0, x1, y1] and the kept features, each as its lines or rings of x, y
 *   world coordinates
 */
export async function loadTiles({ tileJson, layer, filter, bounds, zoom, minzoom = 0, pad = 0, maxTiles = Infinity }) {
  const { tiles: [template], maxzoom = 14 } = await tileJsonOf(tileJson);
  const z = Math.min(Math.max(Math.round(zoom), minzoom, 0), maxzoom);
  const n = 2 ** z;
  const tileOf = (w) => Math.min(Math.max(Math.floor(w * n), 0), n - 1);
  const tx0 = tileOf(bounds.x0 - pad);
  const ty0 = tileOf(bounds.y0 - pad);
  const tx1 = tileOf(bounds.x1 + pad);
  const ty1 = tileOf(bounds.y1 + pad);
  if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > maxTiles) throw new RangeError('Too large an area');
  const requests = [];
  for (let y = ty0; y <= ty1; y++) {
    for (let x = tx0; x <= tx1; x++) requests.push(loadTile(template, z, x, y, layer, filter));
  }
  return Promise.all(requests);
}

async function loadTile(template, z, x, y, layerName, filter) {
  const url = template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  const response = await fetch(url);
  // A tile that didn't load leaves a gap, so the whole request fails.
  if (!response.ok) throw new Error(`Tile ${z}/${x}/${y}: HTTP ${response.status}`);
  const layer = new VectorTile(new PbfReader(new Uint8Array(await response.arrayBuffer()))).layers[layerName];
  const n = 2 ** z;
  const features = [];
  for (let f = 0; f < (layer?.length ?? 0); f++) {
    const feature = layer.feature(f);
    if (!filter(feature)) continue;
    const toWorld = (p) => [(x + p.x / layer.extent) / n, (y + p.y / layer.extent) / n];
    features.push(feature.loadGeometry().map((ring) => Float64Array.from(ring.flatMap(toWorld))));
  }
  return { square: [x / n, y / n, (x + 1) / n, (y + 1) / n], features };
}

/**
 * Lowers each grid vertex's value in `dist` to its distance from segment a-b, for the
 * vertices within `reach` of it. The grid has nx × ny vertices, row by row; points and
 * distances are in grid cells. The segment is walked in pieces of at most one cell,
 * so only vertices near it are visited.
 * @param {Float32Array} dist per grid vertex, changed in place
 */
export function lowerDistances(dist, nx, ny, reach, ax, ay, bx, by) {
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
  for (let s = 0; s < steps; s++) {
    const x0 = ax + ((bx - ax) * s) / steps;
    const y0 = ay + ((by - ay) * s) / steps;
    const x1 = ax + ((bx - ax) * (s + 1)) / steps;
    const y1 = ay + ((by - ay) * (s + 1)) / steps;
    const iEnd = Math.min(Math.floor(Math.max(x0, x1) + reach), nx - 1);
    const jEnd = Math.min(Math.floor(Math.max(y0, y1) + reach), ny - 1);
    for (let j = Math.max(Math.ceil(Math.min(y0, y1) - reach), 0); j <= jEnd; j++) {
      for (let i = Math.max(Math.ceil(Math.min(x0, x1) - reach), 0); i <= iEnd; i++) {
        const d = segmentDistance(i, j, ax, ay, bx, by);
        if (d < dist[j * nx + i]) dist[j * nx + i] = d;
      }
    }
  }
}

/** Segment a-b clipped to the rectangle x0..x1 × y0..y1 (Liang-Barsky), or null. */
export function clipSegment(ax, ay, bx, by, x0, y0, x1, y1) {
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
