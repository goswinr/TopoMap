# TopoMap

https://goswinr.github.io/TopoMap/

> [!WARNING]
> 100% vibe coded


A 2D and 3D topographic web map built with [MapLibre GL JS](https://maplibre.org/) and open
terrain data from [Mapterhorn](https://mapterhorn.com/). It opens on the Matterhorn and is
made for exploring elevation: up to three contour lines you can move up and down (or one
every N meters), and roads that light up when they climb above a chosen height.

## Features

- **3D terrain** with neutral grey hillshading.
- **Contour lines**, chosen at the top left: **0–3** lines, each moved by its own vertical
  slider on the right (500–3500 m in 100 m steps), or a brown line **every N m** (a
  multiple of 100 m, up to 1000 m). The lines are added in the order blue (1500 m), red
  (2500 m), green (3500 m); the default is two.
- **Public roads** from OpenStreetMap.
- **Coastline**: the outline of the sea, from OpenStreetMap.
- **Switches** at the top left:
  - **Cities & villages**: place names (off by default).
  - **Summits**: peak names with their elevation (off by default).
  - **Roads above blue line**: roads above the blue line's height get a thick yellow
    outline, and all other roads turn grey (on by default). Needs the blue line, so it
    is disabled with 0 lines or every N m.
  - **3D print**: pick a rectangle on the map and download its terrain as STL for a
    slicer such as Bambu Studio, optionally with the contour lines as separate parts to
    print in their own colours, and cut off at the coastline (off by default). See
    [3D print export](#3d-print-export).

The current view is kept in the URL (`#zoom/lat/lng/bearing/pitch`), so a reload keeps
your place and a link opens the same view. All other settings (switches, contour heights,
3D terrain on or off, the 3D print panel and area) are remembered in the browser's local
storage, and so is the last view, which is used when the URL has none.

## Running it

Needs Node.js 20.19+ or 22.12+ (required by Vite 8).

```sh
npm install
npm run dev      # dev server with live reload at http://localhost:5173
npm run build    # static production build in dist/
npm run preview  # serve the production build locally
```

`dist/` is a plain static site that can be hosted anywhere. No API keys are needed: the
browser loads everything directly from the public services listed below.

## How it works

The whole map is client-side. [src/main.js](src/main.js) defines the MapLibre style inline
(sources and layers), and builds the sliders and switches.

### Data sources

| Data | Source | Notes |
|---|---|---|
| Elevation | [Mapterhorn](https://mapterhorn.com/data-access/) tiles | Terrarium-encoded 512 px WebP. Global to zoom 12, up to zoom 17 where high-resolution data exists. |
| Roads, coastline, place and summit names | [OpenFreeMap](https://openfreemap.org/) vector tiles | OpenStreetMap data in the [OpenMapTiles](https://openmaptiles.org/schema/) schema. The coastline is the outline of the `ocean` water polygons. |
| Label fonts | OpenFreeMap | Noto Sans glyphs. |

The same elevation tiles feed three things: the 3D terrain, the hillshade, and the
contour lines.

### Contour lines

No server provides contour lines. [maplibre-contour](https://github.com/onthegomap/maplibre-contour)
computes them in a web worker from the elevation tiles, as vector tiles with a line at every
100 m (`CONTOUR_STEP`). Each slider only changes which of those lines its layer shows (a
layer filter), so moving a slider doesn't recompute anything and responds immediately.

The elevation tiles are downloaded as you pan and cached in the worker. For speed,
contours are computed from somewhat coarser elevation data at medium zooms (`overzoom: 2`),
and from at most zoom-12 data.

### Roads above the blue line

A map style can't look up the terrain height under a road, so
[src/roads-above.js](src/roads-above.js) does it in JavaScript:

1. When the map stops moving, it takes the public roads in the loaded tiles.
2. It samples the elevation along each road, about once per elevation pixel, from the same
   tiles the contours use and at the same resolution. That way the highlight starts where
   the drawn blue line crosses the road.
3. It cuts out the stretches above the blue line's height, interpolating the exact crossing
   points, and draws them from a GeoJSON source.

Moving the blue slider only re-cuts the stored samples, so the highlight follows instantly.
Tunnels are skipped, since they run below the surface. A bridge counts as the ground
underneath it.

### 3D print export

The **3D print** switch puts a north-up rectangle on the map. Drag its corner handles to
resize it, and the center handle to move it. A corner keeps the rectangle square; hold
Ctrl or Shift while dragging it to change the proportions. The panel sets the model's
size as its longest side, its short side or its scale: the one edited last sets it, and
the other two follow the rectangle's shape, also while you drag it. It also sets a
height exaggeration, the base thickness below the lowest point and the contour line
height, and shows the resulting model size. Where the rectangle reaches the
sea, **Cut off at the coastline** (on by default) prints only the land: the base ends at
the coastline instead of covering the sea as a flat plate, and islands become separate
pieces. The panel shows how much of the area is sea. There are two downloads:

- **STL, one colour**: the whole model as one STL.
- **ZIP, coloured lines**: the model cut horizontally at each contour line and one line
  thickness above it. The slices are the lines (`contour-1500m-blue.stl` and so on, or
  all of them in one `contours-every-200m-brown.stl` with every N m), the rest is
  `terrain.stl`, plus a `README.txt` with the steps below. Each layer of the print
  then has a single colour, so the printer changes filament only at the lines.

To print the coloured lines in Bambu Studio, import all STL files from the ZIP at once,
answer Yes to "Load these files as a single object with multiple parts?", and pick a
filament for each part in the object list. The parts share coordinates, so they line up.
Set the layer height to the line height (0.2 mm by default): the slicer slices each
layer at its middle, so a line exactly one layer high always prints as exactly one layer,
wherever it starts. With a larger layer height a line can be skipped. A line shows on the
surface where the terrain crosses its height: wide on gentle slopes, narrow on steep ones
(a 0.2 mm line is 0.2 mm wide at 45° and 1.1 mm at 10°).

[src/print-area.js](src/print-area.js) samples the terrain on a 0.3 mm grid of the print
(`GRID_MM`, at most `MAX_GRID` samples per side), from the highest-resolution elevation
tiles that cover the whole rectangle. [src/coast.js](src/coast.js) reads the sea polygons
from the vector tiles at about the same resolution, and gives each grid point its
distance to the shore, positive on land and negative at sea.
[src/terrain-stl.js](src/terrain-stl.js) builds closed solids from the samples (terrain,
walls, and flat faces at the bottom and at each cut) and writes them as binary STL in
millimeters, with north pointing to the back of the bed. At the coast it cuts each grid
triangle where the distance crosses zero, so the coastline runs smoothly between grid
points and the walls follow it. The flat cut faces are triangulated with
[earcut](https://github.com/mapbox/earcut). A 150 mm square is about 25 MB of STL, and
the ZIP about half that.

### What counts as a public road

Motorways, trunk, primary, secondary, tertiary, minor and service roads, minus anything
tagged `access=private` or `access=no`. Tracks, footpaths and cycleways are left out. The
tiles don't carry more specific tags such as "no motor vehicles", so car-free streets
(Zermatt, for example) still appear.

## Project structure

```
index.html          page markup, slider and switch styles (all CSS lives here)
src/main.js         map setup: data sources, style layers, sliders, switches
src/roads-above.js  elevation sampling for the "roads above blue line" highlight
src/print-area.js   3D print area: map handles, export panel, downloads
src/coast.js        sea polygons from the vector tiles, distance to the shore
src/terrain-stl.js  elevation grid sampling, solids cut at heights and at the shore, STL writing
src/zip.js          ZIP writer for the coloured-lines download
src/settings.js     remembers the UI state in localStorage
```

## Customizing

Most settings are constants at the top of [src/main.js](src/main.js):

| Constant | Controls |
|---|---|
| `CONTOUR_STEP` | Spacing of the generated contours, and the slider step |
| `SLIDER_MIN`, `SLIDER_MAX` | Slider range |
| `SLIDER_TICK`, `SLIDER_MAJOR_TICK` | Tick label spacing, and which labels are bold |
| `CONTOUR_LINES` | Colour and starting height of each contour line (one slider per entry) |
| `EVERY_LINE` | Colour of the lines every N m |
| `ROADS_ABOVE_LINE` | Which contour line drives the road highlight |
| `SEA_CLASSES` | Which water polygons are outlined as coastline and cut off the 3D print (add `'lake'` for lakes) |
| `publicRoadFilter` | Which roads are shown |
| `ROAD_COLORS`, `MUTED_ROAD_COLORS`, `ROAD_HIGHLIGHT*` | Road colours and outline widths |

The start view (`center`, `zoom`, `pitch`, `bearing`) is set where the map is created.

A smaller `CONTOUR_STEP` gives finer slider control but more data: about 6–10 MB of contour
data per view at 10 m, against about 0.7 MB at 100 m.

## Attribution and licenses

- Terrain: © Mapterhorn and its [data sources](https://mapterhorn.com/attribution).
- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL),
  tiles by [OpenFreeMap](https://openfreemap.org/), schema © OpenMapTiles.
- [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js) and
  [maplibre-contour](https://github.com/onthegomap/maplibre-contour) are BSD-3-Clause;
  [earcut](https://github.com/mapbox/earcut) and [pbf](https://github.com/mapbox/pbf) are
  ISC; [@mapbox/vector-tile](https://github.com/mapbox/vector-tile-js) is BSD-3-Clause;
  [Vite](https://vite.dev/) is MIT.

The map shows the required data credits in its bottom-right corner automatically.
