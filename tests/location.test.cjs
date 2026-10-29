const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { hidden: false, textContent: '', innerHTML: '',
      className: '', classList: { add() {}, remove() {}, toggle() {} } });
    return elements.get(id);
  };
  const context = vm.createContext({ console: { error() {} }, clearTimeout, setTimeout,
    document: { getElementById: element, body: element('body') } });
  const source = fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('(async function init()')), context);
  vm.runInContext(`
    const requests = [], roofs = [];
    fetchClimate = () => new Promise((resolve, reject) => requests.push({ resolve, reject }));
    detectRoofAt = () => new Promise((resolve, reject) => roofs.push({ resolve, reject }));
    let rendered = null, roof = null;
    recompute = () => { if (state.climate) rendered = state.climate; };
    showRoofResult = result => { roof = result; state.roofSize = result.area; };
  `, context);
  return code => vm.runInContext(code, context);
}
const loc = name => `({name:'${name}', lat:47, lon:-1, country:'France', addressLevel:true})`;

test('out-of-order climate success and failure cannot replace current results or status', async () => {
  const run = harness();
  const a = run(`applyLocation(${loc('A')})`);
  const b = run(`applyLocation(${loc('B')})`);
  run(`requests[1].resolve({place:'B'})`); await b;
  run(`requests[0].resolve({place:'A'})`); await a;
  assert.equal(run('state.climate.place'), 'B');
  assert.equal(run('rendered.place'), 'B');
  const c = run(`applyLocation(${loc('C')})`);
  const d = run(`applyLocation(${loc('D')})`);
  run(`requests[2].reject(new Error('late failure'))`); await c;
  assert.match(run("$('climateStatusText').textContent"), /Loading.*D/);
  run(`requests[3].resolve({place:'D'})`); await d;
  assert.equal(run("$('climateStatus').hidden"), true);
});

test('failure clears climate, exposes retry and preserves user settings', async () => {
  const run = harness();
  const a = run(`applyLocation(${loc('A')})`);
  run(`requests[0].resolve({place:'A'})`); await a;
  const b = run(`applyLocation(${loc('B')})`);
  assert.equal(run('state.climate'), null);
  run(`state.gardenSize = 125; state.tankSize = 15000; requests[1].reject(new Error('offline'))`);
  await b;
  assert.equal(run("$('retryClimate').hidden"), false);
  assert.match(run("$('climateStatusText').textContent"), /could not be loaded/);
  const retry = run('applyLocation(state.location, locationOptions)');
  run(`requests[2].resolve({place:'B'})`); await retry;
  assert.equal(run('state.gardenSize'), 125);
  assert.equal(run('state.tankSize'), 15000);
  assert.equal(run('state.climate.place'), 'B');
});

test('late roof detection cannot change the current roof or user input', async () => {
  const run = harness();
  const a = run(`applyLocation(${loc('A')}, {detectRoof:true})`);
  run(`requests[0].resolve({place:'A'})`); await Promise.resolve();
  const b = run(`applyLocation(${loc('B')}, {detectRoof:true})`);
  run(`requests[1].resolve({place:'B'})`); await Promise.resolve();
  run('roofs[1].resolve({area:150})'); await b;
  run('roofs[0].resolve({area:300})'); await a;
  assert.equal(run('state.roofSize'), 150);
  const c = run(`applyLocation(${loc('C')}, {detectRoof:true})`);
  run(`requests[2].resolve({place:'C'})`); await Promise.resolve();
  run('++roofGeneration; state.roofSize = 75; roofs[2].resolve({area:400})'); await c;
  assert.equal(run('state.roofSize'), 75);
});

function climate(start = '2024-01-01', end = '2025-02-01') {
  const time = [];
  for (let t = Date.parse(start); t <= Date.parse(end); t += 86400e3) time.push(new Date(t).toISOString().slice(0, 10));
  return {daily: {time, precipitation_sum: time.map(() => 0), et0_fao_evapotranspiration: time.map(() => 0)}};
}
function parse(data) {
  const run = harness();
  return run(`parseClimate(${JSON.stringify(data)}, 47)`);
}
test('zero measurements are valid and leap-year completeness uses calendar dates', () => {
  const c = parse(climate());
  assert.equal(c.years[0].rain.length, 366);
  assert.equal(c.annualRain, 0);
  assert.equal(c.partial.rain.length, 32);
  const leap = parse(climate('2023-01-01', '2024-12-30'));
  assert.equal(leap.years.length, 1);
  assert.equal(leap.partial.year, 2024);
});
test('reject missing, negative, nonnumeric and nonfinite measurements', () => {
  for (const value of [null, -1, '0']) {
    for (const key of ['precipitation_sum', 'et0_fao_evapotranspiration']) {
      const data = climate(); data.daily[key][30] = value;
      assert.throws(() => parse(data), /missing or invalid/);
    }
  }
  const run = harness();
  assert.throws(() => run(`parseClimate({daily:{time:['2024-01-01'],precipitation_sum:[Infinity],et0_fao_evapotranspiration:[0]}},47)`), /missing or invalid/);
  const data = climate(); data.daily.precipitation_sum.pop();
  assert.throws(() => parse(data), /missing daily/);
  assert.throws(() => parse({}), /missing daily/);
});
test('reject invalid, duplicated, missing or unordered dates and no complete year', () => {
  for (const day of ['2024-02-30', '2024-01-01', '2024-01-03', null]) {
    const data = climate(); data.daily.time[1] = day;
    assert.throws(() => parse(data), /dates/);
  }
  assert.throws(() => parse(climate('2024-01-02')), /dates/);
  assert.throws(() => parse(climate('2024-01-01', '2024-12-30')), /complete calendar year/);
});

test('late climate success cannot clear a newer error', async () => {
  const run = harness();
  const a = run(`applyLocation(${loc('A')})`);
  const b = run(`applyLocation(${loc('B')})`);
  run(`requests[1].reject(new Error('offline'))`); await b;
  run(`requests[0].resolve({place:'A'})`); await a;
  assert.equal(run('state.climate'), null);
  assert.equal(run("$('retryClimate').hidden"), false);
});

test('late map building responses cannot populate a replacement map', async () => {
  const run = harness();
  run(`
    roofMap.svg = {};
    roofMap.container = {getBoundingClientRect: () => ({width:400, height:300})};
    let finish;
    fetch = () => new Promise(resolve => { finish = resolve; });
  `);
  const pending = run('fetchRoofMapBuildings()');
  run(`roofMap.svg = {}; finish({ok:true,json:async () => ({features:[{properties:{cleabs:'old'},geometry:{type:'Polygon',coordinates:[]}}]})})`);
  await pending;
  assert.equal(run('roofMap.buildings.size'), 0);
  assert.equal(run('roofMap.loadedBbox'), null);
});
