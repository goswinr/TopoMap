// Reads GlobalBuildingAtlas buildings from its GeoParquet files, off the main thread:
// as vector tiles for the map, and as plain arrays for the 3D print (buildings.js).
//
// The data is one file per 5° × 5° cell, each with up to some 20 million buildings in
// row groups of about 16000, sorted along a space-filling curve. So a row group covers
// a small area, and the footer's statistics of the bbox columns tell which ones meet
// the area asked for. Only those row groups are read, with HTTP range requests, and
// only their `height` and `geometry` columns.

import { parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { decompress } from 'fzstd';
import { PbfWriter } from 'pbf';

const CELL = 5; // degrees
// The first read of a file: its end, where the footer is. Footers of the largest files
// are about 2 MB, which then takes a second read.
const TAIL_BYTES = 512 * 1024;
const MAX_CACHED_GROUPS = 40; // decoded row groups kept, about 2 MB each
const EXTENT = 4096; // vector tile coordinates per tile side
const LAYER = 'buildings';

// Past the browser's HTTP cache: Chrome (on Windows, at least) fails concurrent range
// requests to a URL it holds part of with ERR_CACHE_OPERATION_NOT_SUPPORTED. The
// server asks for revalidation anyway, and decoded data is kept here.
const FETCH_OPTIONS = { cache: 'no-store' };

const compressors = { ZSTD: (input, outputLength) => decompress(input, new Uint8Array(outputLength)) };
// The geometry column as raw WKB, which readGroup() decodes into flat arrays.
const parsers = { geometryFromBytes: (bytes) => bytes };

const files = new Map(); // file URL -> Promise<{ file, metadata, groups } | null>
const groups = new Map(); // "URL#index" -> Promise<group>, least recently used first

self.onmessage = async ({ data: { id, type, ...options } }) => {
  try {
    if (type === 'tile') {
      const buffer = await tile(options);
      self.postMessage({ id, buffer }, [buffer]);
    } else {
      const buildings = await area(options);
      self.postMessage({ id, buildings }, Object.values(buildings).map((a) => a.buffer));
    }
  } catch (err) {
    self.postMessage({ id, error: err.message, tooLarge: err instanceof RangeError });
  }
};

/**
 * The buildings whose center is in tile z/x/y, as a vector tile with one layer of
 * polygons that have a `height` in meters, at least `minHeight`. Each building is
 * in exactly one tile, so none is drawn twice; it may reach a little beyond it.
 */
async function tile({ base, minHeight, z, x, y }) {
  const n = 2 ** z;
  const box = { x0: x / n, y0: y / n, x1: (x + 1) / n, y1: (y + 1) / n };
  const loaded = await Promise.all((await groupsIn(base, box)).map(loadGroup));
  const pbf = new PbfWriter();
  pbf.writeMessage(3, writeLayer, { loaded, box, scale: n * EXTENT, minHeight });
  return pbf.finish().slice().buffer;
}

/**
 * The buildings that meet `bounds`, with heights of at least `minHeight` meters:
 * building b has rings ringStarts[b] up to ringStarts[b + 1] (exclusive), the first
 * its outline and any others its holes, and ring r has points pointStarts[r] up to
 * pointStarts[r + 1] as x, y pairs in xy.
 * @throws {RangeError} if that takes more than maxGroups row groups
 */
async function area({ base, minHeight, bounds, maxGroups }) {
  // Wider than a cell, the area is too large anywhere with buildings, and opening the
  // files to find out would cost megabytes of footers.
  if ((bounds.x1 - bounds.x0) * 360 > CELL || latitude(bounds.y0) - latitude(bounds.y1) > CELL) {
    throw new RangeError('Too large an area');
  }
  const hits = await groupsIn(base, bounds);
  if (hits.length > maxGroups) throw new RangeError('Too large an area');
  const heights = [];
  const ringStarts = [0];
  const pointStarts = [0];
  const xy = [];
  for (const g of await Promise.all(hits.map(loadGroup))) {
    for (let b = 0; b < g.heights.length; b++) {
      if (g.boxes[4 * b] > bounds.x1 || g.boxes[4 * b + 2] < bounds.x0) continue;
      if (g.boxes[4 * b + 1] > bounds.y1 || g.boxes[4 * b + 3] < bounds.y0) continue;
      heights.push(Math.max(g.heights[b], minHeight));
      for (let r = g.ringStarts[b]; r < g.ringStarts[b + 1]; r++) {
        for (let p = 2 * g.pointStarts[r]; p < 2 * g.pointStarts[r + 1]; p++) xy.push(g.xy[p]);
        pointStarts.push(xy.length / 2);
      }
      ringStarts.push(pointStarts.length - 1);
    }
  }
  return {
    heights: Float32Array.from(heights),
    ringStarts: Uint32Array.from(ringStarts),
    pointStarts: Uint32Array.from(pointStarts),
    xy: Float64Array.from(xy),
  };
}

/** The row groups that may have buildings in `box` (world units), as [file, index]. */
async function groupsIn(base, box) {
  const west = box.x0 * 360 - 180;
  const east = box.x1 * 360 - 180;
  const north = latitude(box.y0);
  const south = latitude(box.y1);
  const urls = [];
  for (let lat = Math.floor(south / CELL) * CELL; lat < north; lat += CELL) {
    for (let lon = Math.floor(west / CELL) * CELL; lon < east; lon += CELL) urls.push(base + cellName(lon, lat));
  }
  const hits = [];
  for (const f of await Promise.all(urls.map(openFile))) {
    f?.groups.forEach((g, index) => {
      if (g.west <= east && g.east >= west && g.south <= north && g.north >= south) hits.push([f, index]);
    });
  }
  return hits;
}

/** The file of the cell with this south-west corner, such as e005_n50_e010_n45.parquet. */
function cellName(west, south) {
  const ew = (v) => `${v < 0 ? 'w' : 'e'}${String(Math.abs(v)).padStart(3, '0')}`;
  const ns = (v) => `${v < 0 ? 's' : 'n'}${String(Math.abs(v)).padStart(2, '0')}`;
  return `${ew(west)}_${ns(south + CELL)}_${ew(west + CELL)}_${ns(south)}.parquet`;
}

function openFile(url) {
  if (!files.has(url)) {
    files.set(url, readFooter(url).catch((err) => {
      files.delete(url); // try again next time
      throw err;
    }));
  }
  return files.get(url);
}

/**
 * A file's metadata, and each row group's rows and the box around its buildings in
 * degrees; null if the cell has no file (no buildings, such as on the open sea).
 */
async function readFooter(url) {
  // A suffix range gets the footer, and with it the file size, in one request.
  const response = await fetch(url, { ...FETCH_OPTIONS, headers: { Range: `bytes=-${TAIL_BYTES}` } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Buildings: HTTP ${response.status}`);
  const tail = await response.arrayBuffer();
  const byteLength = Number(response.headers.get('Content-Range')?.split('/')[1]) || tail.byteLength;
  const tailStart = byteLength - tail.byteLength;
  const file = {
    byteLength,
    async slice(start, end = byteLength) {
      if (start >= tailStart) return tail.slice(start - tailStart, end - tailStart);
      const part = await fetch(url, { ...FETCH_OPTIONS, headers: { Range: `bytes=${start}-${end - 1}` } });
      if (!part.ok) throw new Error(`Buildings: HTTP ${part.status}`);
      return part.arrayBuffer();
    },
  };
  const metadata = await parquetMetadataAsync(file, { initialFetchSize: tail.byteLength });
  let row = 0;
  const groupBoxes = metadata.row_groups.map(({ columns, num_rows }) => {
    // Without statistics a row group could be anywhere.
    const stat = (name, key, fallback) => {
      const value = columns.find((c) => c.meta_data.path_in_schema.join('.') === name)?.meta_data.statistics?.[key];
      return value === undefined ? fallback : Number(value);
    };
    const g = {
      west: stat('bbox.xmin', 'min_value', -Infinity),
      south: stat('bbox.ymin', 'min_value', -Infinity),
      east: stat('bbox.xmax', 'max_value', Infinity),
      north: stat('bbox.ymax', 'max_value', Infinity),
      rowStart: row,
      rowEnd: row + Number(num_rows),
    };
    row = g.rowEnd;
    return g;
  });
  return { url, file, metadata, groups: groupBoxes };
}

function loadGroup([f, index]) {
  const key = `${f.url}#${index}`;
  let group = groups.get(key);
  if (group) {
    groups.delete(key); // re-inserted below, as the most recently used
  } else {
    group = readGroup(f, f.groups[index]).catch((err) => {
      groups.delete(key);
      throw err;
    });
  }
  groups.set(key, group);
  if (groups.size > MAX_CACHED_GROUPS) groups.delete(groups.keys().next().value);
  return group;
}

/**
 * A row group's buildings in flat arrays, as area() returns them, plus each one's box
 * x0, y0, x1, y1 in `boxes`. Coordinates are world units. Rings are open: the WKB
 * rings' closing point, a repeat of the first, is left out.
 */
async function readGroup({ file, metadata }, { rowStart, rowEnd }) {
  const rows = await parquetReadObjects({ file, metadata, columns: ['height', 'geometry'], rowStart, rowEnd, compressors, parsers });
  const heights = [];
  const boxes = [];
  const ringStarts = [0];
  const pointStarts = [0];
  const xy = [];
  for (const { height, geometry } of rows) {
    if (!geometry) continue;
    const view = new DataView(geometry.buffer, geometry.byteOffset, geometry.byteLength);
    const little = view.getUint8(0) === 1;
    if (view.getUint32(1, little) !== 3) continue; // only 2D polygons, as the files have
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let offset = 9;
    for (let r = view.getUint32(5, little); r > 0; r--) {
      const count = view.getUint32(offset, little);
      offset += 4;
      for (let p = 0; p < count; p++, offset += 16) {
        if (p === count - 1 && p > 0) continue; // the closing point
        const x = (view.getFloat64(offset, little) + 180) / 360;
        const y = mercatorY(view.getFloat64(offset + 8, little));
        xy.push(x, y);
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
      pointStarts.push(xy.length / 2);
    }
    // -999 marks a missing height.
    heights.push(height > 0 ? height : 0);
    boxes.push(x0, y0, x1, y1);
    ringStarts.push(pointStarts.length - 1);
  }
  return {
    heights: Float32Array.from(heights),
    boxes: Float64Array.from(boxes),
    ringStarts: Uint32Array.from(ringStarts),
    pointStarts: Uint32Array.from(pointStarts),
    xy: Float64Array.from(xy),
  };
}

// Mapbox Vector Tile layer: version 15, name 1, features 2, keys 3, values 4, extent 5.
function writeLayer({ loaded, box, scale, minHeight }, pbf) {
  pbf.writeVarintField(15, 2);
  pbf.writeStringField(1, LAYER);
  const values = new Map(); // height -> index in the layer's values
  for (const g of loaded) {
    for (let b = 0; b < g.heights.length; b++) {
      const cx = (g.boxes[4 * b] + g.boxes[4 * b + 2]) / 2;
      const cy = (g.boxes[4 * b + 1] + g.boxes[4 * b + 3]) / 2;
      if (cx < box.x0 || cx >= box.x1 || cy < box.y0 || cy >= box.y1) continue;
      const geometry = tileGeometry(g, b, box, scale);
      if (!geometry.length) continue;
      const height = Math.round(Math.max(g.heights[b], minHeight) * 10) / 10;
      if (!values.has(height)) values.set(height, values.size);
      pbf.writeMessage(2, writeFeature, { tags: [0, values.get(height)], geometry });
    }
  }
  pbf.writeStringField(3, 'height');
  for (const height of values.keys()) pbf.writeMessage(4, (v, p) => p.writeDoubleField(3, v), height);
  pbf.writeVarintField(5, EXTENT);
}

// Feature: tags 2, type 3 (3 is a polygon), geometry 4.
function writeFeature({ tags, geometry }, pbf) {
  pbf.writePackedVarint(2, tags);
  pbf.writeVarintField(3, 3);
  pbf.writePackedVarint(4, geometry);
}

/**
 * Building b's rings as vector tile geometry commands. The outline winds clockwise in
 * tile coordinates (y down) and holes the other way, as the format requires; MapLibre
 * also takes the walls' outside from it. Empty if the outline vanishes when rounded.
 */
function tileGeometry(g, b, box, scale) {
  const out = [];
  let cx = 0; // the command cursor
  let cy = 0;
  for (let r = g.ringStarts[b]; r < g.ringStarts[b + 1]; r++) {
    const pts = [];
    for (let p = g.pointStarts[r]; p < g.pointStarts[r + 1]; p++) {
      const x = Math.round((g.xy[2 * p] - box.x0) * scale);
      const y = Math.round((g.xy[2 * p + 1] - box.y0) * scale);
      if (x !== pts.at(-2) || y !== pts.at(-1)) pts.push(x, y);
    }
    if (pts.length > 2 && pts[0] === pts.at(-2) && pts[1] === pts.at(-1)) pts.length -= 2;
    let twiceArea = 0; // positive if clockwise, with y down
    for (let k = 0; k < pts.length; k += 2) {
      const next = (k + 2) % pts.length;
      twiceArea += pts[k] * pts[next + 1] - pts[next] * pts[k + 1];
    }
    if (pts.length < 6 || twiceArea === 0) {
      if (r === g.ringStarts[b]) return [];
      continue;
    }
    if (twiceArea > 0 !== (r === g.ringStarts[b])) {
      for (let k = 0, m = pts.length - 2; k < m; k += 2, m -= 2) {
        [pts[k], pts[k + 1], pts[m], pts[m + 1]] = [pts[m], pts[m + 1], pts[k], pts[k + 1]];
      }
    }
    // MoveTo the first point, LineTo the others, ClosePath; deltas zigzag-encoded.
    out.push(1 | (1 << 3), zigzag(pts[0] - cx), zigzag(pts[1] - cy), 2 | ((pts.length / 2 - 1) << 3));
    for (let k = 2; k < pts.length; k += 2) out.push(zigzag(pts[k] - pts[k - 2]), zigzag(pts[k + 1] - pts[k - 1]));
    out.push(7 | (1 << 3));
    cx = pts.at(-2);
    cy = pts.at(-1);
  }
  return out;
}

const zigzag = (v) => (v << 1) ^ (v >> 31);

/** Web Mercator y in [0, 1] world units, north at 0. */
function mercatorY(lat) {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

function latitude(y) {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}
