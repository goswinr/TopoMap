import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre v6 is ESM-only; under a bundler the worker URL must be set explicitly.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import mlcontour from 'maplibre-contour'; // default export only
import { createRoadsAboveHighlight } from './roads-above.js';

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
const CONTOUR_LINES = [
  { id: 'contour-1', color: '#c1121f', elevation: 2500 },
  { id: 'contour-2', color: '#1d4ed8', elevation: 1500 },
];

// Roads above this line's elevation can be highlighted.
const ROADS_ABOVE_LINE = CONTOUR_LINES[1]; // blue

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

const map = new maplibregl.Map({
  container: 'map',
  hash: true, // keep the view in the URL so it survives reloads
  center: [7.6586, 45.9763], // Matterhorn
  zoom: 12.5,
  pitch: 60,
  bearing: -120,
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
      ...CONTOUR_LINES.map((line) => ({
        id: line.id,
        type: 'line',
        source: 'contours',
        'source-layer': 'contours',
        filter: contourFilter(line.elevation),
        layout: { 'line-join': 'round' },
        paint: {
          'line-color': line.color,
          'line-width': 3,
        },
      })),
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
    terrain: { source: 'terrain', exaggeration: 1 },
    sky: {},
  },
});

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

function setLayerVisible(layerId, on) {
  map.setLayoutProperty(layerId, 'visibility', on ? 'visible' : 'none');
}

// Toggle switches. Their initial state is the checkboxes' `checked` in index.html.
const TOGGLES = {
  'toggle-places': (on) => setLayerVisible('place-labels', on),
  'toggle-summits': (on) => setLayerVisible('summit-labels', on),
  'toggle-roads-above': (on) => {
    const colors = on ? MUTED_ROAD_COLORS : ROAD_COLORS;
    map.setPaintProperty('road', 'line-color', colors.fill);
    map.setPaintProperty('road-casing', 'line-color', colors.casing);
    setLayerVisible('roads-above-edge', on);
    setLayerVisible('roads-above', on);
    roadsAbove.setEnabled(on);
  },
};

for (const [inputId, apply] of Object.entries(TOGGLES)) {
  const input = document.getElementById(inputId);
  input.addEventListener('change', () => apply(input.checked));
}
// style.load fires before the first frame is drawn, so the initial state doesn't flash.
map.once('style.load', () => {
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

CONTOUR_LINES.forEach((line, i) => {
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
  slider.setAttribute('aria-label', `Contour line ${i + 1} elevation in meters`);
  readout.className = 'contour-value';
  readout.textContent = `${line.elevation} m`;
  for (const el of [readout, slider]) {
    el.style.gridColumn = i + 2; // column 1 holds the ticks
    el.style.setProperty('--accent', line.color);
  }

  slider.addEventListener('input', () => {
    readout.textContent = `${slider.value} m`;
    map.setFilter(line.id, contourFilter(slider.valueAsNumber));
    if (line === ROADS_ABOVE_LINE) roadsAbove.setElevation(slider.valueAsNumber);
  });
  panel.append(readout, slider);
});
