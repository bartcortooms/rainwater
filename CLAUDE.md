# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Static web app at <https://rainwater.hiccup.nl/> that sizes a rainwater catchment + tank for a vegetable garden anywhere on earth, using live climate data from Open-Meteo and (in France) auto-detected roof footprints from IGN BD TOPO. See README.md for the user-facing description and the data-source list.

## Stack

Plain HTML + CSS + vanilla JS, no build step, no runtime dependencies, no framework. Three files: `index.html`, `styles.css`, `app.js`. SVG charts and the map are hand-rolled. **Edit a file and refresh — that's the entire dev loop.**

## Common commands

```sh
python3 -m http.server 8765   # serve locally; open http://127.0.0.1:8765/index.html
node --check app.js           # syntax check (no test runner)
```

There are no tests, lint, or build steps. The browser is the test runner — use Chrome DevTools / MCP to verify charts render and the map interaction works after non-trivial changes.

## Deployment

GitHub Pages serves `main` directly at `https://rainwater.hiccup.nl/`. **Pushing to `main` is the deploy** — there's no workflow, no build step, no secrets. The `CNAME` file at the repo root binds the custom domain; remove or change it only if the domain itself changes. HTTPS is required for `navigator.geolocation` to work, which is why we're on Pages and not the GCS bucket-CNAME setup.

The old GCS deploy path is intentionally gone. Keep DNS pointing `rainwater.hiccup.nl` to `bartcortooms.github.io`, and do not add back a GitHub Actions deploy secret or bucket sync unless the hosting strategy changes.

## Architecture

Everything lives in `app.js` at module scope. The orchestrator is `applyLocation(loc, opts)` — it sets state, fetches climate, recomputes, and (when `opts.detectRoof` is true and the location is address-level in France) kicks off the roof auto-detect. `recompute()` re-runs the simulation and re-renders all four output panels (verdict, tank chart, balance chart, heatmap) any time inputs change.

`resolveLocation(query)` is the unified search: BAN (`api-adresse.data.gouv.fr`) for French addresses with score ≥ 0.4, falling back to Open-Meteo's worldwide geocoding for everywhere else. `reverseGeocode(lat, lon)` is the inverse: BAN reverse for France, BigDataCloud globally. The "Use my precise location" button calls `navigator.geolocation` with `enableHighAccuracy: true` — this **requires HTTPS** in browsers (works on `localhost` for dev).

The interactive roof map (`setupRoofMap` / `renderRoofMap`) layers OSM XYZ tiles always, IGN ortho-photo tiles on top in `satellite` mode. Building polygons come from the IGN BD TOPO WFS (`fetchRoofMapBuildings`), cached in `roofMap.buildings` keyed by `cleabs`, refetched on pan/zoom only when the loaded bbox no longer covers the view.

## Non-obvious gotchas

These are bug fixes that took time to find — don't reintroduce them:

1. **SVG image rendering breaks at huge coordinates.** Chrome's SVG renderer silently drops `<image>` elements when their `x`/`y` are around 10⁸ (tile-pixel space at z19). The roof map uses a **local viewport coordinate system** (viewBox `0 0 w h`) and translates each tile and polygon relative to the view center every render. Don't be tempted to "simplify" by using tile-pixel coords directly.

2. **`setPointerCapture` re-targets click events.** Calling it on the SVG in `pointerdown` makes subsequent `click` events fire on the SVG instead of the polygon under the cursor — clicks on buildings stop selecting. Pan tracking uses `document`-level `pointermove`/`pointerup` listeners attached per drag, with `roofMap.suppressNextClick` set when the drag actually moved.

3. **WFS bbox axis order.** The IGN Géoplateforme WFS expects `srsname=urn:ogc:def:crs:OGC:1.3:CRS84` and `bbox=lon,lat,lon,lat,urn:ogc:def:crs:OGC:1.3:CRS84`. With `EPSG:4326` it silently returns zero features because of axis-order ambiguity.

4. **Roof footprint = catchment area.** Don't add a slope correction for pitched roofs. Rain falls vertically, so the horizontal projection (which the cadastre/BD TOPO polygon gives) is exactly what we want.

5. **Geolocation requires HTTPS.** `navigator.geolocation.getCurrentPosition` only works on secure contexts (HTTPS or `localhost`). The site lives on Pages specifically because GCS bucket-CNAME hosting is HTTP-only.

## Hydrology model

Calibrated for a typical home potager, not commercial monoculture — the values come with citations in `app.js` and the README's "How it works". The constants live at the top of `app.js`:

- `KC_NORTH` — density-corrected K<sub>c</sub> curve (peak **0.90** in July, not the FAO-56 textbook 1.05). Mirrored 6 months for southern hemisphere, interpolated daily between month midpoints (`kcAt`).
- `SOIL_RAW = 25` — mm of readily-available water in the root zone. This bucket **is** the effective-rainfall model: rain tops it up, excess percolates away, irrigation replaces whatever ET empties. Don't reintroduce a flat effective-rain fraction on top of it — that would double-count.
- `MULCH_FACTOR = 0.75` — ET reduction from heavy mulch (FAO-56 Ch. 10; Mao et al. 2024). Applied to total ETc, so mulch also stretches rain, not just irrigation.
- `APP_EFF_DRIP = 0.90`, `APP_EFF_HAND = 0.75` — application efficiencies; gross tank draw = net deficit ÷ efficiency.
- `RUNOFF = 0.8` — roof runoff coefficient including first-flush loss.
- `CLIMATE_YEARS = 10` — complete calendar years simulated; the current partial year is chained on top, drawn as the gold "so far" line, and excluded from verdict counts (`r.partial`).

**The time step is daily, deliberately.** The model used to be monthly; that combination (monthly yield-after-spillage) systematically understates what a small, frequently-refilling tank delivers (Fewkes & Butler 2000; Mitchell 2007) while monthly rain-vs-ET netting understates demand. The old constants were tuned down partly to mask that structural bias. Don't "simplify" back to monthly aggregation, and don't retune constants without re-running the real-world calibration anchors: peak dry-week gross demand should land ~40–65 L/m²/wk unmitigated in a canicule (French guides: 20–30, doubled in heatwave), daily dry-spell draw with mulch+drip ~4–5 L/m²/day (mon-potager-en-carre.fr calculator: 3–6), and a 1,000 L tank on a ~30 m² Nantes potager should read "fine in wet years, fails in 2022-style droughts" (matches aujardin.org witness reports).

## When verifying changes in the browser

Reload with `ignoreCache: true` between tests — the local server doesn't send no-cache for assets. After a location change, wait for **both** climate data and (in France) BD TOPO/ortho tiles before screenshotting; the IGN tiles are slower than OSM and will look unrendered for ~1 second.
