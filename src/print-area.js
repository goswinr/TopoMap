// 3D print export: a north-up rectangle with draggable handles on the map, and a
// panel that turns the terrain inside it into STL files for a slicer: either one
// STL, or a ZIP with the contour lines as separate parts for their own filaments.
// Where the rectangle reaches the sea, the model can end at the coastline, and ski
// lifts can stand out as ridges on the terrain.
//
// The rectangle is kept in Web Mercator world units ([0, 1], y down). Its terrain,
// sea and lifts are sampled when the rectangle or the model size changes, so the
// panel can show the model's real heights, including where each contour line ends up.

import * as maplibregl from 'maplibre-gl';
import { buildBands, demZoomFor, landRange, loadDem, metersPerWorldUnit, sampleGrid, writeStl } from './terrain-stl.js';
import { SHORE_REACH, landField, loadSea } from './coast.js';
import { liftField, loadLifts } from './lifts.js';
import { load, loadNumber, save } from './settings.js';
import { zip } from './zip.js';

const GRID_MM = 0.3; // sample spacing on the print, below what a 0.4 mm nozzle can draw
const MAX_GRID = 800; // samples per side, caps the STL near 1.3M triangles (64 MB)
const MIN_SIDE_MM = 5;
const SIZE_INPUTS = ['size', 'short', 'scale']; // longest side and short side in mm, 1:scale
const START_SIZE = 0.4; // side of a new rectangle, as a fraction of the smaller map side
const UPDATE_DELAY_MS = 300;
// Ski lift ridges, at half their height: two lines of a 0.4 mm nozzle. The sides
// slope over one grid cell, see liftField().
const LIFT_WIDTH_MM = 0.8;
// At most 80 ASCII characters; the coastline and the lifts come from OpenStreetMap.
const STL_HEADER = 'TopoMap terrain, elevation (c) Mapterhorn, mapterhorn.com/attribution';
const STL_HEADER_OSM = 'TopoMap terrain (c) Mapterhorn, map data (c) OpenStreetMap contributors';

// Corner handles in order NW, NE, SE, SW: corner k ^ 2 is opposite corner k,
// k ^ 1 shares its north/south edge and 3 - k its west/east edge.
const cornerOf = ({ x0, y0, x1, y1 }, k) => [k === 1 || k === 2 ? x1 : x0, k >= 2 ? y1 : y0];

/**
 * @param {import('maplibre-gl').Map} map
 * @param {object} options
 * @param {object} options.demSource maplibre-contour DemSource to read elevations from
 * @param {object} options.sea where the sea polygons are, see loadSea()
 * @param {object} options.lifts where the ski lifts are, see loadLifts()
 * @param {string} options.sourceId GeoJSON source that receives the rectangle
 * @param {HTMLFormElement} options.form the export panel
 */
export function createPrintArea(map, { demSource, sea, lifts, sourceId, form }) {
  const inputs = form.elements;
  // The panel's last values; readNumber() clamps stale ones to each input's range.
  for (const input of form.querySelectorAll('input[name]')) {
    const saved = load(`print.${input.name}`);
    if (input.type === 'checkbox') {
      if (typeof saved === 'boolean') input.checked = saved;
    } else if (typeof saved === 'number' && Number.isFinite(saved)) {
      input.value = saved;
    }
  }
  // The model size comes from the last edited of SIZE_INPUTS; the others show what it
  // gives for the area's shape, and follow when the area changes.
  let sizeBy = SIZE_INPUTS.includes(load('print.sizeBy')) ? load('print.sizeBy') : 'size';
  const stats = form.querySelector('.print-stats');
  const colors = form.querySelector('.print-colors');
  let contours = { lines: [] }; // see setContours()
  let liftsOn = false; // see setLifts()
  let bounds = null;
  // The sampled area: { bounds, nx, ny, demZoom, grid, min, max }, and where the sea is:
  // { land, seaShare, landMin, landMax } (land is null without sea), or seaError. With
  // liftsOn, also the lifts: { lifts } from liftField() (null if none), or liftError.
  let model = null;
  let status = '';
  let enabled = false;
  let generation = 0;
  let timer;

  const handle = (className) => Object.assign(document.createElement('div'), { className });
  const corners = [0, 1, 2, 3].map(() => new maplibregl.Marker({ element: handle('print-handle'), draggable: true }));
  const mover = new maplibregl.Marker({ element: handle('print-handle move'), draggable: true });

  // A corner resizes the rectangle as a square, or freely while Ctrl or Shift is held.
  // Marker drag events carry no key state, so it's tracked here.
  let free = false;
  let resize = null; // redraws the corner being dragged
  const trackModifiers = (e) => {
    free = e.ctrlKey || e.shiftKey;
  };
  window.addEventListener('pointerdown', trackModifiers, true);
  window.addEventListener('pointermove', trackModifiers, true);
  // A key pressed or released mid-drag reshapes the rectangle without a pointer move.
  for (const type of ['keydown', 'keyup']) {
    window.addEventListener(type, (e) => {
      const was = free;
      trackModifiers(e);
      if (free !== was) resize?.();
    });
  }

  corners.forEach((marker, k) => {
    let anchor;
    let pointer;
    function reshape() {
      let [x, y] = pointer;
      if (!free) {
        // The corner on the anchor's diagonal nearest the pointer.
        const dx = x - anchor[0];
        const dy = y - anchor[1];
        const side = (Math.abs(dx) + Math.abs(dy)) / 2;
        x = anchor[0] + (dx < 0 ? -side : side);
        y = anchor[1] + (dy < 0 ? -side : side);
      }
      setBounds({ x0: x, y0: y, x1: anchor[0], y1: anchor[1] });
      // Place the handles from the dragged corner, not from bounds: if it crossed the
      // opposite corner, bounds has swapped them.
      marker.setLngLat(toLngLat(x, y));
      corners[k ^ 1].setLngLat(toLngLat(anchor[0], y));
      corners[3 - k].setLngLat(toLngLat(x, anchor[1]));
      corners[k ^ 2].setLngLat(toLngLat(...anchor));
      mover.setLngLat(toLngLat((x + anchor[0]) / 2, (y + anchor[1]) / 2));
    }
    marker.on('dragstart', () => {
      anchor = cornerOf(bounds, k ^ 2);
      resize = reshape;
    });
    marker.on('drag', () => {
      pointer = toWorld(marker.getLngLat());
      reshape();
    });
    marker.on('dragend', () => {
      resize = null;
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
    save('print.bounds', bounds);
    showSize();
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

  /** The model's mm per meter of terrain in the area `b`, from the input that sets the size. */
  function mmPerMeter(b) {
    if (sizeBy === 'scale') return 1000 / readNumber(inputs.scale);
    const metersPerUnit = metersPerWorldUnit(b);
    const sides = [(b.x1 - b.x0) * metersPerUnit, (b.y1 - b.y0) * metersPerUnit];
    return sizeBy === 'short' ? readNumber(inputs.short) / Math.min(...sides) : readNumber(inputs.size) / Math.max(...sides);
  }

  /** Fills the size inputs that don't set the size with what it gives for the current area. */
  function showSize() {
    const metersPerUnit = metersPerWorldUnit(bounds);
    const mmPerM = mmPerMeter(bounds);
    const sides = [bounds.x1 - bounds.x0, bounds.y1 - bounds.y0].map((span) => span * metersPerUnit * mmPerM);
    const values = { size: Math.max(...sides), short: Math.min(...sides), scale: 1000 / mmPerM };
    for (const name of SIZE_INPUTS) {
      if (name !== sizeBy) inputs[name].value = Math.round(values[name]);
    }
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

  // The model lacks the lifts if they were off when it was sampled, or didn't load.
  const stale = () => !model || (liftsOn && model.lifts === undefined);

  // Sample the terrain on the print grid, at the DEM zoom that resolves it, and the
  // sea and the lifts from vector tiles of about the same resolution.
  async function update() {
    const gen = generation;
    const b = bounds;
    const spanX = b.x1 - b.x0;
    const spanY = b.y1 - b.y0;
    const span = Math.max(spanX, spanY);
    const size = span * metersPerWorldUnit(b) * mmPerMeter(b); // longest side in mm
    if (!(size * Math.min(spanX, spanY) >= MIN_SIDE_MM * span)) {
      status = 'Drag the handles further apart.';
      render();
      return;
    }
    const spacing = span / Math.min(Math.ceil(size / GRID_MM), MAX_GRID - 1);
    const nx = Math.max(2, Math.round(spanX / spacing) + 1);
    const ny = Math.max(2, Math.round(spanY / spacing) + 1);
    const demZoom = demZoomFor(spacing);
    const liftHalfWidth = (LIFT_WIDTH_MM / 2) * (span / (size * spacing)); // grid cells
    try {
      const [dem, seaTiles, liftLines] = await Promise.all([
        loadDem(demSource, b, demZoom),
        // Without the sea or the lifts the model still works, just without them.
        loadSea(sea, b, demZoom, (SHORE_REACH + 1) * spacing).catch((err) => err),
        liftsOn ? loadLifts(lifts, b, demZoom, (liftHalfWidth + 1) * spacing).catch((err) => err) : undefined,
      ]);
      if (gen !== generation) return;
      model = { bounds: b, nx, ny, demZoom: dem.z, ...sampleGrid(dem, b, nx, ny), land: null };
      if (seaTiles instanceof Error) {
        model.seaError = seaTiles.message;
      } else {
        const coast = landField(seaTiles, b, nx, ny);
        if (coast) {
          const { min, max } = landRange(model.grid, coast.land, nx, ny);
          Object.assign(model, { land: coast.land, seaShare: coast.seaShare, landMin: min, landMax: max });
        }
      }
      if (liftLines instanceof Error) {
        model.liftError = liftLines instanceof RangeError ? 'area too large' : 'didn’t load';
      } else if (liftLines) {
        model.lifts = liftField(liftLines, b, nx, ny, liftHalfWidth);
      }
    } catch (err) {
      if (gen !== generation) return;
      status = err.message;
    }
    render();
  }

  /**
   * The terrain to print, and the model's dimensions in mm for the current inputs.
   * The terrain is cut at the coastline if there's sea and the panel asks for it, and
   * has the lifts (as liftField() shares of liftHeight) while they are on.
   */
  function measure() {
    const cut = Boolean(model.land) && inputs.coast.checked;
    const { bounds: b, grid } = model;
    const min = cut ? model.landMin : model.min;
    const max = cut ? model.landMax : model.max;
    const metersPerUnit = metersPerWorldUnit(b);
    const widthM = (b.x1 - b.x0) * metersPerUnit;
    const depthM = (b.y1 - b.y0) * metersPerUnit;
    const mmPerM = mmPerMeter(b);
    const zPerM = mmPerM * readNumber(inputs.exaggeration);
    const base = readNumber(inputs.base);
    return {
      grid,
      land: cut ? model.land : null,
      lifts: (liftsOn && model.lifts) || null,
      liftHeight: readNumber(inputs.lift),
      min,
      max,
      widthM,
      depthM,
      width: widthM * mmPerM,
      depth: depthM * mmPerM,
      height: base + (max - min) * zPerM,
      scale: 1000 / mmPerM,
      demPixel: metersPerUnit / (512 * 2 ** model.demZoom),
      zPerM,
      toZ: (ele) => base + (ele - min) * zPerM,
    };
  }

  /** The contour lines to print, lowest first; lines every N meters only inside the model. */
  function printLines(m) {
    if (!contours.every) return [...contours.lines].sort((a, b) => a.elevation - b.elevation);
    const { every, name, color } = contours;
    const lines = [];
    for (let ele = (Math.floor(m.min / every) + 1) * every; ele < m.max; ele += every) {
      lines.push({ name, color, elevation: ele });
    }
    return lines;
  }

  /**
   * The contour lines inside the area as slices of the line thickness, lowest first.
   * A slice stops where the next one starts, so the parts never overlap.
   */
  function lineSlices(m) {
    const thickness = readNumber(inputs.line);
    const slices = [];
    for (const line of printLines(m)) {
      if (line.elevation <= m.min || line.elevation >= m.max) continue;
      const z = m.toZ(line.elevation);
      const lo = Math.max(z, slices.at(-1)?.hi ?? 0);
      if (z + thickness > lo) slices.push({ line, lo, hi: z + thickness });
    }
    return slices;
  }

  function render() {
    const m = model && measure();
    // Without land (all sea, cut off at the coastline) there's nothing to print.
    const empty = !m || !(m.max >= m.min);
    inputs.download.disabled = empty;
    inputs.downloadParts.disabled = true;
    if (empty) {
      const text = m ? 'No land in this area.' : status;
      stats.replaceChildren(Object.assign(document.createElement('dt'), { textContent: text }));
      colors.replaceChildren();
      return;
    }
    const mm = (v) => v.toFixed(0);
    let seaRow = '';
    if (model.seaError) seaRow = '<dt>Sea</dt><dd>coastline didn’t load</dd>';
    else if (model.land) {
      const percent = Math.max(1, Math.round(model.seaShare * 100));
      seaRow = `<dt>Sea</dt><dd>${percent}% of the area${m.land ? ', cut off' : ''}</dd>`;
    }
    let liftRow = '';
    if (liftsOn) {
      const text = model.liftError ?? (m.lifts ? `raised ${m.liftHeight} mm` : 'none in area');
      liftRow = `<dt>Ski lifts</dt><dd>${text}</dd>`;
    }
    stats.innerHTML = `
      <dt>Area</dt><dd>${(m.widthM / 1000).toFixed(2)} × ${(m.depthM / 1000).toFixed(2)} km</dd>
      <dt>Model</dt><dd>${mm(m.width)} × ${mm(m.depth)} × ${mm(m.height)} mm</dd>
      <dt>Elevation</dt><dd>${Math.round(m.min)}–${Math.round(m.max)} m</dd>
      <dt>Terrain data</dt><dd>${m.demPixel.toFixed(1)} m grid</dd>
      ${seaRow}
      ${liftRow}`;
    const slices = lineSlices(m);
    let rows;
    if (contours.every) {
      const { every, color } = contours;
      const n = slices.length;
      const lo = slices[0]?.line.elevation;
      const hi = slices.at(-1)?.line.elevation;
      const where = !n ? 'none in area' : n === 1 ? `1 line, at ${lo} m` : `${n} lines, ${lo}–${hi} m`;
      // Then each line runs into the next, with no terrain colour between them.
      const tooClose = n > 1 && every * m.zPerM < readNumber(inputs.line) ? ', closer than the line height' : '';
      rows = [`<li style="--accent: ${color}">Every ${every} m: ${where}${tooClose}</li>`];
    } else {
      rows = printLines(m).map((line) => {
        const slice = slices.find((s) => s.line === line);
        const inside = line.elevation > m.min && line.elevation < m.max;
        const where = slice
          ? `<b>${slice.lo.toFixed(2)}–${slice.hi.toFixed(2)} mm</b>`
          : inside ? 'same height as the line below' : 'not in area';
        return `<li style="--accent: ${line.color}">${line.elevation} m: ${where}</li>`;
      });
    }
    colors.innerHTML = rows.length
      ? `<p>Contour lines, as parts in the ZIP:</p><ul>${rows.join('')}</ul>`
      : '<p>No contour lines chosen.</p>';
    inputs.downloadParts.disabled = !slices.length;
  }

  /** Runs a download task with the button showing progress, on the current model. */
  async function busy(button, task) {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Building…';
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the button repaint
    try {
      if (model) await task(measure()); // unless the area changed meanwhile
    } finally {
      button.textContent = label;
      render();
    }
  }

  // The whole model as one STL, for a single filament.
  function downloadStl() {
    return busy(inputs.download, (m) => {
      const stl = writeStl(buildBands({ ...model, ...m, raise: liftRaise(m), levels: [0] }), stlHeader(m));
      saveFile(new Blob([stl], { type: 'model/stl' }), `${fileName()}.stl`);
    });
  }

  const stlHeader = (m) => (m.land || m.lifts ? STL_HEADER_OSM : STL_HEADER);

  /** Per grid vertex, the mm the lifts raise the terrain by; null without lifts. */
  const liftRaise = ({ lifts, liftHeight }) => lifts && lifts.map((share) => share * liftHeight);

  // The model cut below and above each contour line: one STL for the terrain and one
  // per line (or one for all lines every N meters), which a slicer loads as parts of
  // one object, each with its filament.
  function downloadParts() {
    return busy(inputs.downloadParts, async (m) => {
      const slices = lineSlices(m);
      if (!slices.length) return; // the lines changed meanwhile
      // Band k runs from levels[k] up to the next level, and belongs to owners[k].
      const levels = [0];
      const owners = [null]; // null: the terrain
      for (const slice of slices) {
        if (slice.lo === levels.at(-1)) owners[owners.length - 1] = slice;
        else {
          levels.push(slice.lo);
          owners.push(slice);
        }
        levels.push(slice.hi);
        owners.push(null);
      }
      const bands = buildBands({ ...model, ...m, raise: liftRaise(m), levels });
      const lineFiles = [...new Set(slices.map(sliceFile))];
      const parts = [
        { name: 'terrain.stl', meshes: bands.filter((_, k) => !owners[k]) },
        ...lineFiles.map((name) => ({ name, meshes: bands.filter((_, k) => owners[k] && sliceFile(owners[k]) === name) })),
      ];
      const files = parts.map(({ name, meshes }) => ({ name, data: new Uint8Array(writeStl(meshes, stlHeader(m))) }));
      files.push({ name: 'README.txt', data: new TextEncoder().encode(readme(m, slices)) });
      saveFile(await zip(files), `${fileName()}.zip`);
    });
  }

  // The part a slice goes into: its own, or the one shared by all lines every N meters.
  const sliceFile = ({ line }) =>
    contours.every ? `contours-every-${contours.every}m-${line.name}.stl` : `contour-${line.elevation}m-${line.name}.stl`;

  function readme(m, slices) {
    const center = toLngLat((model.bounds.x0 + model.bounds.x1) / 2, (model.bounds.y0 + model.bounds.y1) / 2);
    const lineParts = contours.every
      ? [[sliceFile(slices[0]), `the ${contours.every} m contour lines from ${slices[0].line.elevation} to ${slices.at(-1).line.elevation} m`]]
      : slices.map((s) => [sliceFile(s), `${s.line.elevation} m contour line, ${s.lo.toFixed(2)} to ${s.hi.toFixed(2)} mm above the bed`]);
    const pad = Math.max(...lineParts.map(([file]) => file.length), 11) + 2;
    return [
      'TopoMap terrain model',
      `Center ${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}, area ${(m.widthM / 1000).toFixed(2)} x ${(m.depthM / 1000).toFixed(2)} km`,
      `Model ${m.width.toFixed(0)} x ${m.depth.toFixed(0)} x ${m.height.toFixed(0)} mm, scale 1:${Math.round(m.scale)}, height scale ${readNumber(inputs.exaggeration)}`,
      ...(m.land ? ['Cut off at the coastline, so only the land is printed.'] : []),
      ...(m.lifts ? [`Ski lifts: ridges ${m.liftHeight} mm high and ${LIFT_WIDTH_MM} mm wide, in the filament of the part around them.`] : []),
      '',
      'Parts:',
      `  ${'terrain.stl'.padEnd(pad)}the terrain, in your main filament`,
      ...lineParts.map(([file, text]) => `  ${file.padEnd(pad)}${text}`),
      '',
      'Bambu Studio:',
      '  1. Import all the .stl files at once (select them together).',
      '  2. Answer Yes to "Load these files as a single object with multiple parts?"',
      '  3. In the object list, choose a filament for each part.',
      `  4. Set the layer height to the line height, ${readNumber(inputs.line)} mm. Each line then prints`,
      '     as exactly one layer. A larger layer height can skip a line.',
      'The parts line up because they share coordinates.',
      '',
      'Elevation data: Mapterhorn and its sources, https://mapterhorn.com/attribution',
      ...(m.land || m.lifts ? ['Map data: (c) OpenStreetMap contributors, https://www.openstreetmap.org/copyright'] : []),
      '',
    ].join('\n');
  }

  function fileName() {
    const center = toLngLat((model.bounds.x0 + model.bounds.x1) / 2, (model.bounds.y0 + model.bounds.y1) / 2);
    return `terrain_${center.lat.toFixed(4)}_${center.lng.toFixed(4)}`;
  }

  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('input', (e) => {
    if (e.target.type === 'checkbox') save(`print.${e.target.name}`, e.target.checked);
    else if (Number.isFinite(e.target.valueAsNumber)) save(`print.${e.target.name}`, e.target.valueAsNumber);
    // Only the model size changes the sampling grid; the rest just rescales heights or
    // picks the terrain with or without the sea, both already sampled.
    if (SIZE_INPUTS.includes(e.target.name)) {
      sizeBy = e.target.name;
      save('print.sizeBy', sizeBy);
      showSize();
      scheduleUpdate();
    } else if (model) render();
  });
  inputs.download.addEventListener('click', downloadStl);
  inputs.downloadParts.addEventListener('click', downloadParts);

  return {
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      form.hidden = !on;
      if (on) {
        if (!bounds && isBounds(load('print.bounds'))) setBounds(load('print.bounds'));
        // Keep the area if it is in view, else start a new one there.
        const center = bounds && toLngLat((bounds.x0 + bounds.x1) / 2, (bounds.y0 + bounds.y1) / 2);
        if (!center || !map.getBounds().contains(center)) {
          setBounds(startBounds());
          scheduleUpdate();
        } else if (stale()) {
          scheduleUpdate();
        }
        placeHandles();
        for (const marker of [...corners, mover]) marker.addTo(map);
      } else {
        for (const marker of [...corners, mover]) marker.remove();
      }
    },
    /**
     * The contour lines to print: `{ lines }` with each line's `name`, `color` and
     * `elevation`, or `{ every, name, color }` for one every `every` meters, all in
     * one part. `name` (e.g. 'red') goes into the part file names.
     */
    setContours(value) {
      contours = structuredClone(value);
      if (model) render();
    },
    /** Whether the ski lifts stand out on the terrain, `lift` mm high (a panel input). */
    setLifts(on) {
      liftsOn = on;
      inputs.lift.closest('label').hidden = !on;
      if (!stale()) render();
      else if (enabled) scheduleUpdate(); // load them; or else when the panel opens
    },
  };
}

function isBounds(b) {
  const inRange = (v) => typeof v === 'number' && v >= 0 && v <= 1;
  return [b?.x0, b?.y0, b?.x1, b?.y1].every(inRange) && b.x0 < b.x1 && b.y0 < b.y1;
}

function saveFile(blob, name) {
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
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
