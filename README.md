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
  - **Ski lifts**: cable cars, gondolas, chair lifts and drag lifts as black lines, from
    zoom 12 on (off by default). The 3D print then raises them as ridges on the terrain.
  - **3D buildings**: buildings from the [GlobalBuildingAtlas](https://github.com/zhu-xlab/GlobalBuildingAtlas)
    as blocks of their height, standing on the terrain, from zoom 14 on (off by default).
    The 3D print then includes them too. See [3D buildings](#3d-buildings).
  - **3D print**: pick a rectangle on the map and download its terrain as STL for a
    slicer such as Bambu Studio, optionally with the contour lines as separate parts to
    print in their own colours, cut off at the coastline, and with the ski lifts as
    ridges and the buildings as blocks (off by default). See [3D print export](#3d-print-export).

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
| Roads, coastline, ski lifts, place and summit names | [OpenFreeMap](https://openfreemap.org/) vector tiles | OpenStreetMap data in the [OpenMapTiles](https://openmaptiles.org/schema/) schema. The coastline is the outline of the `ocean` water polygons; the ski lifts are the `aerialway` lines, from zoom 12 on. |
| Label fonts | OpenFreeMap | Noto Sans glyphs. |
| Buildings | [GlobalBuildingAtlas](https://github.com/zhu-xlab/GlobalBuildingAtlas) LoD1, as [GeoParquet on Source Cooperative](https://source.coop/tge-labs/globalbuildingatlas-lod1) | Footprints with heights of about 2.7 billion buildings worldwide, from OpenStreetMap, Microsoft and Google footprints and the authors' own detection; the heights are estimated from satellite images. CC BY-NC 4.0, so not for commercial use. |

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

### 3D buildings

No server provides the GlobalBuildingAtlas as map tiles, so
[src/buildings-worker.js](src/buildings-worker.js) reads it in a web worker straight from
its GeoParquet files. There is one file per 5° × 5° cell, up to 1.7 GB each, with the
buildings sorted along a space-filling curve in row groups of about 16000. A row group
thus covers a small area, and the statistics in the file's footer (about 2 MB) tell which
ones meet the area asked for. The worker fetches only those, and only their height and
outline columns (about 1 MB per row group), with HTTP range requests, and keeps the last
40 decoded ones. It serves them to the map as vector tiles at zoom 14, through a custom
protocol, so MapLibre decides which tiles to load and draws them as `fill-extrusion`.
The first view in a new 5° cell takes a few seconds; after that, tiles appear quickly.

Buildings show from zoom 14 on (`BUILDINGS_MINZOOM`): below that a view holds too many.
The heights are estimates, and many are under 2 m (sheds, or underestimated), so every
building stands at least 2 m high (`BUILDING_MIN_HEIGHT`). The data has gaps: around
Zermatt, for one (longitude 7.625–8°, latitude 45.8–46.2°), there are no buildings.

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
pieces. The panel shows how much of the area is sea. While the **Ski lifts** switch is
on, each lift becomes a ridge along its route, **Lift height** (0.4 mm by default) above
the terrain and 0.8 mm wide (`LIFT_WIDTH_MM`). The ridges are part of the terrain, so they
print in the filament of whatever is at their height: the terrain's, or a contour line's
where they cross it. While the **3D buildings** switch is on, the buildings become
flat-roofed blocks: each stands on the lowest ground under its outline, as high as the
building times the height scale. Like the lift ridges they are part of the terrain,
their walls slope over one grid cell, and a building that crosses a contour line's
height gets a band of the line's colour. Buildings narrower than about a grid cell
(0.3 mm on the print, 7.5 m at 1:25000) don't show. The panel shows how many are raised
and how high the tallest is. The area may hold at most 32 row groups of buildings, about
half a million buildings (`MAX_PRINT_GROUPS` in [src/buildings.js](src/buildings.js)).
There are two downloads:

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
distance to the shore, positive on land and negative at sea. [src/lifts.js](src/lifts.js)
reads the ski lifts from the vector tiles too, at zoom 12 or finer (so at most about
50 km across), and raises the grid points near them. The ridge's sides slope over one
grid cell, so its edges fall between the grid points rather than following them in steps.
[src/buildings.js](src/buildings.js) gets the buildings under the area from the same
worker as the map, and raises the grid points inside them the same way.
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
src/vector-tiles.js vector tiles under the print area, grid distances to their lines
src/coast.js        sea polygons from the vector tiles, distance to the shore
src/lifts.js        ski lifts from the vector tiles, raised as ridges on the print grid
src/buildings.js    building source for the map and the print, buildings raised on the print grid
src/buildings-worker.js  reads the GlobalBuildingAtlas GeoParquet files, makes vector tiles
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
| `LIFT_CLASSES` | Which aerialways count as ski lifts (material ropeways and zip lines are left out) |
| `BUILDINGS_MINZOOM` | Zoom from which the 3D buildings show |
| `BUILDING_MIN_HEIGHT` | Smallest building height, on the map and the print |
| `publicRoadFilter` | Which roads are shown |
| `ROAD_COLORS`, `MUTED_ROAD_COLORS`, `ROAD_HIGHLIGHT*` | Road colours and outline widths |

The start view (`center`, `zoom`, `pitch`, `bearing`) is set where the map is created.

A smaller `CONTOUR_STEP` gives finer slider control but more data: about 6–10 MB of contour
data per view at 10 m, against about 0.7 MB at 100 m.

## Attribution and licenses

- Terrain: © Mapterhorn and its [data sources](https://mapterhorn.com/attribution).
- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL),
  tiles by [OpenFreeMap](https://openfreemap.org/), schema © OpenMapTiles.
- Buildings: [GlobalBuildingAtlas](https://github.com/zhu-xlab/GlobalBuildingAtlas),
  Zhu et al. (2025), [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/),
  hosted as GeoParquet by Source Cooperative and the Taylor Geospatial Engine. The
  license rules out commercial use, such as selling prints that include the buildings.
- [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js) and
  [maplibre-contour](https://github.com/onthegomap/maplibre-contour) are BSD-3-Clause;
  [earcut](https://github.com/mapbox/earcut) and [pbf](https://github.com/mapbox/pbf) are
  ISC; [@mapbox/vector-tile](https://github.com/mapbox/vector-tile-js) is BSD-3-Clause;
  [hyparquet](https://github.com/hyparam/hyparquet), [fzstd](https://github.com/101arrowz/fzstd)
  and [Vite](https://vite.dev/) are MIT.

The map shows the required data credits in its bottom-right corner automatically.
