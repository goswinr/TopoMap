import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre v6 is ESM-only; under a bundler the worker URL must be set explicitly.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import mlcontour from 'maplibre-contour'; // default export only
import { createRoadsAboveHighlight } from './roads-above.js';
import { createPrintArea } from './print-area.js';
import { load, loadNumber, save } from './settings.js';

maplibregl.setWorkerUrl(workerUrl);

// Mapterhorn: open, global terrain tiles (Terrarium-encoded, 512px WebP).
// The TileJSON supplies the tile URL, encoding, tile size and attribution.
const MAPTERHORN_TILEJSON = 'https://tiles.mapterhorn.com/tilejson.json';

// Contours are pre-generated at every CONTOUR_STEP meters, and each slider only
// changes which one its layer shows (a filter), so moving it needs no regeneration.
// Smaller steps mean finer slider control but heavier tiles (data grows ~1/step;
// a 10 m step was ~6-10 MB per view).
const CONTOUR_STEP = 100; // meters
const SLIDER_MIN = 500;
const SLIDER_MAX = 3500;
const SLIDER_TICK = 100;
const SLIDER_MAJOR_TICK = 500; // drawn bold; minor ticks hide on short screens

// One line layer and one slider per entry, all sharing the same contour tiles.
// With fewer lines chosen, the first ones show; blue comes first because the road
// highlight follows it. `name` labels the line's part in the 3D print export.
// `elevation` is the default; the last slider position, if saved, replaces it below.
const CONTOUR_LINES = [
  { id: 'contour-blue', name: 'blue', color: '#1d4ed8', elevation: 1500 },
  { id: 'contour-red', name: 'red', color: '#c1121f', elevation: 2500 },
  { id: 'contour-green', name: 'green', color: '#15803d', elevation: 3500 },
];
for (const line of CONTOUR_LINES) {
  // Snapped onto the generated contour steps, which the layer filters match exactly.
  const saved = Math.round(loadNumber(`contour.${line.id}`, line.elevation) / CONTOUR_STEP) * CONTOUR_STEP;
  line.elevation = Math.min(Math.max(saved, SLIDER_MIN), SLIDER_MAX);
}

// Instead of the lines above: one line every N meters, all in this colour.
const EVERY_LINE = { id: 'contour-every', name: 'brown', color: '#7c4a1d' };

// Roads above this line's elevation can be highlighted.
const ROADS_ABOVE_LINE = CONTOUR_LINES[0]; // blue

// Roads and labels: OpenStreetMap vector tiles (OpenMapTiles schema) and fonts
// from OpenFreeMap, free and keyless.
const OPENFREEMAP_TILEJSON = 'https://tiles.openfreemap.org/planet';
const OPENFREEMAP_GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';

const labelHalo = {
  'text-halo-color': 'rgb(255 255 255 / 0.9)',
  'text-halo-width': 2,
};

// "Public" = drivable road classes (no tracks or footpaths), minus roads tagged
// access=private/no, which OpenMapTiles folds into access: 'no'.
const publicRoadFilter = [
  'all',
  ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false],
  ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service'], true, false],
  ['!=', ['get', 'access'], 'no'],
];

const roadClassWidth = [
  'match', ['get', 'class'],
  ['motorway', 'trunk'], 3,
  ['primary', 'secondary'], 2.5,
  'tertiary', 2,
  1.5, // minor, service
];

// Road width by class and zoom, plus `extra` px (at zooms 8, 12, 16) for outlines.
const ROAD_FILL = [0, 0, 0];
const ROAD_CASING = [0.5, 1.5, 3];
const ROAD_HIGHLIGHT = [2, 4, 8]; // yellow outline of roads above the blue line
const ROAD_HIGHLIGHT_EDGE = [3, 5.5, 10.5]; // thin dark rim around the yellow

function roadWidth([e8, e12, e16]) {
  return [
    'interpolate', ['exponential', 1.6], ['zoom'],
    8, ['+', e8, ['*', 0.3, roadClassWidth]],
    12, ['+', e12, roadClassWidth],
    16, ['+', e16, ['*', 4, roadClassWidth]],
  ];
}

// Roads turn grey while the roads-above highlight is on, so the highlight stands out.
const ROAD_COLORS = {
  fill: [
    'match', ['get', 'class'],
    ['motorway', 'trunk'], '#f4a259',
    ['primary', 'secondary'], '#ffd166',
    '#ffffff',
  ],
  casing: '#4a3f35',
};
const MUTED_ROAD_COLORS = { fill: '#b8b8b8', casing: '#6e6e6e' };

// Tunnels are drawn faintly, since they would otherwise appear on the terrain surface.
const roadOpacity = ['case', ['==', ['get', 'brunnel'], 'tunnel'], 0.3, 1];

// Generates contour-line vector tiles in the browser from the DEM tiles.
// maxzoom 12 is the highest zoom Mapterhorn covers globally; contours are
// overzoomed beyond that.
const contourDem = new mlcontour.DemSource({
  url: 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp',
  encoding: 'terrarium',
  maxzoom: 12,
  worker: true,
});
contourDem.setupMaplibre(maplibregl);

// The view lives in the URL hash, so links keep it. Without a hash, reopen the last
// view, or else the Matterhorn.
const START_VIEW = { center: [7.6586, 45.9763], zoom: 12.5, pitch: 60, bearing: -120 };
const savedView = location.hash ? undefined : load('view');
const isView = (v) =>
  [v?.center?.[0], v?.center?.[1], v?.zoom, v?.pitch, v?.bearing].every(Number.isFinite);

const map = new maplibregl.Map({
  container: 'map',
  hash: true, // keep the view in the URL so it survives reloads
  ...(isView(savedView) ? savedView : START_VIEW),
  style: {
    version: 8,
    glyphs: OPENFREEMAP_GLYPHS,
    sources: {
      // Separate DEM sources for 3D terrain and for hillshade;
      // sharing one source degrades hillshade quality.
      terrain: { type: 'raster-dem', url: MAPTERHORN_TILEJSON },
      dem: { type: 'raster-dem', url: MAPTERHORN_TILEJSON },
      openmaptiles: { type: 'vector', url: OPENFREEMAP_TILEJSON },
      'roads-above': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      'print-area': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      contours: {
        type: 'vector',
        tiles: [
          contourDem.contourProtocolUrl({
            thresholds: { 0: CONTOUR_STEP },
            elevationKey: 'ele',
            contourLayer: 'contours',
            overzoom: 2,
          }),
        ],
        maxzoom: 17,
      },
    },
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': '#f5f5f5' },
      },
      {
        id: 'hillshade',
        type: 'hillshade',
        source: 'dem',
        paint: {
          // Neutral grey shading only; no elevation tint.
          'hillshade-shadow-color': '#000000',
          'hillshade-highlight-color': '#ffffff',
          'hillshade-accent-color': '#000000',
          'hillshade-exaggeration': 0.6,
        },
      },
      {
        id: 'road-casing',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'transportation',
        filter: publicRoadFilter,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ROAD_COLORS.casing,
          'line-width': roadWidth(ROAD_CASING),
          'line-opacity': roadOpacity,
        },
      },
      // Roads above the blue line (filled by createRoadsAboveHighlight): a thick
      // yellow outline with a dark rim, between the road casing and its fill.
      {
        id: 'roads-above-edge',
        type: 'line',
        source: 'roads-above',
        layout: { visibility: 'none', 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#2b2200',
          'line-width': roadWidth(ROAD_HIGHLIGHT_EDGE),
          'line-opacity': 0.8,
        },
      },
      {
        id: 'roads-above',
        type: 'line',
        source: 'roads-above',
        layout: { visibility: 'none', 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#ffd000',
          'line-width': roadWidth(ROAD_HIGHLIGHT),
        },
      },
      {
        id: 'road',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'transportation',
        filter: publicRoadFilter,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ROAD_COLORS.fill,
          'line-width': roadWidth(ROAD_FILL),
          'line-opacity': roadOpacity,
        },
      },
      // Contour lines; applyContourMode() shows the chosen ones.
      {
        id: EVERY_LINE.id,
        type: 'line',
        source: 'contours',
        'source-layer': 'contours',
        layout: { visibility: 'none', 'line-join': 'round' },
        paint: {
          'line-color': EVERY_LINE.color,
          'line-width': 1.5,
        },
      },
      ...CONTOUR_LINES.map((line) => ({
        id: line.id,
        type: 'line',
        source: 'contours',
        'source-layer': 'contours',
        filter: contourFilter(line.elevation),
        layout: { visibility: 'none', 'line-join': 'round' },
        paint: {
          'line-color': line.color,
          'line-width': 3,
        },
      })),
      // 3D print area (filled by createPrintArea): the outside shaded, and an outline.
      {
        id: 'print-area-mask',
        type: 'fill',
        source: 'print-area',
        filter: ['==', ['geometry-type'], 'Polygon'],
        layout: { visibility: 'none' },
        paint: { 'fill-color': '#000000', 'fill-opacity': 0.3 },
      },
      {
        id: 'print-area-outline',
        type: 'line',
        source: 'print-area',
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { visibility: 'none', 'line-join': 'round' },
        paint: { 'line-color': '#111111', 'line-width': 2 },
      },
      {
        id: 'place-labels',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'place',
        filter: ['match', ['get', 'class'], ['city', 'town', 'village', 'hamlet'], true, false],
        layout: {
          visibility: 'none',
          'text-field': ['get', 'name'],
          'text-font': [
            'match', ['get', 'class'],
            ['city', 'town'], ['literal', ['Noto Sans Bold']],
            ['literal', ['Noto Sans Regular']],
          ],
          'text-size': ['match', ['get', 'class'], 'city', 18, 'town', 15, 'village', 13, 11],
          'text-max-width': 8,
          // Bigger places win label collisions.
          'symbol-sort-key': ['match', ['get', 'class'], 'city', 0, 'town', 1, 'village', 2, 3],
        },
        paint: { 'text-color': '#111', ...labelHalo },
      },
      {
        id: 'summit-labels',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'mountain_peak',
        filter: ['all', ['match', ['get', 'class'], ['peak', 'volcano'], true, false], ['has', 'name']],
        layout: {
          visibility: 'none',
          // ▲ on the summit, then the name and elevation below it.
          'text-field': [
            'format',
            '▲\n', { 'font-scale': 0.8 },
            ['get', 'name'], {},
            ['case', ['has', 'ele'], ['concat', '\n', ['to-string', ['get', 'ele']], ' m'], ''],
            { 'font-scale': 0.85, 'text-font': ['literal', ['Noto Sans Regular']] },
          ],
          'text-font': ['Noto Sans Italic'],
          'text-size': 13,
          'text-anchor': 'top',
          'text-offset': [0, -0.55],
          'text-max-width': 8,
          // Higher summits win label collisions.
          'symbol-sort-key': ['-', 0, ['coalesce', ['get', 'ele'], 0]],
        },
        paint: { 'text-color': '#2b1d0e', ...labelHalo },
      },
    ],
    // 3D terrain unless it was switched off last time (TerrainControl).
    ...(load('terrain') === false ? {} : { terrain: { source: 'terrain', exaggeration: 1 } }),
    sky: {},
  },
});

map.on('moveend', () => {
  save('view', { center: map.getCenter().toArray(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() });
});
map.on('terrain', () => save('terrain', Boolean(map.getTerrain())));

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }));
map.addControl(new maplibregl.TerrainControl({ source: 'terrain', exaggeration: 1 }));
map.addControl(new maplibregl.ScaleControl(), 'bottom-left');

function contourFilter(elevation) {
  return ['==', ['get', 'ele'], elevation];
}

const roadsAbove = createRoadsAboveHighlight(map, {
  demSource: contourDem,
  // The DEM resolution the contour tiles use near this zoom (maxzoom 12, overzoom 2),
  // so a highlight starts where the contour line crosses the road.
  demZoom: () => Math.max(0, Math.min(12, Math.floor(map.getZoom()) - 2)),
  roads: {
    sourceId: 'openmaptiles',
    sourceLayer: 'transportation',
    // Tunnels run below the surface, so the terrain elevation doesn't apply.
    filter: ['all', publicRoadFilter, ['!=', ['get', 'brunnel'], 'tunnel']],
  },
  targetSourceId: 'roads-above',
  elevation: ROADS_ABOVE_LINE.elevation,
});

const printArea = createPrintArea(map, {
  demSource: contourDem,
  sourceId: 'print-area',
  form: document.getElementById('print-panel'),
});

function setLayerVisible(layerId, on) {
  map.setLayoutProperty(layerId, 'visibility', on ? 'visible' : 'none');
}

// Toggle switches. Their initial state is the last one used, or else the checkboxes'
// `checked` in index.html.
const TOGGLES = {
  'toggle-places': (on) => setLayerVisible('place-labels', on),
  'toggle-summits': (on) => setLayerVisible('summit-labels', on),
  'toggle-roads-above': (on) => {
    on &&= shownLines().includes(ROADS_ABOVE_LINE); // only while its line is on the map
    const colors = on ? MUTED_ROAD_COLORS : ROAD_COLORS;
    map.setPaintProperty('road', 'line-color', colors.fill);
    map.setPaintProperty('road-casing', 'line-color', colors.casing);
    setLayerVisible('roads-above-edge', on);
    setLayerVisible('roads-above', on);
    roadsAbove.setEnabled(on);
  },
  'toggle-print': (on) => {
    setLayerVisible('print-area-mask', on);
    setLayerVisible('print-area-outline', on);
    printArea.setEnabled(on);
  },
};

for (const [inputId, apply] of Object.entries(TOGGLES)) {
  const input = document.getElementById(inputId);
  const saved = load(`switch.${inputId}`);
  if (typeof saved === 'boolean') input.checked = saved;
  input.addEventListener('change', () => {
    apply(input.checked);
    save(`switch.${inputId}`, input.checked);
  });
}
// style.load fires before the first frame is drawn, so the initial state doesn't flash.
map.once('style.load', () => {
  applyContourMode();
  for (const [inputId, apply] of Object.entries(TOGGLES)) apply(document.getElementById(inputId).checked);
});

// Contour elevation sliders: a shared tick column, then a readout + slider per line.
const panel = document.getElementById('contour-panel');
const ticks = document.getElementById('contour-ticks');

for (let v = SLIDER_MIN; v <= SLIDER_MAX; v += SLIDER_TICK) {
  const tick = document.createElement('span');
  tick.textContent = v;
  if (v % SLIDER_MAJOR_TICK) tick.className = 'minor';
  tick.style.setProperty('--f', (v - SLIDER_MIN) / (SLIDER_MAX - SLIDER_MIN));
  ticks.append(tick);
}

// Built once per line; applyContourMode() puts the shown ones into the panel.
const sliders = new Map(CONTOUR_LINES.map((line) => {
  const readout = document.createElement('output');
  const slider = document.createElement('input');
  Object.assign(slider, {
    type: 'range',
    className: 'contour-slider',
    min: SLIDER_MIN,
    max: SLIDER_MAX,
    step: CONTOUR_STEP,
    value: line.elevation,
  });
  slider.setAttribute('aria-label', `Elevation of the ${line.name} contour line in meters`);
  readout.className = 'contour-value';
  readout.textContent = `${line.elevation} m`;
  for (const el of [readout, slider]) el.style.setProperty('--accent', line.color);

  slider.addEventListener('input', () => {
    line.elevation = slider.valueAsNumber;
    readout.textContent = `${line.elevation} m`;
    map.setFilter(line.id, contourFilter(line.elevation));
    if (line === ROADS_ABOVE_LINE) roadsAbove.setElevation(line.elevation);
    printArea.setContours(printContours());
    save(`contour.${line.id}`, line.elevation);
  });
  return [line, [readout, slider]];
}));

// Which contour lines show: the first 0-3 of CONTOUR_LINES, each with its slider, or
// one every N meters. Initially the last choice, else the form's state in index.html.
const modeForm = document.getElementById('contour-mode');
const { mode: modeInput, every: everyInput } = modeForm.elements;
const savedMode = load('contour.mode');
if (typeof savedMode === 'string') modeInput.value = savedMode; // no-op unless a radio has it
const savedEvery = loadNumber('contour.every');
if (savedEvery !== undefined) everyInput.value = savedEvery;
everyInput.value = everyMeters(); // snapped and in range

/** The contour lines with a slider; none while lines every N meters show. */
function shownLines() {
  return modeInput.value === 'every' ? [] : CONTOUR_LINES.slice(0, Number(modeInput.value));
}

/** The interval for lines every N meters: a multiple of CONTOUR_STEP, within the input's range. */
function everyMeters() {
  const v = Math.round(everyInput.valueAsNumber / CONTOUR_STEP) * CONTOUR_STEP;
  if (!Number.isFinite(v)) return Number(everyInput.defaultValue);
  return Math.min(Math.max(v, Number(everyInput.min)), Number(everyInput.max));
}

/** The shown contour lines, as the 3D print export takes them. */
function printContours() {
  return modeInput.value === 'every' ? { ...EVERY_LINE, every: everyMeters() } : { lines: shownLines() };
}

function applyContourMode() {
  const every = modeInput.value === 'every';
  const lines = shownLines();
  setLayerVisible(EVERY_LINE.id, every);
  map.setFilter(EVERY_LINE.id, ['==', ['%', ['get', 'ele'], everyMeters()], 0]);
  for (const line of CONTOUR_LINES) setLayerVisible(line.id, lines.includes(line));
  everyInput.closest('label').hidden = !every;

  // Sliders from right to left, so the first line keeps its place at the screen edge.
  panel.hidden = !lines.length;
  panel.replaceChildren(ticks, ...lines.flatMap((line, i) => {
    const els = sliders.get(line);
    for (const el of els) el.style.gridColumn = lines.length + 1 - i; // column 1 holds the ticks
    return els;
  }));

  const roadsInput = document.getElementById('toggle-roads-above');
  roadsInput.disabled = !lines.includes(ROADS_ABOVE_LINE);
  roadsInput.closest('label').title = roadsInput.disabled ? 'Needs the blue contour line' : '';
  printArea.setContours(printContours());
}

modeForm.addEventListener('submit', (e) => e.preventDefault());
modeForm.addEventListener('input', () => {
  applyContourMode();
  TOGGLES['toggle-roads-above'](document.getElementById('toggle-roads-above').checked);
  save('contour.mode', modeInput.value);
  save('contour.every', everyMeters());
});
// Once typing is done, show the interval actually used.
everyInput.addEventListener('change', () => {
  everyInput.value = everyMeters();
});
