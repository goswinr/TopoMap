// Highlights the stretches of roads that lie above a given elevation.
//
// Style expressions can't read terrain elevation on line layers, so this samples
// the DEM along each rendered road in JS and draws the parts above the threshold
// from a GeoJSON source. Sampling reruns when the view or the road tiles change;
// changing the threshold only re-cuts the cached samples, so it is instant.
// Each highlighted piece keeps its road's properties (e.g. class) for styling.

const DEM_TILE_SIZE = 512; // Mapterhorn tiles are 512 px
const DEM_TILE_CACHE_SIZE = 32; // decoded tiles are ~1 MB each
const REFRESH_DELAY_MS = 300;

/**
 * @param {import('maplibre-gl').Map} map
 * @param {object} options
 * @param {object} options.demSource maplibre-contour DemSource to read elevations from
 * @param {() => number} options.demZoom DEM zoom level to sample at
 * @param {{sourceId: string, sourceLayer: string, filter: any[]}} options.roads
 * @param {string} options.targetSourceId GeoJSON source that receives the highlighted parts
 * @param {number} options.elevation initial threshold in meters
 */
export function createRoadsAboveHighlight(map, { demSource, demZoom, roads, targetSourceId, elevation }) {
  const demTiles = new Map(); // "z/x/y" -> Promise<DemTile | null>, oldest first
  let samples = []; // per road line: { properties, s: Float64Array of [lng, lat, ele, ...] }
  let threshold = elevation;
  let enabled = false;
  let generation = 0;
  let timer;

  function getDemTile(key) {
    let tile = demTiles.get(key);
    if (tile) {
      demTiles.delete(key); // re-insert below to mark as recently used
    } else {
      const [z, x, y] = key.split('/').map(Number);
      tile = demSource.getDemTile(z, x, y).catch(() => null);
    }
    demTiles.set(key, tile);
    if (demTiles.size > DEM_TILE_CACHE_SIZE) demTiles.delete(demTiles.keys().next().value);
    return tile;
  }

  async function refresh() {
    const gen = ++generation;
    const z = demZoom();
    const scale = 2 ** z;
    const step = 1 / (scale * DEM_TILE_SIZE); // one DEM pixel, in world units

    // Densify each road to about one sample per DEM pixel.
    const lines = [];
    const keys = new Set();
    for (const feature of map.querySourceFeatures(roads.sourceId, { sourceLayer: roads.sourceLayer, filter: roads.filter })) {
      const { type, coordinates } = feature.geometry;
      const parts = type === 'LineString' ? [coordinates] : type === 'MultiLineString' ? coordinates : [];
      for (const coords of parts) {
        const points = [];
        for (let i = 0; i < coords.length; i++) {
          const [lng, lat] = coords[i];
          const [wx, wy] = toWorld(lng, lat);
          if (i > 0) {
            const [plng, plat] = coords[i - 1];
            const [pwx, pwy] = toWorld(plng, plat);
            const n = Math.ceil(Math.hypot(wx - pwx, wy - pwy) / step);
            for (let k = 1; k < n; k++) {
              const t = k / n;
              points.push(plng + t * (lng - plng), plat + t * (lat - plat), pwx + t * (wx - pwx), pwy + t * (wy - pwy));
            }
          }
          points.push(lng, lat, wx, wy);
        }
        for (let i = 0; i < points.length; i += 4) {
          keys.add(`${z}/${Math.floor(points[i + 2] * scale)}/${Math.floor(points[i + 3] * scale)}`);
        }
        // Copy into a plain object: MapLibre can't send prototype-less objects to its worker.
        lines.push({ properties: { ...feature.properties }, points });
      }
    }

    const tiles = new Map(await Promise.all([...keys].map(async (key) => [key, await getDemTile(key)])));
    if (gen !== generation) return; // a newer refresh started meanwhile

    samples = lines.map(({ properties, points }) => {
      const s = new Float64Array((points.length / 4) * 3);
      for (let i = 0, j = 0; i < points.length; i += 4, j += 3) {
        s[j] = points[i];
        s[j + 1] = points[i + 1];
        s[j + 2] = sampleElevation(tiles, z, points[i + 2], points[i + 3]);
      }
      return { properties, s };
    });
    render();
  }

  // Cut the sampled roads at the threshold, interpolating the crossing points.
  function render() {
    const features = [];
    if (enabled) {
      for (const { properties, s } of samples) {
        const parts = [];
        let part = null;
        for (let i = 0; i < s.length; i += 3) {
          const lng = s[i];
          const lat = s[i + 1];
          const ele = s[i + 2];
          const above = ele >= threshold;
          if (i === 0) {
            if (above) part = [];
          } else {
            const prevEle = s[i - 1];
            if (above !== prevEle >= threshold) {
              const t = (threshold - prevEle) / (ele - prevEle);
              const crossing = Number.isFinite(t)
                ? [s[i - 3] + t * (lng - s[i - 3]), s[i - 2] + t * (lat - s[i - 2])]
                : null;
              if (above) {
                part = crossing ? [crossing] : [];
              } else {
                if (crossing) part.push(crossing);
                if (part.length > 1) parts.push(part);
                part = null;
              }
            }
          }
          if (above) part.push([lng, lat]);
        }
        if (part && part.length > 1) parts.push(part);
        if (parts.length) {
          features.push({ type: 'Feature', properties, geometry: { type: 'MultiLineString', coordinates: parts } });
        }
      }
    }
    map.getSource(targetSourceId)?.setData({ type: 'FeatureCollection', features });
  }

  function scheduleRefresh() {
    clearTimeout(timer);
    if (enabled) timer = setTimeout(refresh, REFRESH_DELAY_MS);
  }

  map.on('moveend', scheduleRefresh);
  map.on('sourcedata', (e) => {
    if (e.sourceId === roads.sourceId && e.isSourceLoaded) scheduleRefresh();
  });

  return {
    setElevation(value) {
      threshold = value;
      render();
    },
    setEnabled(on) {
      enabled = on;
      render();
      if (on) scheduleRefresh();
    },
  };
}

/** Web Mercator position in [0, 1] world units. */
function toWorld(lng, lat) {
  const s = Math.sin((lat * Math.PI) / 180);
  return [(lng + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
}

/** Bilinear elevation at a world position, or NaN where the DEM tile is missing. */
function sampleElevation(tiles, z, wx, wy) {
  const scale = 2 ** z;
  const tx = wx * scale;
  const ty = wy * scale;
  const tileX = Math.floor(tx);
  const tileY = Math.floor(ty);
  const tile = tiles.get(`${z}/${tileX}/${tileY}`);
  if (!tile) return NaN;
  const { width: w, height: h, data } = tile;
  // Pixel values describe pixel centers, which sit half a pixel in.
  const px = Math.min(Math.max((tx - tileX) * w - 0.5, 0), w - 1);
  const py = Math.min(Math.max((ty - tileY) * h - 0.5, 0), h - 1);
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const fx = px - x0;
  const fy = py - y0;
  const top = data[y0 * w + x0] * (1 - fx) + data[y0 * w + x1] * fx;
  const bottom = data[y1 * w + x0] * (1 - fx) + data[y1 * w + x1] * fx;
  return top * (1 - fy) + bottom * fy;
}
