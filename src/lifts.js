// Ski lifts for the 3D print export: the aerialways in the OpenMapTiles vector tiles
// under the print area, turned into how far each print grid vertex is raised. The
// lifts thus become ridges in the terrain itself, so the model stays one closed
// surface, cut at the contour lines and the shore like the rest.

import { clipSegment, loadTiles, lowerDistances } from './vector-tiles.js';

// OpenMapTiles has aerialways from this zoom on.
const LIFT_MINZOOM = 12;
// Lifts are read at LIFT_MINZOOM or finer however large the area, so it's capped.
const MAX_TILES = 64;

/**
 * Loads the ski lifts in the vector tiles covering `bounds`, extended by `pad`.
 * @param {object} source
 * @param {string} source.tileJson TileJSON URL of an OpenMapTiles vector tile source
 * @param {string} source.layer the source layer with the aerialways
 * @param {string[]} source.classes aerialway `subclass` values that count as ski lifts
 * @param {{x0: number, y0: number, x1: number, y1: number}} bounds world units
 * @param {number} zoom preferred tile zoom
 * @param {number} pad world units
 * @returns {Promise<Float64Array[]>} the lifts as lines of x, y world coordinates; a
 *   lift crossing tiles comes in overlapping pieces
 * @throws {RangeError} if the area needs more than MAX_TILES tiles
 */
export async function loadLifts({ tileJson, layer, classes }, bounds, zoom, pad) {
  const tiles = await loadTiles({
    tileJson,
    layer,
    filter: ({ type, properties }) =>
      type === 2 && properties.class === 'aerialway' && classes.includes(properties.subclass),
    bounds,
    zoom,
    minzoom: LIFT_MINZOOM,
    pad,
    maxTiles: MAX_TILES,
  });
  return tiles.flatMap(({ features }) => features.flat());
}

/**
 * How much the lifts raise each grid vertex, as a share of the lift height: 1 up to
 * halfWidth - 0.5 cells from a lift, falling to 0 at halfWidth + 0.5 cells. On the
 * grid's triangles that makes a ridge 2 × halfWidth cells wide at half its height,
 * whose sides run between the vertices rather than along them. The grid spans
 * `bounds` with nx × ny vertices, row by row from the north edge, like sampleGrid().
 * @param {Float64Array[]} lines from loadLifts()
 * @param {number} halfWidth grid cells
 * @returns {Float32Array | null} null if no lift reaches a vertex
 */
export function liftField(lines, bounds, nx, ny, halfWidth) {
  const reach = halfWidth + 0.5;
  // Grid coordinates: i from 0 to nx - 1 west to east, j from 0 to ny - 1 north to south.
  const sx = (nx - 1) / (bounds.x1 - bounds.x0);
  const sy = (ny - 1) / (bounds.y1 - bounds.y0);
  const dist = new Float32Array(nx * ny).fill(reach);
  for (const line of lines) {
    for (let k = 0; k + 3 < line.length; k += 2) {
      // Only the part within reach of the grid can raise a vertex.
      const seg = clipSegment(
        (line[k] - bounds.x0) * sx,
        (line[k + 1] - bounds.y0) * sy,
        (line[k + 2] - bounds.x0) * sx,
        (line[k + 3] - bounds.y0) * sy,
        -reach,
        -reach,
        nx - 1 + reach,
        ny - 1 + reach,
      );
      if (seg) lowerDistances(dist, nx, ny, reach, ...seg);
    }
  }
  const share = Float32Array.from(dist, (d) => Math.min(reach - d, 1));
  return share.some((s) => s > 0) ? share : null;
}
