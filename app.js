/* ─────────────── Constants & state ─────────────── */

// Vegetable-garden crop coefficient by month (Jan…Dec).
// Northern hemisphere: planting in March, harvest by October. We mirror it
// for the southern hemisphere when the location is below the equator.
//
// Values are density-corrected for a typical home potager — the FAO-56 single-Kc
// table assumes monoculture at full canopy (peak ~1.05); home gardens have
// fractional ground cover, paths, staggered plantings, and just-harvested beds,
// so the seasonal-average Kc runs ~15–20% lower (Pereira et al. 2021).
const KC_NORTH = [0, 0, 0.35, 0.60, 0.75, 0.85, 0.90, 0.85, 0.60, 0.40, 0, 0];
const RUNOFF = 0.8;          // fraction of rain leaving the roof as usable water
const SOIL_RAW = 25;         // mm of readily-available water in the veg root zone
                             // (FAO-56: ~0.3 m rooting depth × 0.14 AWC × p ≈ 0.55).
                             // Rain tops this bucket up, excess percolates past the
                             // roots — effective rainfall emerges from the bucket
                             // instead of a flat monthly fraction.
const MULCH_FACTOR = 0.75;   // 25% ET cut — heavy organic mulch halves soil evap,
                             // which is ~25–40% of ETc for row crops (FAO-56 Ch. 10;
                             // Mao et al. 2024 review). Applied to total ETc.
const APP_EFF_DRIP = 0.90;   // application efficiency, drip (USDA-ARS 90–95%)
const APP_EFF_HAND = 0.75;   // application efficiency, watering can / sprinkler (65–75%)
const MAINS_EUR_PER_M3 = 4;   // assumed mains tariff for the “cost to bridge” estimate;
                             // stated as an assumption in the copy, not a lookup
const MAX_PRACTICAL_TANK = 50000;  // L — above this it is a buried cistern, not a tank,
                                   // so we stop calling extra storage a real option
const CLIMATE_YEARS = 10;    // complete years simulated; the current partial year
                             // is chained on top and drawn as "so far"

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const state = {
  location: null,    // { name, country, admin, lat, lon }
  climate: null,     // { years, avgMonthly, annualRain, peakEt, driestIdx, kc }
  gardenSize: 70,
  roofSize: 100,
  tankSize: 10000,
  mulch: true,
  drip: true,
  dryYear: false,
};

const $ = id => document.getElementById(id);

/* ─────────────── Formatting ─────────────── */

const fmt0 = n => Math.round(n).toLocaleString('en-US');
const fmtL = n => fmt0(n) + ' L';
const fmtMM = n => fmt0(n) + ' mm';
const fmtKL = n => {
  const r = Math.round(n);
  if (r >= 10000) return (r / 1000).toFixed(1).replace(/\.0$/, '') + 'k L';
  return r.toLocaleString('en-US') + ' L';
};

/* ─────────────── Geolocation ─────────────── */

async function detectLocation() {
  // Try IP-based geolocation first — no permission prompt.
  try {
    const res = await fetch('https://ipapi.co/json/');
    if (res.ok) {
      const d = await res.json();
      if (d.latitude && d.longitude) {
        return {
          name: d.city || d.region || 'Unknown',
          country: d.country_name || '',
          admin: d.region || '',
          lat: +d.latitude,
          lon: +d.longitude,
        };
      }
    }
  } catch (e) { /* fall through */ }
  // Sensible default — user's example location
  return { name: 'Monnières', country: 'France', admin: 'Loire-Atlantique', lat: 47.16, lon: -1.39 };
}

async function searchLocations(query) {
  if (!query || query.length < 2) return [];
  try {
    const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=6&language=en&format=json`);
    if (!res.ok) return [];
    const d = await res.json();
    return (d.results || []).map(r => ({
      name: r.name,
      country: r.country || '',
      admin: r.admin1 || '',
      lat: r.latitude,
      lon: r.longitude,
    }));
  } catch (e) { return []; }
}

/* ─────────────── Climate fetch & aggregation ─────────────── */

async function fetchClimate(lat, lon) {
  const now = new Date();
  // ERA5 archive lags ~6 days. Fetch the last CLIMATE_YEARS complete calendar
  // years plus the current year up to the archive edge.
  const endDate = new Date(now.getTime() - 6 * 86400e3);
  const lastFullYear = endDate.getFullYear() - 1;
  const startYear = lastFullYear - (CLIMATE_YEARS - 1);
  const iso = d => d.toISOString().slice(0, 10);
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
              `&start_date=${startYear}-01-01&end_date=${iso(endDate)}` +
              `&daily=precipitation_sum,et0_fao_evapotranspiration&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Climate fetch failed: ' + res.status);
  const data = await res.json();
  return parseClimate(data, lat);
}

// Month-midpoint day-of-year, for daily Kc interpolation.
const KC_MID = [15, 45, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349];
function kcAt(doy, kc) {
  let i = KC_MID.findIndex(m => m > doy);
  if (i === -1) i = 0;
  const j = (i + 11) % 12;
  const span = (KC_MID[i] - KC_MID[j] + 365) % 365 || 365;
  const t = ((doy - KC_MID[j] + 365) % 365) / span;
  return kc[j] + (kc[i] - kc[j]) * t;
}

function parseClimate(data, lat) {
  const days = data.daily.time;
  const rains = data.daily.precipitation_sum;
  const ets = data.daily.et0_fao_evapotranspiration;

  // Crop coefficient: shift 6 months for southern hemisphere
  const kc = lat >= 0 ? KC_NORTH.slice() : KC_NORTH.slice(6).concat(KC_NORTH.slice(0, 6));

  // Group into per-year daily arrays with a daily-interpolated Kc.
  const byYear = {};
  for (let i = 0; i < days.length; i++) {
    const [y, m] = days[i].split('-').map(Number);
    if (!byYear[y]) byYear[y] = { year: y, rain: [], et0: [], month: [], kcd: [] };
    const Y = byYear[y];
    Y.rain.push(rains[i] ?? 0);
    Y.et0.push(ets[i] ?? 0);
    Y.month.push(m - 1);
    Y.kcd.push(kcAt(Y.rain.length - 1, kc));
  }
  const all = Object.values(byYear).sort((a, b) => a.year - b.year);
  // The trailing year is partial unless the archive happens to end on Dec 31.
  const last = all[all.length - 1];
  const partial = last.rain.length < 365 ? all.pop() : null;
  const years = all;

  // Monthly aggregates of complete years, for the climate band and heatmap copy.
  const avgMonthly = Array.from({length: 12}, () => ({ rain: 0, et0: 0 }));
  for (const Y of years) {
    for (let i = 0; i < Y.rain.length; i++) {
      avgMonthly[Y.month[i]].rain += Y.rain[i] / years.length;
      avgMonthly[Y.month[i]].et0  += Y.et0[i]  / years.length;
    }
  }

  const annualRain = avgMonthly.reduce((s, m) => s + m.rain, 0);
  const peakEt = Math.max(...avgMonthly.map(m => m.et0));
  const driestIdx = avgMonthly.reduce((min, m, i, arr) => m.rain < arr[min].rain ? i : min, 0);

  // Average seasonal deficit (mm/m², no practices): run the daily soil bucket.
  let seasonDeficit = 0;
  for (const Y of years) {
    let soil = SOIL_RAW;
    for (let i = 0; i < Y.rain.length; i++) {
      soil = Math.min(soil + Y.rain[i], SOIL_RAW) - Y.et0[i] * Y.kcd[i];
      if (soil < 0) { seasonDeficit += -soil / years.length; soil = 0; }
    }
  }

  return { years, partial, avgMonthly, annualRain, peakEt, driestIdx, seasonDeficit, kc };
}

/* ─────────────── Simulation ─────────────── */

// Simulate one year with a daily water balance:
//  - the tank fills from the roof and spills at capacity (daily YAS — monthly
//    stepping systematically understates how much a small tank delivers,
//    Fewkes & Butler 2000, Mitchell 2007);
//  - a root-zone bucket (SOIL_RAW mm) receives rain and loses ETc = ET0 × Kc,
//    reduced by mulch; whenever it empties, the gardener replaces the deficit
//    from the tank, divided by the application efficiency of their method.
// Returns daily tank levels (length nDays+1) unless params.record === false.
function simulateYear(Y, params, startTank, startSoil) {
  const { gardenSize, roofSize, tankSize, mulch, drip } = params;
  const record = params.record !== false;
  const etMult = mulch ? MULCH_FACTOR : 1;
  const appEff = drip ? APP_EFF_DRIP : APP_EFF_HAND;
  let tank = Math.min(startTank, tankSize);
  let soil = startSoil;
  const tankLevels = record ? [tank] : null;
  const monthlyDemand = Array(12).fill(0);
  const monthlyYield = Array(12).fill(0);
  let shortfall = 0, overflow = 0, demandSum = 0, minTank = tank, seasonEndTank = tank;
  const n = Y.rain.length;

  for (let i = 0; i < n; i++) {
    const rain = Y.rain[i], m = Y.month[i];
    const yieldL = rain * roofSize * RUNOFF;
    tank += yieldL;
    if (tank > tankSize) { overflow += tank - tankSize; tank = tankSize; }
    monthlyYield[m] += yieldL;

    soil += rain;
    if (soil > SOIL_RAW) soil = SOIL_RAW;
    soil -= Y.et0[i] * Y.kcd[i] * etMult;
    if (soil < 0) {
      const demand = -soil * gardenSize / appEff;
      soil = 0;
      demandSum += demand;
      monthlyDemand[m] += demand;
      const used = Math.min(tank, demand);
      tank -= used;
      if (demand > used) shortfall += demand - used;
    }
    if (tank < minTank) minTank = tank;
    if (m === params.seasonEndMonth && (i === n - 1 || Y.month[i + 1] !== m)) seasonEndTank = tank;
    if (record) tankLevels.push(tank);
  }
  return { tankLevels, monthlyDemand, monthlyYield, shortfall, overflow, demandSum,
           endTank: tank, endSoil: soil, minTank, seasonEndTank, nDays: n };
}

function simulateAll(climate, params) {
  let years = climate.years;
  if (state.dryYear && years.length) {
    const totals = years.map(Y => Y.rain.reduce((s, r) => s + r, 0));
    years = [years[totals.indexOf(Math.min(...totals))]];
  }
  // Reserve is measured at the end of the growing season (Sep north, Mar south).
  const p = { ...params, seasonEndMonth: climate.kc[6] > 0 ? 8 : 2 };
  // Two-pass warmup so the starting tank/soil state reflects steady state.
  let tank = p.tankSize * 0.5, soil = SOIL_RAW;
  for (const Y of years) {
    const r = simulateYear(Y, { ...p, record: false }, tank, soil);
    tank = r.endTank; soil = r.endSoil;
  }
  const results = [];
  for (const Y of years) {
    const r = simulateYear(Y, p, tank, soil);
    results.push({ year: Y.year, ...r });
    tank = r.endTank; soil = r.endSoil;
  }
  // Chain the current partial year on top so the chart runs up to "today".
  // It is excluded from verdict counting (r.partial) and from dry-year mode.
  if (climate.partial && !state.dryYear && params.record !== false) {
    const r = simulateYear(climate.partial, p, tank, soil);
    results.push({ year: climate.partial.year, partial: true, ...r });
  }
  return results;
}

/* ─────────────── UI bindings ─────────────── */

function setLocationDisplay(loc) {
  $('locName').textContent = loc.name + (loc.admin && loc.admin !== loc.name ? ', ' + loc.admin : '');
  const country = loc.country ? ` · ${loc.country}` : '';
  $('locMeta').textContent = `${loc.lat.toFixed(3)}°, ${loc.lon.toFixed(3)}°${country}`;
}

function bindInputs() {
  const sliders = [
    ['gardenSize', 'gardenSizeVal', v => v.toLocaleString()],
    ['roofSize', 'roofSizeVal', v => v.toLocaleString()],
    ['tankSize', 'tankSizeVal', v => Number(v).toLocaleString()],
  ];
  sliders.forEach(([id, vid, fmt]) => {
    const el = $(id);
    el.addEventListener('input', () => {
      state[id] = +el.value;
      $(vid).textContent = fmt(+el.value);
      recompute();
    });
  });
  ['mulch', 'drip', 'dryYear'].forEach(key => {
    const id = key + 'Toggle';
    $(id).addEventListener('change', () => {
      state[key] = $(id).checked;
      recompute();
    });
  });
}

function bindLocationSearch() {
  const form = $('locForm');
  const input = $('locInput');
  const sugg = $('locSuggest');
  let lastQuery = '';
  let debounceT = null;

  function hideSugg() { sugg.hidden = true; sugg.innerHTML = ''; }
  function showSugg(items) {
    if (!items.length) { hideSugg(); return; }
    sugg.innerHTML = '';
    items.forEach(loc => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const meta = [loc.admin, loc.country].filter(Boolean).join(', ');
      btn.innerHTML = `<span>${loc.name}</span><span class="sugg-meta">${meta}</span>`;
      btn.addEventListener('click', () => {
        input.value = '';
        hideSugg();
        applyLocation(loc);
      });
      sugg.appendChild(btn);
    });
    sugg.hidden = false;
  }

  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (q === lastQuery) return;
    lastQuery = q;
    clearTimeout(debounceT);
    if (q.length < 2) { hideSugg(); return; }
    debounceT = setTimeout(async () => {
      const items = await searchLocations(q);
      if (input.value.trim() === q) showSugg(items);
    }, 220);
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    const loc = await resolveLocation(q);
    if (loc) { input.value = ''; hideSugg(); applyLocation(loc, { detectRoof: true }); }
  });

  document.addEventListener('click', e => {
    if (!form.contains(e.target)) hideSugg();
  });
}

async function applyLocation(loc, opts = {}) {
  state.location = loc;
  setLocationDisplay(loc);
  document.body.classList.add('is-loading');
  try {
    state.climate = await fetchClimate(loc.lat, loc.lon);
  } catch (e) {
    console.error(e);
    state.climate = null;
  }
  document.body.classList.remove('is-loading');
  recompute();

  // Roof auto-detect: only when we have an address-level point in France.
  if (opts.detectRoof && loc.addressLevel && (loc.country === 'France' || !loc.country)) {
    detectRoofAt(loc.lon, loc.lat).then(r => {
      if (r) showRoofResult(r);
      else hideRoofResult();
    }).catch(err => { console.error(err); hideRoofResult(); });
  } else {
    hideRoofResult();
  }
}

/* ─────────────── Compute & render ─────────────── */

function recompute() {
  if (!state.climate) return;
  const params = {
    gardenSize: state.gardenSize,
    roofSize: state.roofSize,
    tankSize: state.tankSize,
    mulch: state.mulch,
    drip: state.drip,
  };
  const results = simulateAll(state.climate, params);
  renderClimateBand();
  renderVerdict(results, params);
  renderTankChart(results);
  renderBalanceChart(results);
  renderHeatmap();
  renderSavings();
}

function renderClimateBand() {
  const c = state.climate;
  $('annualRain').textContent = fmt0(c.annualRain);
  $('driestMonth').textContent = MONTHS[c.driestIdx];
  $('driestVal').textContent = fmt0(c.avgMonthly[c.driestIdx].rain) + ' mm of rain';
  $('peakEt').textContent = fmt0(c.peakEt);
  $('seasonDeficit').textContent = fmt0(c.seasonDeficit);
}

// Smallest tank (L, rounded up to 500) that removes the shortfall from every
// complete year at the current roof and garden. Returns null when no tank up to
// `cap` does — meaning the roof, not the storage, is the binding constraint.
function smallestTankThatCloses(params, cap) {
  const closes = t => simulateAll(state.climate, { ...params, tankSize: t, record: false })
    .filter(r => !r.partial).every(r => r.shortfall < 1);
  if (!closes(cap)) return null;
  let lo = 0, hi = cap;
  while (hi - lo > 100) {
    const mid = Math.round((lo + hi) / 2);
    if (closes(mid)) hi = mid; else lo = mid;
  }
  return Math.ceil(hi / 500) * 500;
}

function renderVerdict(results, params) {
  const full = results.filter(r => !r.partial);
  const ok = full.filter(r => r.shortfall < 1).length;
  const total = full.length;
  const worst = full.reduce((w, r) => r.shortfall > (w?.shortfall ?? -1) ? r : w, null);
  const minSepReserve = Math.min(...full.map(r => r.seasonEndTank));
  const avgOverflow = full.reduce((s, r) => s + r.overflow, 0) / total;

  let head, klass;
  if (ok === total && minSepReserve > params.tankSize * 0.15) {
    head = `Self-sufficient. The tank holds enough to carry the garden through every one of the last ${total} years with comfortable margin.`;
    klass = 'accent-good';
  } else if (ok === total) {
    head = `Just enough. Every year worked, but the tank ran close to empty in late summer — a bigger tank or roof would add resilience.`;
    klass = 'accent-tight';
  } else if (ok > 0) {
    head = `Tight. ${ok} of the last ${total} years made it. The garden would have needed mains backup in ${total - ok}.`;
    klass = 'accent-tight';
  } else {
    head = `Not yet. The catchment or storage isn't large enough to bridge the dry months. Try a bigger roof or tank.`;
    klass = 'accent-bad';
  }
  const headline = $('verdictHeadline');
  headline.innerHTML = '';
  const span = document.createElement('span');
  span.className = klass;
  span.textContent = head;
  headline.appendChild(span);

  $('vSelfSuff').textContent = `${ok} of ${total} years`;
  $('vShortfall').textContent = worst && worst.shortfall > 0 ? fmtL(worst.shortfall) : '0 L';
  $('vReserve').textContent = fmtL(Math.max(0, minSepReserve));
  $('vOverflow').textContent = fmtL(avgOverflow) + ' / yr avg';

  // Perspective note: a shortfall year is not a failed garden. Say what it costs
  // to bridge from the tap, then name which constraint is actually binding —
  // storage (the roof catches enough, it just arrives out of season) or
  // catchment (the water never lands, so no tank can help).
  const note = $('verdictNote');
  if (ok < total) {
    const avgShort = full.reduce((s, r) => s + r.shortfall, 0) / total;
    const avgDemand = full.reduce((s, r) => s + r.demandSum, 0) / total;
    const avgYield = full.reduce((s, r) => s + r.monthlyYield.reduce((a, b) => a + b, 0), 0) / total;
    const eur = Math.max(1, Math.round(avgShort * MAINS_EUR_PER_M3 / 1000));

    // Only worth searching for a tank size when a year's catchment can cover a
    // year's demand at all; otherwise no amount of storage closes the gap.
    const needTank = avgYield > avgDemand ? smallestTankThatCloses(params, MAX_PRACTICAL_TANK) : null;
    let diagnosis;
    if (needTank) {
      // Storage-limited: a year's catchment covers a year's demand, the water
      // just isn't there on the days the garden needs it. Don't claim *why*
      // (seasonal carry-over vs. buffering between showers) — we haven't
      // measured that. Only editorialise about cost when the tank needed is
      // big enough to be a building project rather than a delivery.
      diagnosis = `The roof is not the constraint — it catches <strong>${fmtKL(avgYield)}</strong> a year ` +
        `against <strong>${fmtKL(avgDemand)}</strong> of demand. The water just doesn't arrive when the ` +
        `garden needs it, so this is a storage limit: about <strong>${fmtKL(needTank)}</strong> of tank ` +
        `would carry every one of these ${total} years` +
        (needTank <= HM_TANK_MAX
          ? `, and the heatmap below shows what each step short of that buys.`
          : `. That is a buried cistern rather than an off-the-shelf tank, so it is worth weighing ` +
            `against the €${eur} a year the tap would cost instead.`);
    } else if (avgYield > avgDemand) {
      diagnosis = `Over a full year the roof catches <strong>${fmtKL(avgYield)}</strong> against ` +
        `<strong>${fmtKL(avgDemand)}</strong> of demand, so on paper this is a storage problem — but the ` +
        `dry stretches are long enough that closing it would take more than ${fmtKL(MAX_PRACTICAL_TANK)} ` +
        `of storage, which is a cistern, not a tank. More roof or less demand is the realistic lever.`;
    } else {
      diagnosis = `More storage will not help: the roof catches only <strong>${fmtKL(avgYield)}</strong> ` +
        `a year against <strong>${fmtKL(avgDemand)}</strong> of demand, and a tank cannot store water ` +
        `that never lands. Closing this gap means more roof area, a smaller garden, or thriftier planting.`;
    }

    note.hidden = false;
    note.innerHTML = `A shortfall isn't a failed garden — bridging it from the tap averages ` +
      `<strong>${fmtL(avgShort)}</strong> a year (${fmtL(worst.shortfall)} in the worst year), ` +
      `roughly €${eur} at a typical €${MAINS_EUR_PER_M3}/m³ mains tariff — worth checking ` +
      `against your own bill, since rates vary several-fold between countries. ${diagnosis} ` +
      `Cutting demand is the cheapest lever of all — shade cloth in the hottest weeks, and crops ` +
      `timed to finish before late summer.`;
  } else {
    note.hidden = true;
  }
}

function renderSavings() {
  if (!state.climate) return;
  // Average annual demand across the complete years for a mulch/drip combination.
  // (Demand is independent of roof and tank size.)
  function annualDemand(mulch, drip) {
    const params = {
      gardenSize: state.gardenSize, roofSize: state.roofSize, tankSize: state.tankSize,
      mulch, drip, record: false,
    };
    const full = simulateAll(state.climate, params).filter(r => !r.partial);
    return full.reduce((s, r) => s + r.demandSum, 0) / full.length;
  }
  const baseline = annualDemand(false, false);
  const cur = annualDemand(state.mulch, state.drip);
  const saveMulch = annualDemand(false, state.drip) - annualDemand(true, state.drip);
  const saveDrip  = annualDemand(state.mulch, false) - annualDemand(state.mulch, true);

  $('mulchSaving').textContent = state.mulch ? '−' + fmtKL(saveMulch) : '–';
  $('dripSaving').textContent  = state.drip  ? '−' + fmtKL(saveDrip)  : '–';

  const sum = $('practiceSummary');
  const totalSaved = baseline - cur;
  if (state.mulch || state.drip) {
    const pct = Math.round(totalSaved / baseline * 100);
    sum.innerHTML = `Combined: <strong>−${fmtKL(totalSaved)}</strong> per season (${pct}% less irrigation), so a smaller roof and tank can carry the same garden.`;
  } else {
    sum.innerHTML = `Without mulch and drip, this garden needs <strong>${fmtKL(baseline)}</strong> of irrigation per season.`;
  }
}

/* ─────────────── SVG charts ─────────────── */

const SVG_NS = 'http://www.w3.org/2000/svg';
function el(name, attrs = {}, parent = null) {
  const node = document.createElementNS(SVG_NS, name);
  for (const k in attrs) node.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(node);
  return node;
}

function renderTankChart(results) {
  const svg = $('tankChart');
  svg.innerHTML = '';
  const W = 800, H = 320;
  const PL = 64, PR = 24, PT = 24, PB = 44;
  const plotW = W - PL - PR;
  const plotH = H - PT - PB;
  const tankSize = state.tankSize;

  // Y grid
  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i++) {
    const y = PT + plotH * (i / gridSteps);
    el('line', { x1: PL, x2: W - PR, y1: y, y2: y, stroke: '#e7e2d4', 'stroke-width': 1 }, svg);
    const v = tankSize * (1 - i / gridSteps);
    const t = el('text', { x: PL - 10, y: y + 4, 'text-anchor': 'end', 'font-size': 11, fill: '#837e74', 'font-family': 'Inter, sans-serif' }, svg);
    t.textContent = fmtKL(v).replace(' L', '');
  }
  // Y axis label
  const yl = el('text', { x: PL - 50, y: PT - 10, 'font-size': 10, fill: '#837e74', 'font-family': 'Inter, sans-serif', 'letter-spacing': '0.12em' }, svg);
  yl.textContent = 'LITRES';

  // X axis (months)
  const colW = plotW / 12;
  for (let m = 0; m < 12; m++) {
    const x = PL + colW * (m + 0.5);
    const t = el('text', { x, y: H - PB + 18, 'text-anchor': 'middle', 'font-size': 11, fill: '#837e74', 'font-family': 'Inter, sans-serif' }, svg);
    t.textContent = MONTHS[m];
  }

  // Shade growing season (Mar–Sep, or shifted for southern hemisphere)
  const kc = state.climate.kc;
  const seasonStart = kc.findIndex(k => k > 0);
  const seasonEnd = 12 - [...kc].reverse().findIndex(k => k > 0);
  if (seasonStart >= 0 && seasonEnd > seasonStart) {
    const x1 = PL + (seasonStart) * colW;
    const x2 = PL + seasonEnd * colW;
    el('rect', { x: x1, y: PT, width: x2 - x1, height: plotH, fill: '#5a7a3e', opacity: 0.05 }, svg);
  }

  // Plot one polyline per year, at daily resolution. The current partial year
  // is drawn in an accent colour on top, ending where the data ends ("today").
  const fullCount = results.filter(r => !r.partial).length;
  results.forEach((r, i) => {
    const yearLen = r.partial ? 365 : r.nDays;
    const points = r.tankLevels.map((v, j) => {
      const x = PL + plotW * Math.min(1, j / yearLen);
      const y = PT + plotH * (1 - Math.max(0, v) / tankSize);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const opacity = r.partial ? 0.9 : 0.16 + 0.6 * (i / Math.max(1, fullCount - 1));
    el('polyline', {
      points,
      fill: 'none',
      stroke: r.partial ? '#8a6d2f' : '#2f5d7a',
      'stroke-width': r.partial ? 2.6 : i === fullCount - 1 ? 2.2 : 1.3,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      opacity,
    }, svg);
    if (r.partial) {
      // Mark the "today" end point.
      const j = r.tankLevels.length - 1;
      const cx = PL + plotW * Math.min(1, j / yearLen);
      const cy = PT + plotH * (1 - Math.max(0, r.tankLevels[j]) / tankSize);
      el('circle', { cx, cy, r: 3.4, fill: '#8a6d2f' }, svg);
    }

    // Highlight dry spells: consolidate runs of consecutive empty-tank days.
    if (r.shortfall > 0) {
      let runStart = -1;
      for (let j = 1; j <= r.tankLevels.length; j++) {
        const dry = j < r.tankLevels.length && r.tankLevels[j] <= 0.5 && r.tankLevels[j - 1] <= 0.5;
        if (dry && runStart < 0) runStart = j - 1;
        if (!dry && runStart >= 0) {
          el('line', {
            x1: PL + plotW * (runStart / yearLen), x2: PL + plotW * ((j - 1) / yearLen),
            y1: PT + plotH, y2: PT + plotH,
            stroke: '#b94a2b', 'stroke-width': 3, opacity: 0.7,
          }, svg);
          runStart = -1;
        }
      }
    }
  });

  // Legend — coverage % for years that fell short.
  const legend = $('tankLegend');
  legend.innerHTML = '';
  results.forEach((r, i) => {
    const op = r.partial ? 1 : 0.16 + 0.6 * (i / Math.max(1, fullCount - 1));
    const color = r.partial ? '#8a6d2f' : '#2f5d7a';
    const cov = r.demandSum > 0 ? Math.round((1 - r.shortfall / r.demandSum) * 100) : 100;
    const item = document.createElement('span');
    item.className = 'legend-item';
    item.innerHTML = `<span class="legend-swatch" style="background:${color};opacity:${op}"></span>${r.year}${r.partial ? ' so far' : ''}${r.shortfall > 0.5 ? ` <span style="color:#b94a2b">· ${cov}% covered</span>` : ''}`;
    legend.appendChild(item);
  });
}

function renderBalanceChart(results) {
  const svg = $('balanceChart');
  svg.innerHTML = '';
  const W = 800, H = 280;
  const PL = 64, PR = 24, PT = 20, PB = 44;
  const plotW = W - PL - PR;
  const plotH = H - PT - PB;

  // Average across complete simulation years
  const full = results.filter(r => !r.partial);
  const avgYield = Array(12).fill(0);
  const avgDemand = Array(12).fill(0);
  full.forEach(r => {
    for (let m = 0; m < 12; m++) {
      avgYield[m]  += r.monthlyYield[m]  / full.length;
      avgDemand[m] += r.monthlyDemand[m] / full.length;
    }
  });
  const maxV = Math.max(1, ...avgYield, ...avgDemand);
  const yScale = v => plotH * (v / maxV);

  // Grid
  const steps = 3;
  for (let i = 0; i <= steps; i++) {
    const y = PT + plotH * (1 - i / steps);
    el('line', { x1: PL, x2: W - PR, y1: y, y2: y, stroke: '#e7e2d4', 'stroke-width': 1 }, svg);
    const v = maxV * (i / steps);
    const t = el('text', { x: PL - 10, y: y + 4, 'text-anchor': 'end', 'font-size': 11, fill: '#837e74', 'font-family': 'Inter, sans-serif' }, svg);
    t.textContent = fmtKL(v).replace(' L', '');
  }
  const yl = el('text', { x: PL - 50, y: PT - 6, 'font-size': 10, fill: '#837e74', 'font-family': 'Inter, sans-serif', 'letter-spacing': '0.12em' }, svg);
  yl.textContent = 'LITRES';

  const colW = plotW / 12;
  const barW = colW * 0.36;
  for (let m = 0; m < 12; m++) {
    const xCenter = PL + colW * (m + 0.5);
    // rain captured (left bar)
    const yh = yScale(avgYield[m]);
    el('rect', {
      x: xCenter - barW - 1, y: PT + plotH - yh,
      width: barW, height: yh,
      fill: '#88a8bf', rx: 2,
    }, svg);
    // demand (right bar)
    const dh = yScale(avgDemand[m]);
    el('rect', {
      x: xCenter + 1, y: PT + plotH - dh,
      width: barW, height: dh,
      fill: '#c79569', rx: 2,
    }, svg);
    // month label
    const t = el('text', { x: xCenter, y: H - PB + 18, 'text-anchor': 'middle', 'font-size': 11, fill: '#837e74', 'font-family': 'Inter, sans-serif' }, svg);
    t.textContent = MONTHS[m];
  }

  // Inline legend
  const lg = el('g', {}, svg);
  el('rect', { x: PL, y: 4, width: 10, height: 10, fill: '#88a8bf', rx: 2 }, lg);
  const t1 = el('text', { x: PL + 16, y: 13, 'font-size': 11, fill: '#4a4640', 'font-family': 'Inter, sans-serif' }, lg);
  t1.textContent = 'Roof yield';
  el('rect', { x: PL + 90, y: 4, width: 10, height: 10, fill: '#c79569', rx: 2 }, lg);
  const t2 = el('text', { x: PL + 106, y: 13, 'font-size': 11, fill: '#4a4640', 'font-family': 'Inter, sans-serif' }, lg);
  t2.textContent = 'Garden demand';
}

/* Heatmap: roof vs tank, color = reliability across years */

const HM_ROOF_MIN = 20, HM_ROOF_MAX = 250, HM_ROOF_N = 28;
const HM_TANK_MIN = 1000, HM_TANK_MAX = 25000, HM_TANK_N = 18;

function reliabilityScore(roof, tank) {
  // Returns 0..1. 1 = no shortfall + comfortable reserve. 0 = total failure.
  const params = {
    gardenSize: state.gardenSize,
    roofSize: roof,
    tankSize: tank,
    mulch: state.mulch,
    drip: state.drip,
    record: false,   // skip per-day level arrays — this runs ~500× per render
  };
  const results = simulateAll(state.climate, params);
  let shortPct = 0;
  let reservePct = 0;
  for (const r of results) {
    const totalDemand = r.demandSum || 1;
    shortPct += r.shortfall / totalDemand;
    reservePct += Math.max(0, r.seasonEndTank) / tank;
  }
  shortPct /= results.length;
  reservePct /= results.length;
  // Reliability: 0 when shortPct >= 0.3 (catastrophic), 1 when no shortfall and >50% Sep reserve.
  const noShort = Math.max(0, 1 - shortPct / 0.3);
  const reserveBoost = Math.min(1, reservePct / 0.5);
  return Math.max(0, Math.min(1, 0.7 * noShort + 0.3 * reserveBoost));
}

function colorFor(score) {
  // Divergent: red (0) → cream (~0.5) → green (1)
  // Use HSL interpolation between cool stops.
  if (score <= 0.5) {
    const t = score / 0.5; // 0..1
    // red (#b94a2b) → cream (#f0ebde)
    return mix('#b94a2b', '#f0ebde', t);
  } else {
    const t = (score - 0.5) / 0.5;
    // cream → deep green (#3a5a2c)
    return mix('#f0ebde', '#3a5a2c', t);
  }
}

function mix(a, b, t) {
  const pa = hex(a), pb = hex(b);
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return `rgb(${r},${g},${bl})`;
}
function hex(h) {
  const x = h.replace('#', '');
  return [parseInt(x.slice(0,2), 16), parseInt(x.slice(2,4), 16), parseInt(x.slice(4,6), 16)];
}

let heatmapPending = null;
function renderHeatmap() {
  // Throttle: schedule via rAF
  if (heatmapPending) cancelAnimationFrame(heatmapPending);
  heatmapPending = requestAnimationFrame(actuallyRenderHeatmap);
}

function actuallyRenderHeatmap() {
  const svg = $('heatmap');
  svg.innerHTML = '';
  const W = 720, H = 440;
  const PL = 70, PR = 24, PT = 20, PB = 56;
  const plotW = W - PL - PR;
  const plotH = H - PT - PB;
  const cellW = plotW / HM_ROOF_N;
  const cellH = plotH / HM_TANK_N;

  // Compute scores
  const grid = [];
  for (let j = 0; j < HM_TANK_N; j++) {
    const row = [];
    const tank = HM_TANK_MIN + (HM_TANK_MAX - HM_TANK_MIN) * (j + 0.5) / HM_TANK_N;
    for (let i = 0; i < HM_ROOF_N; i++) {
      const roof = HM_ROOF_MIN + (HM_ROOF_MAX - HM_ROOF_MIN) * (i + 0.5) / HM_ROOF_N;
      row.push(reliabilityScore(roof, tank));
    }
    grid.push(row);
  }

  // Cells (note: tank axis flipped — bigger tank at top)
  for (let j = 0; j < HM_TANK_N; j++) {
    for (let i = 0; i < HM_ROOF_N; i++) {
      const x = PL + i * cellW;
      const y = PT + (HM_TANK_N - 1 - j) * cellH;
      el('rect', {
        x: x.toFixed(2), y: y.toFixed(2),
        width: cellW + 0.5, height: cellH + 0.5,
        fill: colorFor(grid[j][i]),
      }, svg);
    }
  }

  // Iso-contour at score = 0.5 (the "frontier")
  drawContour(svg, grid, 0.5, PL, PT, plotW, plotH, '#2a2520', 1.6);

  // Axes
  // X axis
  el('line', { x1: PL, x2: PL + plotW, y1: PT + plotH, y2: PT + plotH, stroke: '#1f1d1a', 'stroke-width': 1 }, svg);
  // Y axis
  el('line', { x1: PL, x2: PL, y1: PT, y2: PT + plotH, stroke: '#1f1d1a', 'stroke-width': 1 }, svg);

  // X ticks
  const xTicks = [50, 100, 150, 200, 250];
  xTicks.forEach(v => {
    if (v < HM_ROOF_MIN || v > HM_ROOF_MAX) return;
    const t = (v - HM_ROOF_MIN) / (HM_ROOF_MAX - HM_ROOF_MIN);
    const x = PL + t * plotW;
    el('line', { x1: x, x2: x, y1: PT + plotH, y2: PT + plotH + 5, stroke: '#1f1d1a', 'stroke-width': 1 }, svg);
    const tx = el('text', { x, y: PT + plotH + 18, 'text-anchor': 'middle', 'font-size': 11, fill: '#4a4640', 'font-family': 'Inter, sans-serif' }, svg);
    tx.textContent = v;
  });
  const xl = el('text', { x: PL + plotW / 2, y: H - 12, 'text-anchor': 'middle', 'font-size': 12, fill: '#1f1d1a', 'font-family': 'Inter, sans-serif', 'letter-spacing': '0.06em' }, svg);
  xl.textContent = 'Roof catchment area (m²)';

  // Y ticks
  const yTicks = [2000, 5000, 10000, 15000, 20000, 25000];
  yTicks.forEach(v => {
    if (v < HM_TANK_MIN || v > HM_TANK_MAX) return;
    const t = (v - HM_TANK_MIN) / (HM_TANK_MAX - HM_TANK_MIN);
    const y = PT + plotH - t * plotH;
    el('line', { x1: PL - 5, x2: PL, y1: y, y2: y, stroke: '#1f1d1a', 'stroke-width': 1 }, svg);
    const ty = el('text', { x: PL - 10, y: y + 4, 'text-anchor': 'end', 'font-size': 11, fill: '#4a4640', 'font-family': 'Inter, sans-serif' }, svg);
    ty.textContent = (v / 1000) + 'k';
  });
  const yl = el('text', { x: 18, y: PT + plotH / 2, 'text-anchor': 'middle', 'font-size': 12, fill: '#1f1d1a', 'font-family': 'Inter, sans-serif', 'letter-spacing': '0.06em', transform: `rotate(-90 18 ${PT + plotH / 2})` }, svg);
  yl.textContent = 'Storage tank size (litres)';

  // Marker for current point
  const tx = (state.roofSize - HM_ROOF_MIN) / (HM_ROOF_MAX - HM_ROOF_MIN);
  const ty = (state.tankSize - HM_TANK_MIN) / (HM_TANK_MAX - HM_TANK_MIN);
  if (tx >= 0 && tx <= 1 && ty >= 0 && ty <= 1) {
    const cx = PL + tx * plotW;
    const cy = PT + plotH - ty * plotH;
    el('circle', { cx, cy, r: 8, fill: 'none', stroke: '#fff', 'stroke-width': 3 }, svg);
    el('circle', { cx, cy, r: 8, fill: 'none', stroke: '#1f1d1a', 'stroke-width': 1.5 }, svg);
    el('circle', { cx, cy, r: 2.5, fill: '#1f1d1a' }, svg);
  }

  // Legend / scale
  const lgY = PT + 4;
  const lgX = W - PR - 140;
  for (let i = 0; i < 40; i++) {
    el('rect', { x: lgX + i * 3.2, y: lgY, width: 3.4, height: 8, fill: colorFor(i / 39) }, svg);
  }
  const lt1 = el('text', { x: lgX, y: lgY + 22, 'font-size': 10, fill: '#837e74', 'font-family': 'Inter, sans-serif' }, svg);
  lt1.textContent = 'fails';
  const lt2 = el('text', { x: lgX + 128, y: lgY + 22, 'text-anchor': 'end', 'font-size': 10, fill: '#837e74', 'font-family': 'Inter, sans-serif' }, svg);
  lt2.textContent = 'comfortable';

  // Click handler
  svg.onclick = e => {
    const rect = svg.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width * W;
    const py = (e.clientY - rect.top)  / rect.height * H;
    if (px < PL || px > PL + plotW || py < PT || py > PT + plotH) return;
    const tx = (px - PL) / plotW;
    const ty = (PT + plotH - py) / plotH;
    const newRoof = Math.round((HM_ROOF_MIN + tx * (HM_ROOF_MAX - HM_ROOF_MIN)) / 5) * 5;
    const newTank = Math.round((HM_TANK_MIN + ty * (HM_TANK_MAX - HM_TANK_MIN)) / 500) * 500;
    state.roofSize = newRoof;
    state.tankSize = newTank;
    $('roofSize').value = newRoof;
    $('tankSize').value = newTank;
    $('roofSizeVal').textContent = newRoof.toLocaleString();
    $('tankSizeVal').textContent = newTank.toLocaleString();
    recompute();
  };
}

// Marching-squares-ish contour at a given level — simple cell-edge rendering
function drawContour(svg, grid, level, PL, PT, plotW, plotH) {
  const rows = grid.length;
  const cols = grid[0].length;
  const cellW = plotW / cols;
  const cellH = plotH / rows;
  function pos(i, j) {
    // grid[j][i]: i = roof index, j = tank index (low j = small tank, displayed at bottom)
    const x = PL + (i + 0.5) * cellW;
    const y = PT + plotH - (j + 0.5) * cellH;
    return [x, y];
  }
  // Edges between adjacent cells where the level crosses
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols; i++) {
      const a = grid[j][i], b = grid[j + 1][i];
      if ((a < level) !== (b < level)) {
        const t = (level - a) / (b - a);
        const [x1, y1] = pos(i, j);
        const [x2, y2] = pos(i, j + 1);
        const x = x1 + (x2 - x1) * t;
        const y = y1 + (y2 - y1) * t;
        // dot
        el('circle', { cx: x, cy: y, r: 1.4, fill: '#1f1d1a', opacity: 0.7 }, svg);
      }
    }
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = grid[j][i], b = grid[j][i + 1];
      if ((a < level) !== (b < level)) {
        const t = (level - a) / (b - a);
        const [x1, y1] = pos(i, j);
        const [x2, y2] = pos(i + 1, j);
        const x = x1 + (x2 - x1) * t;
        const y = y1 + (y2 - y1) * t;
        el('circle', { cx: x, cy: y, r: 1.4, fill: '#1f1d1a', opacity: 0.7 }, svg);
      }
    }
  }
}

/* ─────────────── French roof auto-detect ─────────────── */

// Uses BAN (api-adresse.data.gouv.fr) for address → lat/lon, then IGN BD TOPO
// via the Géoplateforme WFS to fetch building footprints. Both APIs are open
// (no key) and CORS-permissive. Coverage is metropolitan France + DROM.

const BAN_URL = 'https://api-adresse.data.gouv.fr/search/';
const BDTOPO_WFS = 'https://data.geopf.fr/wfs/ows';

async function geocodeFr(query) {
  const res = await fetch(`${BAN_URL}?q=${encodeURIComponent(query)}&limit=1`);
  if (!res.ok) throw new Error('BAN ' + res.status);
  const j = await res.json();
  const f = j.features?.[0];
  if (!f) return null;
  const [lon, lat] = f.geometry.coordinates;
  return { lon, lat, label: f.properties.label, score: f.properties.score };
}

async function fetchBuildingsNear(lon, lat, radiusM = 40) {
  const dLon = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
  const dLat = radiusM / 110540;
  const bbox = `${lon - dLon},${lat - dLat},${lon + dLon},${lat + dLat},urn:ogc:def:crs:OGC:1.3:CRS84`;
  const url = `${BDTOPO_WFS}?service=WFS&version=2.0.0&request=GetFeature` +
              `&typenames=BDTOPO_V3:batiment` +
              `&srsname=urn:ogc:def:crs:OGC:1.3:CRS84` +
              `&bbox=${encodeURIComponent(bbox)}` +
              `&outputformat=application/json&count=20`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('WFS ' + res.status);
  const j = await res.json();
  return (j.features || []).map(f => ({ ...f, geometry: stripZ(f.geometry) }));
}

function stripZ(geom) {
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
  const stripped = polys.map(rings => rings.map(ring => ring.map(p => [p[0], p[1]])));
  return geom.type === 'MultiPolygon'
    ? { type: 'MultiPolygon', coordinates: stripped }
    : { type: 'Polygon', coordinates: stripped[0] };
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) &&
        (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}
function pointInGeometry(lon, lat, geom) {
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
  for (const rings of polys) {
    if (!pointInRing(lon, lat, rings[0])) continue;
    let inHole = false;
    for (let i = 1; i < rings.length; i++) {
      if (pointInRing(lon, lat, rings[i])) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}

// Equirectangular approximation — fine for buildings (errors << 1% over <100m).
function ringAreaM2(ring) {
  if (ring.length < 3) return 0;
  const lat0 = ring[0][1];
  const cosLat = Math.cos(lat0 * Math.PI / 180);
  const lon0 = ring[0][0];
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const x1 = (ring[i][0]   - lon0) * 111320 * cosLat;
    const y1 = (ring[i][1]   - lat0) * 110540;
    const x2 = (ring[i+1][0] - lon0) * 111320 * cosLat;
    const y2 = (ring[i+1][1] - lat0) * 110540;
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}
function geometryAreaM2(geom) {
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
  let total = 0;
  for (const rings of polys) {
    let polyArea = ringAreaM2(rings[0]);
    for (let i = 1; i < rings.length; i++) polyArea -= ringAreaM2(rings[i]);
    total += polyArea;
  }
  return total;
}
function geometryCentroid(geom) {
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
  let bestArea = 0, bestRing = null;
  for (const rings of polys) {
    const a = ringAreaM2(rings[0]);
    if (a > bestArea) { bestArea = a; bestRing = rings[0]; }
  }
  if (!bestRing) return null;
  let lon = 0, lat = 0, n = bestRing.length - 1;
  for (let i = 0; i < n; i++) { lon += bestRing[i][0]; lat += bestRing[i][1]; }
  return [lon / n, lat / n];
}

// Unified resolver: try BAN (France, address-level) first, then Open-Meteo (worldwide cities).
async function resolveLocation(query) {
  // BAN fuzzy-matches worldwide city names to French streets ("Melbourne" →
  // "Rue de Melbourne, Tourcoing" at score 0.7). Only let a street-level BAN
  // hit win when the query actually looks like a French address; bare place
  // names may only match BAN municipalities, else fall through to Open-Meteo.
  const addressy = /\d/.test(query) ||
    /\b(rue|avenue|av|boulevard|bd|chemin|impasse|place|all[ée]e|route|quai|hameau|lieu-dit)\b/i.test(query);
  let banFeat = null;
  try {
    const res = await fetch(`${BAN_URL}?q=${encodeURIComponent(query)}&limit=3`);
    if (res.ok) {
      const j = await res.json();
      banFeat = (j.features || []).find(f => {
        const p = f.properties;
        if (p.type === 'municipality') return p.score >= 0.7;
        return addressy && p.score >= 0.4;
      });
    }
  } catch {}
  if (banFeat) {
    const [lon, lat] = banFeat.geometry.coordinates;
    const p = banFeat.properties;
    return {
      lon, lat,
      name: p.city || p.name || p.label,
      label: p.label,
      country: 'France',
      admin: p.context ? p.context.split(',').slice(-1)[0].trim() : '',
      addressLevel: ['housenumber', 'street'].includes(p.type),
    };
  }
  const items = await searchLocations(query);
  if (items.length) return { ...items[0], addressLevel: false, label: items[0].name };
  return null;
}

// Reverse: lat/lon → place name. BAN for France, BigDataCloud worldwide.
async function reverseGeocode(lat, lon) {
  try {
    const res = await fetch(`${BAN_URL.replace('/search/', '/reverse/')}?lon=${lon}&lat=${lat}`);
    if (res.ok) {
      const j = await res.json();
      const f = j.features?.[0];
      if (f) {
        const p = f.properties;
        return {
          name: p.city || p.label,
          label: p.label,
          country: 'France',
          admin: p.context ? p.context.split(',').slice(-1)[0].trim() : '',
          addressLevel: ['housenumber', 'street'].includes(p.type),
        };
      }
    }
  } catch {}
  try {
    const res = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
    if (res.ok) {
      const j = await res.json();
      return {
        name: j.city || j.locality || j.principalSubdivision || 'Unknown',
        country: j.countryName || '',
        admin: j.principalSubdivision || '',
        addressLevel: false,
      };
    }
  } catch {}
  return { name: `${lat.toFixed(3)}, ${lon.toFixed(3)}`, country: '', admin: '', addressLevel: false };
}

// Precise browser geolocation. One permission prompt; 10s timeout.
function bindPreciseLoc() {
  const btn = $('preciseLocBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      alert('This browser does not support geolocation.');
      return;
    }
    const label = btn.querySelector('span');
    const old = label.textContent;
    btn.disabled = true;
    label.textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(
      async pos => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        const rev = await reverseGeocode(lat, lon);
        await applyLocation({ lat, lon, ...rev }, { detectRoof: true });
        label.textContent = old;
        btn.disabled = false;
      },
      err => {
        btn.disabled = false;
        label.textContent = old;
        const msg = err.code === 1 ? 'Permission denied. The browser blocked access to your location.'
                  : err.code === 2 ? 'Location unavailable on this device.'
                  : err.code === 3 ? 'Location lookup timed out.'
                  : `Geolocation error: ${err.message}`;
        const status = $('roofStatus');
        status.hidden = false;
        status.className = 'roof-status warn';
        status.textContent = msg;
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });
}

// Run the building lookup at a given precise point.
async function detectRoofAt(lon, lat) {
  let features;
  try { features = await fetchBuildingsNear(lon, lat, 40); }
  catch { return null; }
  if (!features.length) return null;
  let best = features.find(f => pointInGeometry(lon, lat, f.geometry));
  let approximate = false;
  if (!best) {
    approximate = true;
    let minD = Infinity;
    for (const f of features) {
      const c = geometryCentroid(f.geometry);
      if (!c) continue;
      const dx = (c[0] - lon) * 111320 * Math.cos(lat * Math.PI / 180);
      const dy = (c[1] - lat) * 110540;
      const d = Math.hypot(dx, dy);
      if (d < minD) { minD = d; best = f; }
    }
  }
  if (!best) return null;
  const area = Math.round(geometryAreaM2(best.geometry));
  return { feature: best, area, approximate, lon, lat };
}

function hideRoofResult() {
  const status = $('roofStatus');
  status.hidden = true;
  status.innerHTML = '';
  status.className = 'roof-status';
}

let _suppressRoofClear = false;
function applyRoofArea(area) {
  const slider = $('roofSize');
  if (area > +slider.max) slider.max = area + 50;
  _suppressRoofClear = true;
  slider.value = area;
  _suppressRoofClear = false;
  const snapped = +slider.value;
  state.roofSize = snapped;
  $('roofSizeVal').textContent = snapped.toLocaleString();
  recompute();
  return snapped;
}

function renderRoofSummary(feature, area, kind) {
  const usage = feature.properties?.usage_1 || 'Building';
  const hauteur = feature.properties?.hauteur;
  const summary = $('roofStatus').querySelector('.roof-status-summary');
  if (!summary) return;
  summary.innerHTML =
    `<span class="roof-status-tick">✓</span>` +
    `<strong>${area} m²</strong>` +
    `<span class="roof-status-meta">${kind} · ${usage.toLowerCase()}` +
    `${hauteur ? ` · ${Math.round(hauteur)} m tall` : ''} · BD TOPO</span>`;
}

function showRoofResult(result) {
  const snapped = applyRoofArea(result.area);
  const status = $('roofStatus');
  status.hidden = false;
  status.className = 'roof-status ok';
  status.innerHTML = `
    <div class="roof-status-summary"></div>
    <div class="roof-map" id="roofMap"></div>
    <div class="roof-status-hint">Drag to pan, scroll or use ＋/− to zoom, click another building to pick it.</div>
  `;
  renderRoofSummary(result.feature, snapped, result.approximate ? 'Closest building' : 'Detected');
  setupRoofMap($('roofMap'), result.lon, result.lat, result.feature);
}

/* ─────────────── Interactive roof map ─────────────── */

const roofMap = {
  container: null,
  svg: null,
  zoom: 19,
  centerLon: 0,
  centerLat: 0,
  buildings: new Map(),
  loadedBbox: null,
  selected: null,
  geocodedPoint: null,
  fetchTimer: null,
  pan: null,
  resizeObserver: null,
  layer: 'satellite',          // 'satellite' or 'plan'
  suppressNextClick: false,    // set after a pan so the click event doesn't pick a building
};

const MAP_ZOOM_MIN = 16;
const MAP_ZOOM_MAX = 19;
const TILE_PX = 256;

function lonLatToPx(lon, lat, z) {
  const n = Math.pow(2, z);
  const x = (lon + 180) / 360 * n * TILE_PX;
  const sin = Math.sin(lat * Math.PI / 180);
  const y = (1 - Math.log((1 + sin) / (1 - sin)) / (2 * Math.PI)) / 2 * n * TILE_PX;
  return [x, y];
}
function pxToLonLat(px, py, z) {
  const n = Math.pow(2, z);
  const lon = px / (n * TILE_PX) * 360 - 180;
  const yNorm = py / (n * TILE_PX);
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * yNorm))) * 180 / Math.PI;
  return [lon, lat];
}

function bboxContains(outer, inner) {
  return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
}
function unionBbox(a, b) {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}
function featureKey(f) {
  return f.properties?.cleabs || f.id || JSON.stringify(f.geometry).slice(0, 60);
}

function setupRoofMap(container, geocodedLon, geocodedLat, initialFeature) {
  roofMap.container = container;
  roofMap.zoom = 19;
  roofMap.buildings = new Map();
  roofMap.loadedBbox = null;
  roofMap.selected = initialFeature;
  roofMap.geocodedPoint = [geocodedLon, geocodedLat];
  if (initialFeature) {
    const c = geometryCentroid(initialFeature.geometry);
    if (c) { roofMap.centerLon = c[0]; roofMap.centerLat = c[1]; }
    else { roofMap.centerLon = geocodedLon; roofMap.centerLat = geocodedLat; }
    roofMap.buildings.set(featureKey(initialFeature), initialFeature);
  } else {
    roofMap.centerLon = geocodedLon;
    roofMap.centerLat = geocodedLat;
  }

  container.innerHTML = '';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'roof-map-svg');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  container.appendChild(svg);
  roofMap.svg = svg;

  const hud = document.createElement('div');
  hud.className = 'roof-map-hud';
  hud.innerHTML =
    `<button type="button" class="map-btn" data-act="zoomin" title="Zoom in" aria-label="Zoom in">＋</button>` +
    `<button type="button" class="map-btn" data-act="zoomout" title="Zoom out" aria-label="Zoom out">−</button>` +
    `<button type="button" class="map-btn" data-act="recenter" title="Recenter on the address" aria-label="Recenter">⌖</button>` +
    `<button type="button" class="map-btn map-btn-layer" data-act="layer" title="Toggle satellite / plan" aria-label="Toggle layer">${roofMap.layer === 'satellite' ? '🛰' : '🗺'}</button>`;
  container.appendChild(hud);
  hud.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'zoomin') setRoofMapZoom(roofMap.zoom + 1);
    else if (act === 'zoomout') setRoofMapZoom(roofMap.zoom - 1);
    else if (act === 'recenter') {
      [roofMap.centerLon, roofMap.centerLat] = roofMap.geocodedPoint;
      renderRoofMap();
      scheduleRoofMapFetch();
    }
    else if (act === 'layer') {
      roofMap.layer = roofMap.layer === 'satellite' ? 'plan' : 'satellite';
      btn.textContent = roofMap.layer === 'satellite' ? '🛰' : '🗺';
      renderRoofMap();
    }
  });

  const attr = document.createElement('div');
  attr.className = 'map-attr';
  attr.innerHTML = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> · IGN orthos · BD TOPO';
  container.appendChild(attr);

  attachRoofMapInteraction();
  // Re-render when the container changes size (responsive)
  if (roofMap.resizeObserver) roofMap.resizeObserver.disconnect();
  roofMap.resizeObserver = new ResizeObserver(() => renderRoofMap());
  roofMap.resizeObserver.observe(container);

  renderRoofMap();
  scheduleRoofMapFetch(0);
}

function setRoofMapZoom(z) {
  z = Math.max(MAP_ZOOM_MIN, Math.min(MAP_ZOOM_MAX, z));
  if (z === roofMap.zoom) return;
  roofMap.zoom = z;
  renderRoofMap();
  scheduleRoofMapFetch();
}

function roofMapViewport() {
  const r = roofMap.container.getBoundingClientRect();
  return { w: Math.max(40, r.width), h: Math.max(40, r.height) };
}

function renderRoofMap() {
  if (!roofMap.svg) return;
  const { w, h } = roofMapViewport();
  const z = roofMap.zoom;
  const [cx, cy] = lonLatToPx(roofMap.centerLon, roofMap.centerLat, z);
  const svg = roofMap.svg;
  // Local viewport coordinate system 0..w / 0..h to avoid precision loss at
  // tile-pixel coords ~10^8 — Chrome's SVG renderer drops tile images at those
  // magnitudes even though they're "in the viewBox".
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.innerHTML = '';

  // Project a tile-pixel coord into the viewport's local space.
  const toLocal = (px, py) => [px - cx + w / 2, py - cy + h / 2];

  // background while tiles load
  el('rect', { x: 0, y: 0, width: w, height: h, fill: '#dee2e6' }, svg);

  // Visible tile range in tile-pixel space
  const vbX = cx - w / 2, vbY = cy - h / 2;
  const minTX = Math.floor(vbX / TILE_PX);
  const maxTX = Math.floor((vbX + w) / TILE_PX);
  const minTY = Math.floor(vbY / TILE_PX);
  const maxTY = Math.floor((vbY + h) / TILE_PX);

  function appendTile(url, tx, ty) {
    const img = document.createElementNS(SVG_NS, 'image');
    img.setAttribute('href', url);
    img.setAttribute('x', tx * TILE_PX - cx + w / 2);
    img.setAttribute('y', ty * TILE_PX - cy + h / 2);
    img.setAttribute('width', TILE_PX);
    img.setAttribute('height', TILE_PX);
    img.setAttribute('preserveAspectRatio', 'none');
    svg.appendChild(img);
  }

  // OSM base layer — always rendered, fills any gaps in IGN orthos
  for (let tx = minTX; tx <= maxTX; tx++) {
    for (let ty = minTY; ty <= maxTY; ty++) {
      if (tx < 0 || ty < 0 || tx >= Math.pow(2, z) || ty >= Math.pow(2, z)) continue;
      const sub = ['a', 'b', 'c'][(tx + ty) % 3];
      appendTile(`https://${sub}.tile.openstreetmap.org/${z}/${tx}/${ty}.png`, tx, ty);
    }
  }

  // IGN ortho-photos (satellite) on top, only in satellite mode
  if (roofMap.layer === 'satellite') {
    for (let tx = minTX; tx <= maxTX; tx++) {
      for (let ty = minTY; ty <= maxTY; ty++) {
        if (tx < 0 || ty < 0 || tx >= Math.pow(2, z) || ty >= Math.pow(2, z)) continue;
        const url = `https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile` +
                    `&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&TILEMATRIXSET=PM&FORMAT=image/jpeg&STYLE=normal` +
                    `&TILEMATRIX=${z}&TILECOL=${tx}&TILEROW=${ty}`;
        appendTile(url, tx, ty);
      }
    }
  }

  // building polygons
  const selKey = roofMap.selected ? featureKey(roofMap.selected) : null;
  for (const [key, f] of roofMap.buildings) {
    const isSel = key === selKey;
    const polys = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];
    for (const rings of polys) {
      const ring = rings[0];
      const points = ring.map(([lo, la]) => toLocal(...lonLatToPx(lo, la, z)).join(',')).join(' ');
      const poly = document.createElementNS(SVG_NS, 'polygon');
      poly.setAttribute('points', points);
      poly.setAttribute('class', 'map-building');
      poly.setAttribute('data-key', key);
      poly.setAttribute('vector-effect', 'non-scaling-stroke');
      if (isSel) {
        poly.setAttribute('fill', 'rgba(255, 224, 130, 0.32)');
        poly.setAttribute('stroke', '#ffe082');
        poly.setAttribute('stroke-width', '2.5');
      } else {
        poly.setAttribute('fill', 'rgba(255, 255, 255, 0.06)');
        poly.setAttribute('stroke', 'rgba(255, 255, 255, 0.75)');
        poly.setAttribute('stroke-width', '1.2');
      }
      svg.appendChild(poly);
    }
  }

  // geocoded address pin
  if (roofMap.geocodedPoint) {
    const [px, py] = toLocal(...lonLatToPx(roofMap.geocodedPoint[0], roofMap.geocodedPoint[1], z));
    const halo = document.createElementNS(SVG_NS, 'circle');
    halo.setAttribute('cx', px); halo.setAttribute('cy', py); halo.setAttribute('r', 6);
    halo.setAttribute('fill', 'rgba(31, 29, 26, 0.25)');
    halo.setAttribute('pointer-events', 'none');
    halo.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(halo);
    const pin = document.createElementNS(SVG_NS, 'circle');
    pin.setAttribute('cx', px); pin.setAttribute('cy', py); pin.setAttribute('r', 3.5);
    pin.setAttribute('fill', '#fff');
    pin.setAttribute('stroke', '#1f1d1a');
    pin.setAttribute('stroke-width', 1.5);
    pin.setAttribute('pointer-events', 'none');
    pin.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(pin);
  }
}

function attachRoofMapInteraction() {
  const svg = roofMap.svg;

  // Pan tracking on document so the cursor can leave the SVG without losing the
  // drag. We deliberately do NOT call setPointerCapture — that re-targets click
  // events to the SVG and breaks selecting a building.
  let docMove = null;
  let docUp = null;

  svg.addEventListener('pointerdown', e => {
    if (e.button !== undefined && e.button !== 0) return;
    roofMap.pan = { x: e.clientX, y: e.clientY, moved: 0 };
    svg.classList.add('is-panning');

    docMove = ev => {
      if (!roofMap.pan) return;
      const dx = ev.clientX - roofMap.pan.x;
      const dy = ev.clientY - roofMap.pan.y;
      if (dx === 0 && dy === 0) return;
      roofMap.pan.moved += Math.abs(dx) + Math.abs(dy);
      roofMap.pan.x = ev.clientX; roofMap.pan.y = ev.clientY;
      const z = roofMap.zoom;
      const [cx, cy] = lonLatToPx(roofMap.centerLon, roofMap.centerLat, z);
      [roofMap.centerLon, roofMap.centerLat] = pxToLonLat(cx - dx, cy - dy, z);
      renderRoofMap();
    };
    docUp = () => {
      const moved = roofMap.pan?.moved || 0;
      roofMap.pan = null;
      svg.classList.remove('is-panning');
      document.removeEventListener('pointermove', docMove);
      document.removeEventListener('pointerup', docUp);
      document.removeEventListener('pointercancel', docUp);
      if (moved > 4) {
        roofMap.suppressNextClick = true;  // a real drag, not a click
        scheduleRoofMapFetch();
      }
    };
    document.addEventListener('pointermove', docMove);
    document.addEventListener('pointerup', docUp);
    document.addEventListener('pointercancel', docUp);
  });

  svg.addEventListener('wheel', e => {
    e.preventDefault();
    setRoofMapZoom(roofMap.zoom + (e.deltaY < 0 ? 1 : -1));
  }, { passive: false });

  svg.addEventListener('click', e => {
    if (roofMap.suppressNextClick) {
      roofMap.suppressNextClick = false;
      return;
    }
    const t = e.target.closest('polygon[data-key]');
    if (!t) return;
    const f = roofMap.buildings.get(t.getAttribute('data-key'));
    if (f) selectMapFeature(f);
  });
}

function scheduleRoofMapFetch(delay = 220) {
  clearTimeout(roofMap.fetchTimer);
  roofMap.fetchTimer = setTimeout(fetchRoofMapBuildings, delay);
}

async function fetchRoofMapBuildings() {
  const { w, h } = roofMapViewport();
  const z = roofMap.zoom;
  const [cx, cy] = lonLatToPx(roofMap.centerLon, roofMap.centerLat, z);
  const [westLon, northLat] = pxToLonLat(cx - w / 2, cy - h / 2, z);
  const [eastLon, southLat] = pxToLonLat(cx + w / 2, cy + h / 2, z);
  const minLon = Math.min(westLon, eastLon), maxLon = Math.max(westLon, eastLon);
  const minLat = Math.min(northLat, southLat), maxLat = Math.max(northLat, southLat);
  const padLon = (maxLon - minLon) * 0.4;
  const padLat = (maxLat - minLat) * 0.4;
  const want = [minLon - padLon, minLat - padLat, maxLon + padLon, maxLat + padLat];
  if (roofMap.loadedBbox && bboxContains(roofMap.loadedBbox, want)) return;
  const fetchBbox = roofMap.loadedBbox ? unionBbox(roofMap.loadedBbox, want) : want;

  const url = `${BDTOPO_WFS}?service=WFS&version=2.0.0&request=GetFeature` +
              `&typenames=BDTOPO_V3:batiment` +
              `&srsname=urn:ogc:def:crs:OGC:1.3:CRS84` +
              `&bbox=${fetchBbox.join(',')},urn:ogc:def:crs:OGC:1.3:CRS84` +
              `&outputformat=application/json&count=400`;
  try {
    const r = await fetch(url);
    if (!r.ok) return;
    const j = await r.json();
    for (const f of j.features || []) {
      const cleaned = { ...f, geometry: stripZ(f.geometry) };
      const k = featureKey(cleaned);
      if (!roofMap.buildings.has(k)) roofMap.buildings.set(k, cleaned);
    }
    roofMap.loadedBbox = fetchBbox;
    renderRoofMap();
  } catch (e) {
    console.error('roof map fetch failed', e);
  }
}

function selectMapFeature(f) {
  roofMap.selected = f;
  const area = Math.round(geometryAreaM2(f.geometry));
  const snapped = applyRoofArea(area);
  renderRoofSummary(f, snapped, 'Selected');
  renderRoofMap();
}

// Clear the roof status when the user moves the slider manually.
function bindRoofSliderClear() {
  const slider = $('roofSize');
  slider.addEventListener('input', () => {
    if (_suppressRoofClear) return;
    const status = $('roofStatus');
    if (!status.hidden) hideRoofResult();
  });
}

/* ─────────────── Boot ─────────────── */

(async function init() {
  bindInputs();
  bindLocationSearch();
  bindPreciseLoc();
  bindRoofSliderClear();

  // Set initial input display values
  $('gardenSizeVal').textContent = state.gardenSize.toLocaleString();
  $('roofSizeVal').textContent = state.roofSize.toLocaleString();
  $('tankSizeVal').textContent = state.tankSize.toLocaleString();

  document.body.classList.add('is-loading');
  const loc = await detectLocation();
  await applyLocation(loc);
})();
