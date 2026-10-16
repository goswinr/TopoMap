// 3D print export: a north-up rectangle with draggable handles on the map, and a
// panel that turns the terrain inside it into an STL file for a slicer.
//
// The rectangle is kept in Web Mercator world units ([0, 1], y down). Its terrain
// is sampled when the rectangle or the model size changes, so the panel can show
// the model's real heights, including where each contour line ends up, which is
// where a filament change turns it into a colour band.

import * as maplibregl from 'maplibre-gl';
import { buildStl, demZoomFor, loadDem, metersPerWorldUnit, sampleGrid } from './terrain-stl.js';

const GRID_MM = 0.3; // sample spacing on the print, below what a 0.4 mm nozzle can draw
const MAX_GRID = 800; // samples per side, caps the STL near 1.3M triangles (64 MB)
const MIN_SIDE_MM = 5;
const START_SIZE = 0.4; // side of a new rectangle, as a fraction of the smaller map side
const UPDATE_DELAY_MS = 300;
const STL_HEADER = 'TopoMap terrain, elevation (c) Mapterhorn, mapterhorn.com/attribution';

// Corner handles in order NW, NE, SE, SW: corner k ^ 2 is opposite corner k,
// k ^ 1 shares its north/south edge and 3 - k its west/east edge.
const cornerOf = ({ x0, y0, x1, y1 }, k) => [k === 1 || k === 2 ? x1 : x0, k >= 2 ? y1 : y0];

/**
 * @param {import('maplibre-gl').Map} map
 * @param {object} options
 * @param {object} options.demSource maplibre-contour DemSource to read elevations from
 * @param {string} options.sourceId GeoJSON source that receives the rectangle
 * @param {HTMLFormElement} options.form the export panel
 * @param {{id: string, color: string, elevation: number}[]} options.contours contour lines
 */
export function createPrintArea(map, { demSource, sourceId, form, contours }) {
  const inputs = form.elements;
  const stats = form.querySelector('.print-stats');
  const colors = form.querySelector('.print-colors');
  const lines = contours.map(({ id, color, elevation }) => ({ id, color, elevation }));
  let bounds = null;
  let model = null; // the sampled terrain: { bounds, nx, ny, grid, min, max, demZoom }
  let status = '';
  let enabled = false;
  let generation = 0;
  let timer;

  const handle = (className) => Object.assign(document.createElement('div'), { className });
  const corners = [0, 1, 2, 3].map(() => new maplibregl.Marker({ element: handle('print-handle'), draggable: true }));
  const mover = new maplibregl.Marker({ element: handle('print-handle move'), draggable: true });

  corners.forEach((marker, k) => {
    let anchor;
    marker.on('dragstart', () => {
      anchor = cornerOf(bounds, k ^ 2);
    });
    marker.on('drag', () => {
      const [x, y] = toWorld(marker.getLngLat());
      setBounds({ x0: x, y0: y, x1: anchor[0], y1: anchor[1] });
      // Keep the dragged handle under the pointer even if it crosses the opposite corner.
      corners[k ^ 1].setLngLat(toLngLat(anchor[0], y));
      corners[3 - k].setLngLat(toLngLat(x, anchor[1]));
      corners[k ^ 2].setLngLat(toLngLat(...anchor));
      mover.setLngLat(toLngLat((x + anchor[0]) / 2, (y + anchor[1]) / 2));
    });
    marker.on('dragend', () => {
      placeHandles();
      scheduleUpdate();
    });
  });

  let moveStart;
  mover.on('dragstart', () => {
    moveStart = { bounds, at: toWorld(mover.getLngLat()) };
  });
  mover.on('drag', () => {
    const [x, y] = toWorld(mover.getLngLat());
    const dx = x - moveStart.at[0];
    const dy = y - moveStart.at[1];
    const b = moveStart.bounds;
    setBounds({ x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy });
    corners.forEach((marker, k) => marker.setLngLat(toLngLat(...cornerOf(bounds, k))));
  });
  mover.on('dragend', scheduleUpdate);

  /** A square in the middle of the view. */
  function startBounds() {
    const [cx, cy] = toWorld(map.getCenter());
    const canvas = map.getCanvas();
    const side = (START_SIZE * Math.min(canvas.clientWidth, canvas.clientHeight)) / (512 * 2 ** map.getZoom());
    return { x0: cx - side / 2, y0: cy - side / 2, x1: cx + side / 2, y1: cy + side / 2 };
  }

  function setBounds({ x0, y0, x1, y1 }) {
    bounds = { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
    const ring = [0, 1, 2, 3, 0].map((k) => toLngLat(...cornerOf(bounds, k)).toArray());
    // Shade everything outside the rectangle: the world with the rectangle as a hole.
    const world = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
    map.getSource(sourceId)?.setData({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [world, ring] } },
        { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ring } },
      ],
    });
  }

  function placeHandles() {
    corners.forEach((marker, k) => marker.setLngLat(toLngLat(...cornerOf(bounds, k))));
    mover.setLngLat(toLngLat((bounds.x0 + bounds.x1) / 2, (bounds.y0 + bounds.y1) / 2));
  }

  function scheduleUpdate() {
    clearTimeout(timer);
    generation++; // results of a running update are stale from now on
    model = null;
    status = 'Loading elevation…';
    render();
    timer = setTimeout(update, UPDATE_DELAY_MS);
  }

  // Sample the terrain on the print grid, at the DEM zoom that resolves it.
  async function update() {
    const gen = generation;
    const b = bounds;
    const spanX = b.x1 - b.x0;
    const spanY = b.y1 - b.y0;
    const span = Math.max(spanX, spanY);
    const size = readNumber(inputs.size);
    if (!(size * Math.min(spanX, spanY) >= MIN_SIDE_MM * span)) {
      status = 'Drag the handles further apart.';
      render();
      return;
    }
    const spacing = span / Math.min(Math.ceil(size / GRID_MM), MAX_GRID - 1);
    const nx = Math.max(2, Math.round(spanX / spacing) + 1);
    const ny = Math.max(2, Math.round(spanY / spacing) + 1);
    try {
      const dem = await loadDem(demSource, b, demZoomFor(spacing));
      if (gen !== generation) return;
      model = { bounds: b, nx, ny, demZoom: dem.z, ...sampleGrid(dem, b, nx, ny) };
    } catch (err) {
      if (gen !== generation) return;
      status = err.message;
    }
    render();
  }

  /** Model dimensions in mm for the current inputs. */
  function measure() {
    const { bounds: b, min, max } = model;
    const metersPerUnit = metersPerWorldUnit(b);
    const widthM = (b.x1 - b.x0) * metersPerUnit;
    const depthM = (b.y1 - b.y0) * metersPerUnit;
    const mmPerM = readNumber(inputs.size) / Math.max(widthM, depthM);
    const zPerM = mmPerM * readNumber(inputs.exaggeration);
    const base = readNumber(inputs.base);
    return {
      widthM,
      depthM,
      width: widthM * mmPerM,
      depth: depthM * mmPerM,
      height: base + (max - min) * zPerM,
      scale: 1000 / mmPerM,
      demPixel: metersPerUnit / (512 * 2 ** model.demZoom),
      toZ: (ele) => base + (ele - min) * zPerM,
    };
  }

  function render() {
    inputs.download.disabled = !model;
    if (!model) {
      stats.replaceChildren(Object.assign(document.createElement('dt'), { textContent: status }));
      colors.replaceChildren();
      return;
    }
    const m = measure();
    const mm = (v) => v.toFixed(0);
    stats.innerHTML = `
      <dt>Area</dt><dd>${(m.widthM / 1000).toFixed(2)} × ${(m.depthM / 1000).toFixed(2)} km</dd>
      <dt>Model</dt><dd>${mm(m.width)} × ${mm(m.depth)} × ${mm(m.height)} mm</dd>
      <dt>Scale</dt><dd>1:${Math.round(m.scale).toLocaleString('en')}</dd>
      <dt>Elevation</dt><dd>${Math.round(model.min)}–${Math.round(model.max)} m</dd>
      <dt>Terrain data</dt><dd>${m.demPixel.toFixed(1)} m grid</dd>`;
    const rows = [...lines]
      .sort((a, b) => a.elevation - b.elevation)
      .map(({ color, elevation }) => {
        const inside = elevation > model.min && elevation < model.max;
        return `<li style="--accent: ${color}">${elevation} m: ${inside ? `<b>${m.toZ(elevation).toFixed(1)} mm</b>` : 'not in area'}</li>`;
      });
    colors.innerHTML = `<p>Filament change heights for the contour lines:</p><ul>${rows.join('')}</ul>`;
  }

  async function download() {
    const button = inputs.download;
    button.disabled = true;
    button.textContent = 'Building…';
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the button repaint
    try {
      if (!model) return; // the area changed meanwhile
      const { grid, nx, ny, bounds: b } = model;
      const { width, depth, toZ } = measure();
      const stl = buildStl({ grid, nx, ny, width, depth, toZ, header: STL_HEADER });
      const center = toLngLat((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
      const link = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(new Blob([stl], { type: 'model/stl' })),
        download: `terrain_${center.lat.toFixed(4)}_${center.lng.toFixed(4)}.stl`,
      });
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
    } finally {
      button.textContent = 'Download STL';
      button.disabled = !model;
    }
  }

  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('input', (e) => {
    // Only the model size changes the sampling grid; the rest just rescales heights.
    if (e.target === inputs.size) scheduleUpdate();
    else if (model) render();
  });
  inputs.download.addEventListener('click', download);

  return {
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      form.hidden = !on;
      if (on) {
        const center = bounds && toLngLat((bounds.x0 + bounds.x1) / 2, (bounds.y0 + bounds.y1) / 2);
        if (!center || !map.getBounds().contains(center)) {
          setBounds(startBounds());
          scheduleUpdate();
        }
        placeHandles();
        for (const marker of [...corners, mover]) marker.addTo(map);
      } else {
        for (const marker of [...corners, mover]) marker.remove();
      }
    },
    setContourElevation(id, elevation) {
      const line = lines.find((l) => l.id === id);
      if (line) line.elevation = elevation;
      if (model) render();
    },
  };
}

/** A number input's value, clamped to its range; its default if empty or invalid. */
function readNumber(input) {
  const v = input.valueAsNumber;
  return Number.isFinite(v) ? Math.min(Math.max(v, Number(input.min)), Number(input.max)) : Number(input.defaultValue);
}

function toWorld(lngLat) {
  const { x, y } = maplibregl.MercatorCoordinate.fromLngLat(lngLat);
  return [x, y];
}

function toLngLat(x, y) {
  return new maplibregl.MercatorCoordinate(x, y, 0).toLngLat();
}
