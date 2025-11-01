const typeLabels = {
  takeoff: '離陸地点',
  transition_to_fixed: '固定翼移行地点',
  transit: '経由地点',
  transition_to_rotary: '回転翼移行地点',
  landing: '着陸地点'
};

const typeColors = {
  takeoff: '#2b8a3e',
  transition_to_fixed: '#0f9ed5',
  transit: '#f59f00',
  transition_to_rotary: '#845ef7',
  landing: '#d9480f'
};

const planSchema = {
  $id: 'https://example.com/vtol-flight-plan.schema.json',
  type: 'object',
  required: ['version', 'vehicleType', 'waypoints'],
  additionalProperties: false,
  properties: {
    version: { type: 'string' },
    vehicleType: { type: 'string', const: 'VTOL' },
    description: { type: 'string' },
    waypoints: {
      type: 'array',
      minItems: 2,
      items: {
        type: 'object',
        required: ['id', 'type', 'latitude', 'longitude', 'altitude'],
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          type: { type: 'string', enum: Object.keys(typeLabels) },
          latitude: { type: 'number', minimum: -90, maximum: 90 },
          longitude: { type: 'number', minimum: -180, maximum: 180 },
          altitude: { type: 'number', minimum: 0 },
          note: { type: 'string' }
        }
      }
    }
  }
};

const ajv = new window.ajv7.default({ allErrors: true, strict: false });
ajv.addSchema(planSchema);
const validatePlan = ajv.getSchema(planSchema.$id);

const state = {
  waypoints: [],
  markers: new Map(),
  profileToken: 0
};

const tileCache = new Map();
const TILE_ZOOM = 14;
const SAMPLE_SPACING_METERS = 80;

const mapElement = document.getElementById('map');
const waypointListElement = document.getElementById('waypointList');
const planFileInput = document.getElementById('planFileInput');
const newWaypointTypeSelect = document.getElementById('newWaypointType');
const defaultAltitudeInput = document.getElementById('defaultAltitude');
const profileCanvas = document.getElementById('profileCanvas');
const toggleFullscreenBtn = document.getElementById('toggleFullscreenBtn');

let map;

initialize();

async function initialize() {
  const fallbackCenter = [139.752799, 35.678253]; // 首相官邸
  const center = await getInitialCenter(fallbackCenter);

  map = new maplibregl.Map({
    container: mapElement,
    style: 'https://tile.openstreetmap.jp/styles/osm-bright/style.json',
    center,
    zoom: 17,
    attributionControl: true
  });

  map.addControl(new maplibregl.NavigationControl(), 'top-left');

  map.on('load', () => {
    setupMapSources();
    bindUiEvents();
    renderWaypointsList();
    updateMapVisualization();
  });

  map.on('click', (event) => {
    const altitude = Number(defaultAltitudeInput.value) || 0;
    addWaypoint({
      type: newWaypointTypeSelect.value,
      latitude: event.lngLat.lat,
      longitude: event.lngLat.lng,
      altitude,
      note: ''
    });
  });
}

function bindUiEvents() {
  document.getElementById('savePlanBtn').addEventListener('click', handleSavePlan);
  document.getElementById('loadPlanBtn').addEventListener('click', () => planFileInput.click());
  planFileInput.addEventListener('change', handleLoadPlan);
  toggleFullscreenBtn.addEventListener('click', toggleFullscreen);
}

async function getInitialCenter(fallback) {
  if (!navigator.geolocation) {
    return fallback;
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve([pos.coords.longitude, pos.coords.latitude]);
      },
      () => resolve(fallback),
      { enableHighAccuracy: true, maximumAge: 60000, timeout: 8000 }
    );
  });
}

function setupMapSources() {
  if (!map.getSource('flight-path')) {
    map.addSource('flight-path', {
      type: 'geojson',
      data: emptyLineString()
    });
  }

  if (!map.getLayer('flight-path-line')) {
    map.addLayer({
      id: 'flight-path-line',
      type: 'line',
      source: 'flight-path',
      paint: {
        'line-color': '#ff5c5c',
        'line-width': 3
      }
    });
  }
}

function emptyLineString() {
  return {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: []
    },
    properties: {}
  };
}

function addWaypoint({ type, latitude, longitude, altitude, note }) {
  const waypoint = {
    id: `wp-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    type,
    latitude,
    longitude,
    altitude,
    note: note ?? ''
  };

  state.waypoints.push(waypoint);
  renderWaypointsList();
  updateMapVisualization(true);
}

function renderWaypointsList() {
  waypointListElement.innerHTML = '';

  if (state.waypoints.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'ウェイポイントがまだありません。マップをクリックして追加してください。';
    empty.className = 'hint';
    waypointListElement.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();

  state.waypoints.forEach((wp, index) => {
    const card = document.createElement('article');
    card.className = 'waypoint-card';

    const header = document.createElement('header');
    const title = document.createElement('h3');
    title.textContent = `${index + 1}. ${typeLabels[wp.type]}`;
    header.appendChild(title);

    const deleteButton = document.createElement('button');
    deleteButton.textContent = '削除';
    deleteButton.classList.add('danger');
    deleteButton.addEventListener('click', () => removeWaypoint(wp.id));
    header.appendChild(deleteButton);
    card.appendChild(header);

    const controls = document.createElement('div');
    controls.className = 'waypoint-controls';

    controls.appendChild(createLabeledSelect('種別', wp.type, Object.entries(typeLabels), (value) => updateWaypoint(wp.id, { type: value })));
    controls.appendChild(createLabeledInput('高度 (m)', 'number', wp.altitude, (value) => updateWaypoint(wp.id, { altitude: Number(value) || 0 }), { min: 0, step: 1 }));
    controls.appendChild(createLabeledInput('緯度', 'number', wp.latitude.toFixed(7), (value) => updateWaypoint(wp.id, { latitude: parseFloat(value) || wp.latitude }), { step: 'any' }));
    controls.appendChild(createLabeledInput('経度', 'number', wp.longitude.toFixed(7), (value) => updateWaypoint(wp.id, { longitude: parseFloat(value) || wp.longitude }), { step: 'any' }));
    controls.appendChild(createLabeledTextarea('備考', wp.note, (value) => updateWaypoint(wp.id, { note: value })));

    card.appendChild(controls);

    const actions = document.createElement('div');
    actions.className = 'waypoint-actions';

    const upBtn = document.createElement('button');
    upBtn.textContent = '↑';
    upBtn.classList.add('secondary');
    upBtn.disabled = index === 0;
    upBtn.addEventListener('click', () => moveWaypoint(index, index - 1));

    const downBtn = document.createElement('button');
    downBtn.textContent = '↓';
    downBtn.classList.add('secondary');
    downBtn.disabled = index === state.waypoints.length - 1;
    downBtn.addEventListener('click', () => moveWaypoint(index, index + 1));

    actions.appendChild(upBtn);
    actions.appendChild(downBtn);
    card.appendChild(actions);

    fragment.appendChild(card);
  });

  waypointListElement.appendChild(fragment);
}

function createLabeledInput(labelText, type, value, onChange, attrs = {}) {
  const wrapper = document.createElement('label');
  wrapper.textContent = labelText;
  const input = document.createElement('input');
  input.type = type;
  input.value = value;
  Object.entries(attrs).forEach(([key, val]) => input.setAttribute(key, val));
  input.addEventListener('change', (event) => onChange(event.target.value));
  wrapper.appendChild(input);
  return wrapper;
}

function createLabeledSelect(labelText, selectedValue, options, onChange) {
  const wrapper = document.createElement('label');
  wrapper.textContent = labelText;
  const select = document.createElement('select');
  options.forEach(([value, text]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    if (value === selectedValue) {
      option.selected = true;
    }
    select.appendChild(option);
  });
  select.addEventListener('change', (event) => onChange(event.target.value));
  wrapper.appendChild(select);
  return wrapper;
}

function createLabeledTextarea(labelText, value, onChange) {
  const wrapper = document.createElement('label');
  wrapper.textContent = labelText;
  const textarea = document.createElement('textarea');
  textarea.rows = 2;
  textarea.value = value;
  textarea.addEventListener('input', (event) => onChange(event.target.value));
  wrapper.appendChild(textarea);
  return wrapper;
}

function moveWaypoint(fromIndex, toIndex) {
  if (toIndex < 0 || toIndex >= state.waypoints.length) return;
  const [item] = state.waypoints.splice(fromIndex, 1);
  state.waypoints.splice(toIndex, 0, item);
  renderWaypointsList();
  updateMapVisualization();
}

function updateWaypoint(id, updates) {
  const waypoint = state.waypoints.find((wp) => wp.id === id);
  if (!waypoint) return;
  Object.assign(waypoint, updates);
  renderWaypointsList();
  updateMapVisualization();
}

function removeWaypoint(id) {
  state.waypoints = state.waypoints.filter((wp) => wp.id !== id);
  renderWaypointsList();
  updateMapVisualization();
}

function updateMapVisualization(fitToFlight = false) {
  refreshMarkers();
  refreshPath();
  updateElevationProfile();
  if (fitToFlight) {
    fitMapToFlightPath();
  }
}

function refreshMarkers() {
  for (const marker of state.markers.values()) {
    marker.remove();
  }
  state.markers.clear();

  state.waypoints.forEach((wp) => {
    const marker = new maplibregl.Marker({
      color: typeColors[wp.type] ?? '#3b3b3b',
      draggable: true
    })
      .setLngLat([wp.longitude, wp.latitude])
      .addTo(map);

    marker.on('dragend', () => {
      const lngLat = marker.getLngLat();
      updateWaypoint(wp.id, { latitude: lngLat.lat, longitude: lngLat.lng });
    });

    marker.getElement().setAttribute('title', `${typeLabels[wp.type]}\n高度: ${wp.altitude}m`);

    state.markers.set(wp.id, marker);
  });
}

function refreshPath() {
  const source = map.getSource('flight-path');
  if (!source) return;

  const coordinates = state.waypoints.map((wp) => [wp.longitude, wp.latitude]);
  source.setData({
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates
    },
    properties: {}
  });
}

function fitMapToFlightPath() {
  if (state.waypoints.length < 2) return;
  const bounds = new maplibregl.LngLatBounds();
  state.waypoints.forEach((wp) => bounds.extend([wp.longitude, wp.latitude]));
  map.fitBounds(bounds, { padding: 60, duration: 1000 });
}

function toggleFullscreen() {
  const isFullscreen = document.body.classList.toggle('fullscreen');
  toggleFullscreenBtn.textContent = isFullscreen ? '地図を通常表示' : '地図を最大化';
  toggleFullscreenBtn.setAttribute('aria-pressed', String(isFullscreen));
  setTimeout(() => map.resize(), 300);
}

function handleSavePlan() {
  if (state.waypoints.length < 2) {
    alert('少なくとも2つのウェイポイントが必要です。');
    return;
  }

  const plan = {
    version: '1.0.0',
    vehicleType: 'VTOL',
    generatedAt: new Date().toISOString(),
    description: 'VTOL Flight Plan',
    waypoints: state.waypoints
  };

  const valid = validatePlan(plan);
  if (!valid) {
    console.error(validatePlan.errors);
    alert('フライトプランがスキーマに適合しません。入力内容を確認してください。');
    return;
  }

  const blob = new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `vtol-plan-${new Date().toISOString().replace(/[:.]/g, '-')}.plan`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

async function handleLoadPlan(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    const content = await file.text();
    const json = JSON.parse(content);
    const valid = validatePlan(json);
    if (!valid) {
      console.error(validatePlan.errors);
      alert('.plan ファイルがスキーマに適合しません。');
      return;
    }

    state.waypoints = json.waypoints.map((wp) => ({ ...wp }));
    renderWaypointsList();
    updateMapVisualization(true);
  } catch (error) {
    console.error(error);
    alert('.plan ファイルの読み込みに失敗しました。');
  } finally {
    event.target.value = '';
  }
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function interpolateCoordinate(start, end, t) {
  return start + (end - start) * t;
}

async function updateElevationProfile() {
  const token = ++state.profileToken;
  drawProfilePlaceholder('地形断面を計算中…');

  if (state.waypoints.length < 2) {
    drawProfilePlaceholder('地形断面を表示するには2つ以上のウェイポイントが必要です。');
    return;
  }

  try {
    const samples = await sampleElevationAlongRoute(state.waypoints);
    if (token !== state.profileToken) return;
    drawElevationProfile(samples);
  } catch (error) {
    console.error(error);
    if (token !== state.profileToken) return;
    drawProfilePlaceholder('地形データの取得に失敗しました。');
  }
}

async function sampleElevationAlongRoute(waypoints) {
  const samples = [];
  let cumulativeDistance = 0;

  for (let i = 0; i < waypoints.length - 1; i += 1) {
    const start = waypoints[i];
    const end = waypoints[i + 1];
    const segmentDistance = haversineDistance(start.latitude, start.longitude, end.latitude, end.longitude);
    const steps = Math.max(1, Math.ceil(segmentDistance / SAMPLE_SPACING_METERS));

    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      const lat = interpolateCoordinate(start.latitude, end.latitude, t);
      const lon = interpolateCoordinate(start.longitude, end.longitude, t);
      const groundElevation = await getElevationFromTile(lat, lon);
      const plannedAltitude = interpolateCoordinate(start.altitude, end.altitude, t);
      const distance = cumulativeDistance + segmentDistance * t;

      if (step === 0 && i !== 0) {
        continue; // avoid duplicates except for very first point
      }

      samples.push({
        distance,
        lat,
        lon,
        groundElevation,
        plannedAltitude
      });
    }

    cumulativeDistance += segmentDistance;
  }

  return samples;
}

async function getElevationFromTile(lat, lon) {
  try {
    const latRad = (lat * Math.PI) / 180;
    const n = Math.pow(2, TILE_ZOOM);
    const x = ((lon + 180) / 360) * n;
    const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
    const xTile = Math.floor(x);
    const yTile = Math.floor(y);
    const xPixel = Math.floor((x - xTile) * 256);
    const yPixel = Math.floor((y - yTile) * 256);

    const tileData = await fetchElevationTile(TILE_ZOOM, xTile, yTile);
    if (!tileData) return null;

    const index = (yPixel * 256 + xPixel) * 4;
    const r = tileData[index];
    const g = tileData[index + 1];
    const b = tileData[index + 2];
    const elevation = decodeElevation(r, g, b);
    return Number.isFinite(elevation) ? elevation : null;
  } catch (error) {
    console.warn('標高取得失敗', error);
    return null;
  }
}

async function fetchElevationTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) {
    return tileCache.get(key);
  }

  const url = `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${z}/${x}/${y}.png`;
  const response = await fetch(url, { mode: 'cors' });
  if (!response.ok) {
    throw new Error(`タイル取得に失敗しました: ${response.status}`);
  }
  const blob = await response.blob();
  const imageBitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = imageBitmap.width;
  canvas.height = imageBitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(imageBitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  tileCache.set(key, imageData);
  return imageData;
}

function decodeElevation(r, g, b) {
  const value = r * 256 * 256 + g * 256 + b;
  if (value === 0 || value === 256 * 256 * 256 - 1) {
    return null;
  }
  return value / 10 - 10000; // GSI dem_png specification
}

function drawProfilePlaceholder(message) {
  const ctx = profileCanvas.getContext('2d');
  const { width, height } = resizeCanvas(profileCanvas);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#666';
  ctx.font = `${Math.max(14, Math.floor(height / 12))}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(message, width / 2, height / 2);
}

function drawElevationProfile(samples) {
  const ctx = profileCanvas.getContext('2d');
  const { width, height, dpr } = resizeCanvas(profileCanvas);
  ctx.clearRect(0, 0, width, height);

  const margin = 40 * dpr;
  const plotWidth = width - margin * 2;
  const plotHeight = Math.max(height - margin * 2, dpr);

  const distances = samples.map((s) => s.distance);
  const totalDistance = distances[distances.length - 1] || 1;
  const elevations = samples.map((s) => s.groundElevation).filter((v) => v != null);
  const planned = samples.map((s) => s.plannedAltitude);
  const minElevation = Math.min(...elevations, 0);
  const maxElevation = Math.max(...elevations, ...planned, minElevation + 10);

  const xScale = (distance) => margin + (distance / totalDistance) * plotWidth;
  const yScale = (value) =>
    margin + plotHeight - ((value - minElevation) / Math.max(maxElevation - minElevation, 1)) * plotHeight;

  const validSamples = samples.filter((s) => s.groundElevation != null);
  if (validSamples.length >= 2) {
    ctx.beginPath();
    validSamples.forEach((sample, index) => {
      const x = xScale(sample.distance);
      const y = yScale(sample.groundElevation);
      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.lineTo(xScale(validSamples[validSamples.length - 1].distance), yScale(minElevation));
    ctx.lineTo(xScale(validSamples[0].distance), yScale(minElevation));
    ctx.closePath();
    ctx.fillStyle = 'rgba(132, 94, 247, 0.15)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(132, 94, 247, 0.6)';
    ctx.lineWidth = 2 * dpr;
    ctx.stroke();
  }

  // Planned altitude line
  ctx.beginPath();
  ctx.strokeStyle = '#ff6b6b';
  ctx.lineWidth = 2.5 * dpr;
  samples.forEach((sample, index) => {
    const x = xScale(sample.distance);
    const y = yScale(sample.plannedAltitude);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Axes
  ctx.strokeStyle = '#444';
  ctx.lineWidth = dpr;
  ctx.beginPath();
  ctx.moveTo(margin, margin - dpr * 0.5);
  ctx.lineTo(margin, height - margin + dpr * 0.5);
  ctx.lineTo(width - margin + dpr * 0.5, height - margin + dpr * 0.5);
  ctx.stroke();

  ctx.fillStyle = '#222';
  ctx.font = `${12 * dpr}px sans-serif`;
  ctx.textAlign = 'center';

  const effectiveTotal = Math.max(totalDistance, 1);
  const stepMeters = chooseNiceStep(effectiveTotal / 5);
  for (let d = 0; d <= effectiveTotal + 1e-6; d += stepMeters) {
    const actual = Math.min(d, totalDistance);
    const x = xScale(actual);
    ctx.beginPath();
    ctx.moveTo(x, height - margin);
    ctx.lineTo(x, height - margin + 6 * dpr);
    ctx.strokeStyle = '#666';
    ctx.stroke();
    ctx.fillText(`${Math.round(actual)}m`, x, height - margin + 18 * dpr);
  }

  ctx.save();
  ctx.translate(margin - 26 * dpr, margin + plotHeight / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('高度 (m)', 0, 0);
  ctx.restore();

  ctx.textAlign = 'right';
  ctx.fillText('距離 (m)', width - margin, height - margin + 32 * dpr);
}

function chooseNiceStep(rawStep) {
  const steps = [10, 20, 50, 100, 200, 500, 1000, 2000];
  for (const step of steps) {
    if (rawStep <= step) return step;
  }
  return steps[steps.length - 1];
}

function resizeCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.round(rect.width * dpr);
  const height = Math.round(rect.height * dpr);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { width, height, dpr };
}
