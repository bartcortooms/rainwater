# Rain

Size a rainwater catchment + storage tank to carry a vegetable garden through the dry months — anywhere on earth.

**Live: <https://rainwater.hiccup.nl/>**

![Rain — sizing a rainwater system for a vegetable garden](screenshot.jpg)

## What it does

Type a town or full address, set garden / roof / tank sizes, and the app simulates whether the system would have carried a vegetable garden through each of the last five years at that location. It shows tank levels month-by-month, a roof × tank reliability frontier, and the monthly water balance.

In France, the address can also auto-fill the roof catchment area from the official building cadastre (IGN BD TOPO), with an interactive satellite map for picking a different building if the geocoder lands on the wrong house.

## How it works

**Climate.** Five years of daily rainfall and reference evapotranspiration (ET₀, FAO-56 Penman-Monteith) come from [Open-Meteo](https://open-meteo.com)'s ERA5 archive, fetched live for the chosen lat/lon.

**Crop water demand.** Monthly ET<sub>crop</sub> = ET₀ × K<sub>c</sub> with a density-corrected K<sub>c</sub> curve for a typical home potager (peak 0.90 in July, not the FAO-56 monoculture-at-full-canopy 1.05 — see [Pereira et al. 2021](https://repositorio.ulisboa.pt/bitstream/10400.5/21814/1/REP-LEAF-FAO-5-Pereira%20et%20al-2021.pdf)). Effective rainfall = min(rain × 0.85, ET<sub>crop</sub>) per FAO Bulletin 25 / USDA SCS for oceanic regimes.

**Practice toggles.** Heavy mulching (−30%, FAO-56 Ch. 10 + INRAE / Terre Vivante studies) and drip vs sprinkler/can (−20%) reduce demand multiplicatively.

**Roof yield.** monthly_rain × roof_area × 0.8 (runoff coefficient with first-flush loss).

**Simulation.** Two-pass tank balance per year, with steady-state warmup. Tank fills from the roof, drains to the garden, overflows when full, runs dry when empty. The verdict counts how many of the recent years finished without a shortfall.

**Roof footprint (France only).** Address geocoded via [BAN](https://adresse.data.gouv.fr/), then the IGN [BD TOPO](https://geoservices.ign.fr/bdtopo) WFS returns the building polygons within ~40 m. Footprint area is computed from the polygon (equirectangular projection — sub-1% error for buildings). The horizontal projection is exactly the catchment area for vertical rain — pitched roofs collect the same amount as their footprint.

## Stack

Plain HTML + CSS + vanilla JavaScript. No build step, no framework, no third-party JS at runtime. SVG charts and map are hand-rolled. The whole app is three files (~50 KB).

External APIs, all CORS-open and no key required:

- [Open-Meteo](https://open-meteo.com) — daily rain + ET₀ archive, worldwide geocoding
- [BAN](https://adresse.data.gouv.fr/) — French address geocoding (forward + reverse)
- [BigDataCloud](https://www.bigdatacloud.com/) — worldwide reverse geocoding fallback
- [IGN Géoplateforme](https://www.geopf.fr/) — BD TOPO building polygons (WFS) and ortho-photos (WMTS)
- [OpenStreetMap](https://www.openstreetmap.org/) — base map tiles
- [ipapi.co](https://ipapi.co/) — IP-based initial location

## Deployment

GitHub Pages serves the repo on `main` directly at <https://rainwater.hiccup.nl/> with auto-managed Let's Encrypt HTTPS. Pushing to `main` is the deploy — no workflow, no build step, no secrets. The `CNAME` file in the repo root binds the custom domain.

## Local development

```sh
python3 -m http.server 8765
# open http://127.0.0.1:8765/index.html
```

No build step. The live-reload edit/refresh cycle is instant.
