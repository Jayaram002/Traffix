// =========================================================
// NEXTERRA TRAFFIX AI - CLIENT CONTROLLER & UI ENGINE
// =========================================================

let map;
let networkLayer;
let incidentLayer;
let activeRouteLayer;
let emergencyCorridorLayer;
let signalLayer;
let routeMarkersLayer;
let forecastChart;

let availableTimestamps = [];
let isPlaying = false;
let playInterval = null;
let networkGeoJSON = null;
let currentSegmentStates = {};
let allCandidates = [];

// Layer visibility toggles
const layerVisibility = {
  segments: true,
  incidents: true,
  corridors: true,
  signals: true
};

// Current Logged-in User Session State
let currentUser = {
  username: 'operator',
  role: 'operator',
  name: 'Traffic Controller',
  title: 'Network Operations Officer',
  token: null
};

// Current cached ML route predictions
let currentMLRoutes = [];
let selectedRouteIndex = 0;
let currentEmergencyCorridorId = null;

// Congestion Neon Palette
const CONGESTION_COLORS = {
  free: "transparent",    // Free flow is clean & transparent (no green lines obscuring satellite map)
  slow: "#FFB800",        // Radiant Amber
  heavy: "#FF6600",       // Solar Orange
  jam: "#FF3366",         // Crimson Alert
  unknown: "transparent"  // Transparent
};

// =========================================================
// 1. INITIALIZATION & DUAL-ENGINE MAP (MAPTILER HYBRID + GOOGLE + LEAFLET)
// =========================================================

const MAPTILER_KEY = "DVbOeP4S0sSeJl6AItW0";

const BASEMAP_TILES = {
  'maptiler-hybrid': {
    url: `https://api.maptiler.com/maps/hybrid/{z}/{x}/{y}.jpg?key=${MAPTILER_KEY}`,
    options: {
      tileSize: 512,
      zoomOffset: -1,
      minZoom: 1,
      maxZoom: 20,
      crossOrigin: true,
      attribution: '&copy; <a href="https://www.maptiler.com/copyright/" target="_blank">MapTiler</a> &copy; OpenStreetMap contributors'
    }
  },
  'cartodb-dark': {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    options: {
      subdomains: 'abcd',
      maxZoom: 19,
      attribution: '&copy; CARTO &copy; OpenStreetMap'
    }
  },
  'osm-standard': {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }
  }
};

let currentBasemapLayer = null;

// Google Maps Dark Cyber Styling matching Nexterra obsidian theme
const GOOGLE_MAPS_DARK_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#06090e" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#04070e" }, { weight: 3 }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#94a3b8" }] },
  { featureType: "administrative.locality", elementType: "labels.text.fill", stylers: [{ color: "#00E5FF" }] },
  { featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#64748b" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#081b18" }] },
  { featureType: "poi.park", elementType: "labels.text.fill", stylers: [{ color: "#00F5A0" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#141e30" }] },
  { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#080c16" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#cbd5e1" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#1e2c42" }] },
  { featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#0e1624" }] },
  { featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: "#ffffff" }] },
  { featureType: "transit", elementType: "geometry", stylers: [{ color: "#121b2b" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#040914" }] },
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#3B82F6" }] }
];

let gMap = null;
let isGoogleMaps = false;
let gNetworkPolylines = [];
let gIncidentMarkers = [];
let gActiveRoutePolyline = null;
let gEmergencyCorridorPolyline = null;
let gInfoWindow = null;

function changeMapBasemap(styleKey) {
  if (!map || !BASEMAP_TILES[styleKey]) return;
  if (currentBasemapLayer) {
    map.removeLayer(currentBasemapLayer);
  }
  const conf = BASEMAP_TILES[styleKey];
  currentBasemapLayer = L.tileLayer(conf.url, conf.options).addTo(map);
  if (networkLayer) networkLayer.bringToFront();
  if (emergencyCorridorLayer) emergencyCorridorLayer.bringToFront();
  if (activeRouteLayer) activeRouteLayer.bringToFront();
}

function initMap() {
  const mapContainer = document.getElementById('map');
  if (!mapContainer) return;

  // Initialize Leaflet with MapTiler Satellite Hybrid as default
  if (!map) {
    map = L.map('map', {
      center: [17.3850, 78.4867],
      zoom: 12,
      zoomControl: false
    });

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    currentBasemapLayer = L.tileLayer(BASEMAP_TILES['maptiler-hybrid'].url, BASEMAP_TILES['maptiler-hybrid'].options).addTo(map);

    incidentLayer = L.layerGroup().addTo(map);
    signalLayer = L.layerGroup().addTo(map);
    routeMarkersLayer = L.layerGroup().addTo(map);
  }
}

// Render network segments onto Google Maps
function renderGoogleNetwork() {
  if (!gMap || !networkGeoJSON) return;

  gNetworkPolylines.forEach(p => p.setMap(null));
  gNetworkPolylines = [];

  const bounds = new google.maps.LatLngBounds();

  networkGeoJSON.features.forEach(feat => {
    const p = feat.properties;
    const segId = p.segment_id;
    const state = currentSegmentStates[segId];
    const isCongested = level === 'slow' || level === 'heavy' || level === 'jam';
    const color = isCongested ? (CONGESTION_COLORS[level] || '#FFB800') : 'transparent';
    const weight = (level === 'jam' || level === 'heavy') ? 5.5 : 3.5;

    const path = feat.geometry.coordinates.map(c => ({ lat: c[1], lng: c[0] }));
    path.forEach(pt => bounds.extend(pt));

    const poly = new google.maps.Polyline({
      path: path,
      strokeColor: color,
      strokeOpacity: isCongested ? 0.9 : 0,
      strokeWeight: isCongested ? weight : 0,
      map: (layerVisibility.segments && isCongested) ? gMap : null
    });
    poly.segment_id = segId;

    poly.addListener('click', (event) => {
      const content = `
        <div style="font-family: 'Plus Jakarta Sans', sans-serif; font-size: 0.82rem; line-height: 1.5; color: #fff; background: #0c121d; padding: 10px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.1);">
          <div style="font-weight: 700; color: #00E5FF; margin-bottom: 4px;">Link: ${p.segment_id}</div>
          <div>Source: <b>${p.source_node}</b> &rarr; Target: <b>${p.target_node}</b></div>
          <div>Length: <b>${p.length_km} km</b> • Lanes: <b>${p.lanes}</b></div>
          <div>Capacity: <b>${p.capacity_vph} vph</b> • Speed: <b>${state ? state.speed_kmh : p.free_flow_speed_kmh} km/h</b></div>
          ${p.signal_id ? `<div style="color: #00F5A0; font-weight: 700; margin-top: 4px;"><i class="fa-solid fa-traffic-light"></i> Signal: ${p.signal_id}</div>` : ''}
        </div>
      `;
      gInfoWindow.setContent(content);
      gInfoWindow.setPosition(event.latLng);
      gInfoWindow.open(gMap);
    });

    gNetworkPolylines.push(poly);
  });

  if (!bounds.isEmpty()) {
    gMap.fitBounds(bounds);
  }
}

// Toggle Individual Map Layers
function toggleMapLayer(layerName) {
  const chk = document.getElementById(`layer-${layerName}-toggle`);
  if (!chk) return;
  layerVisibility[layerName] = chk.checked;

  if (isGoogleMaps && gMap) {
    if (layerName === 'segments') {
      gNetworkPolylines.forEach(p => p.setMap(chk.checked ? gMap : null));
    }
    if (layerName === 'incidents') {
      gIncidentMarkers.forEach(m => m.setMap(chk.checked ? gMap : null));
    }
    if (layerName === 'corridors' && gEmergencyCorridorPolyline) {
      gEmergencyCorridorPolyline.setMap(chk.checked ? gMap : null);
    }
    return;
  }

  // Leaflet fallback
  if (layerName === 'segments' && networkLayer) {
    if (chk.checked) map.addLayer(networkLayer);
    else map.removeLayer(networkLayer);
  }
  if (layerName === 'incidents' && incidentLayer) {
    if (chk.checked) map.addLayer(incidentLayer);
    else map.removeLayer(incidentLayer);
  }
  if (layerName === 'corridors' && emergencyCorridorLayer) {
    if (chk.checked) map.addLayer(emergencyCorridorLayer);
    else map.removeLayer(emergencyCorridorLayer);
  }
  if (layerName === 'signals' && signalLayer) {
    if (chk.checked) map.addLayer(signalLayer);
    else map.removeLayer(signalLayer);
  }
}

// Load Network GeoJSON Topology
async function loadNetworkData() {
  try {
    const res = await fetch('/api/network');
    const data = await res.json();
    networkGeoJSON = data.geojson;

    if (isGoogleMaps) {
      renderGoogleNetwork();
    } else if (map) {
      networkLayer = L.geoJSON(networkGeoJSON, {
        style: feature => ({
          color: 'transparent',
          weight: 0,
          opacity: 0,
          fillOpacity: 0
        }),
        onEachFeature: (feature, layer) => {
          const p = feature.properties;
          layer.bindPopup(`
            <div style="font-family: var(--font-primary); font-size: 0.8rem; line-height: 1.5; color: #fff; background: #0c121d; padding: 6px; border-radius: 6px;">
              <div style="font-weight: 700; color: var(--nex-cyan); margin-bottom: 4px;">Link: ${p.segment_id}</div>
              <div>Source: <b>${p.source_node}</b> &rarr; Target: <b>${p.target_node}</b></div>
              <div>Length: <b>${p.length_km} km</b> • Lanes: <b>${p.lanes}</b></div>
              <div>Capacity: <b>${p.capacity_vph} vph</b> • Free Flow: <b>${p.free_flow_speed_kmh} km/h</b></div>
              ${p.signal_id ? `<div style="color: var(--nex-emerald); font-weight: 700; margin-top: 4px;"><i class="fa-solid fa-traffic-light"></i> Signal: ${p.signal_id}</div>` : ''}
            </div>
          `);
        }
      }).addTo(map);

      if (networkLayer.getBounds().isValid()) {
        map.fitBounds(networkLayer.getBounds(), { padding: [40, 40] });
      }
    }

    populateNodeSelects(data.nodes);
    populateSegmentSelects(data.segments);

    await fetchNetworkState();
    await fetchAlerts();
    await fetchAdvisories();
    initForecastChart();
    await loadEvaluationAndRobustnessData();

  } catch (err) {
    console.error("Failed to load network topology:", err);
  }
}

// Canonical Hyderabad landmarks dictionary mapped to network node IDs
// Canonical Hyderabad landmarks dictionary mapped to network node IDs (nodes.csv)
const HYDERABAD_LANDMARKS = {
  "N001": "Shamshabad / RGI Airport Outer Corridor",
  "N002": "Gachibowli Junction / ORR Financial District Exit",
  "N003": "Financial District / WaveRock Tech Park",
  "N004": "Nanakramguda Circle / Wipro Junction",
  "N005": "Kokapet SEZ / Neopolis Corridor",
  "N006": "Chandrayangutta / Falaknuma Heritage Route",
  "N007": "Mehdipatnam Bus Terminal / Rythu Bazar",
  "N008": "Tolichowki Flyover / Galaxy Theatre",
  "N009": "Rethibowli Ring Road Junction",
  "N010": "Attapur Pillar 143 / PVNR Expressway",
  "N011": "Rajendranagar Agriculture University / ICAR",
  "N012": "Aramghar Junction / Bangalore Highway",
  "N013": "Kondapur Botanical Garden Road",
  "N014": "HITEC City / Cyber Towers & Shilparamam",
  "N015": "Mindspace Madhapur / IKEA Rotary",
  "N016": "Knowledge City / T-Hub 2.0 Inorbit",
  "N017": "Durgam Cheruvu Cable-Stayed Bridge",
  "N018": "Jubilee Hills Checkpost / Road No. 36",
  "N019": "Peddamma Temple Metro Station",
  "N020": "KBR National Park / Road No. 45",
  "N021": "Film Nagar Cultural Centre",
  "N022": "Masab Tank Flyover / NMDC Junction",
  "N023": "Lakdikapul Metro / Osmania General Hospital",
  "N024": "Abids GPO / Koti Commercial Area",
  "N025": "Nampally Central Railway Station",
  "N026": "Madhapur Metro / Inorbit Mall Road",
  "N027": "Kavuri Hills / CBI Colony",
  "N028": "Borabanda MMTS / Site-3",
  "N029": "Yousufguda Checkpost / Police Lines",
  "N030": "Krishna Nagar / Jubilee Hills Enclave",
  "N031": "Banjara Hills Road No. 1 / Care Hospital",
  "N032": "Banjara Hills Road No. 2 / LV Prasad Eye",
  "N033": "Banjara Hills Road No. 10 / City Center",
  "N034": "Charminar Heritage Plaza / Old City",
  "N035": "Malakpet Super Specialty Hospital",
  "N036": "Dilsukhnagar Metro / Chaitanyapuri",
  "N037": "Kokapet Neopolis / SEZ Main Gate",
  "N038": "Financial District / WaveRock SEZ",
  "N039": "Nanakramguda Circle / Wipro Junction",
  "N040": "Shaikpet Flyover / Seven Tombs Road",
  "N041": "Tolichowki Flyover / Galaxy Theater",
  "N042": "Mehdipatnam Bus Terminal / Rythu Bazar",
  "N043": "Rethibowli Ring Road Junction",
  "N044": "Attapur Pillar 143 / PVNR Expressway",
  "N045": "Nampally Central Railway Station",
  "N046": "Koti Women's College / Sultan Bazar",
  "N047": "Chaderghat Rotary / Musi River Bridge",
  "N048": "LB Nagar Ring Road / Kamineni Hospital",
  "N049": "Gachibowli Stadium / Sports Complex",
  "N050": "Banjara Hills Road No. 12 / Cancer Hospital",
  "N051": "Manikonda Jagir / Lanco Hills",
  "N052": "Film Nagar / Whisper Valley",
  "N053": "Jubilee Hills Road No. 70",
  "N054": "Somajiguda Raj Bhavan Road",
  "N055": "Khairatabad RTA / IMAX Circle",
  "N056": "Telangana Secretariat / Tank Bund South",
  "N057": "Basheerbagh Flyover / Babu Khan Mall",
  "N058": "Kachiguda Railway Station / Nimboliadda",
  "N059": "Amberpet Ali Cafe / Golnaka Bridge",
  "N060": "Ameerpet Metro Interchange / Maitrivanam",
  "N061": "Kondapur Botanical Garden Road",
  "N062": "Punjagutta Central Flyover / Central Mall",
  "N063": "Gachibowli ORR Financial Exit",
  "N064": "Madhapur Police Station / 100 Ft Road",
  "N065": "Jubilee Hills Road No. 45 / Cable Bridge Exit",
  "N066": "Panjagutta Nagarjuna Circle",
  "N067": "Begumpet Flyover / Lifestyle Junction",
  "N068": "Hussain Sagar Lake / Tank Bund Central",
  "N069": "RTC X Roads / Sandhya Theater",
  "N070": "Musheerabad Metro / Gandhi Hospital",
  "N071": "Prakash Nagar Metro / Rasoolpura",
  "N072": "Paradise Circle / SD Road",
  "N073": "Hafeezpet Flyover / Miyapur Road",
  "N074": "Begumpet Old Airport Road / Shoppers Stop",
  "N075": "Kothaguda Junction / Sarath City Mall",
  "N076": "Ayyappa Society 100 Feet Road",
  "N077": "SR Nagar Community Hall / Umesh Chandra",
  "N078": "Sanjeeva Reddy Nagar / ESI Hospital",
  "N079": "Begumpet Railway Station / Country Club",
  "N080": "Secunderabad Clock Tower / Patny Center",
  "N081": "Ranigunj Bus Depot / Minister Road",
  "N082": "Chilkalguda Rotary / Secunderabad East",
  "N083": "Mettuguda Metro / Railway Officers Colony",
  "N084": "Tarnaka Metro / Osmania University Gate",
  "N085": "Allwyn X Roads / Miyapur Depot",
  "N086": "Secunderabad Central Railway Station",
  "N087": "Kukatpally Housing Board / KPHB Phase 1",
  "N088": "Moosapet Y-Junction / Metro Pillar 820",
  "N089": "Bharat Nagar Flyover / MMTS Station",
  "N090": "Sanathnagar Industrial Estate / Czech Colony",
  "N091": "Fatehnagar Flyover / Balanagar Main Road",
  "N092": "Bowenpally Checkpost / NH-44 Junction",
  "N093": "Tadbund Hanuman Temple / Sikh Village",
  "N094": "Karkhana / Trimulgherry RTA Circle",
  "N095": "Habsiguda Circle / NGRI Metro",
  "N096": "Nacharam Industrial Area / Mallapur Road",
  "N097": "Miyapur Metro Terminal / Calicut Road",
  "N098": "JNTU Hyderabad / Nizampet Road",
  "N099": "KPHB 7th Phase / Forum Sujana Mall",
  "N100": "Uppal Ring Road / Stadium Metro",
  "N101": "Balanagar X Roads / IDPL Colony",
  "N102": "Ferozguda / Bowenpally Military Dairy Farm",
  "N103": "Old Bowenpally / Hasmathpet Lake Road",
  "N104": "Trimulgherry X Roads / Military Hospital",
  "N105": "Lalaguda Railway Workshop / South Lallaguda",
  "N106": "Moula Ali Dargah / Railway Station Road",
  "N107": "ECIL X Roads / Radhika Theater",
  "N108": "Kushaiguda Industrial Area / Cherlapally",
  "N109": "Nizampet Village / Bachupally X Roads",
  "N110": "Pragathi Nagar Lake / JNTU West",
  "N111": "Mallampet / ORR Exit 4",
  "N112": "Gajularamaram / Quthbullapur Road",
  "N113": "Jeedimetla Industrial Area / Pipe Line Road",
  "N114": "Suchitra Circle / Dairy Farm Road",
  "N115": "Kompally Cineplanet / Medchal Highway",
  "N116": "Alwal Hills / Rythu Bazar Main Road",
  "N117": "Bolarum Railway Station / Pioneer Bazar",
  "N118": "Kowkoor / Yapral Military Cantonment",
  "N119": "Sainikpuri Post Office / Defense Colony",
  "N120": "Kapra Municipal Office / AS Rao Nagar"
};

function getNodeDisplayLabel(nodeId) {
  if (HYDERABAD_LANDMARKS[nodeId]) {
    return `${nodeId} - ${HYDERABAD_LANDMARKS[nodeId]}`;
  }
  return `${nodeId} (Hyderabad Junction)`;
}

function resolveNodeId(query) {
  if (!query || typeof query !== 'string') return null;
  const trimmed = query.trim();
  if (!trimmed) return null;

  // Direct exact match like N014 or n014
  const exactMatch = trimmed.match(/^N?(\d{1,3})$/i);
  if (exactMatch) {
    const num = parseInt(exactMatch[1], 10);
    if (num >= 1 && num <= 120) {
      return `N${String(num).padStart(3, '0')}`;
    }
  }

  // Check if string starts with N0xx
  const prefixMatch = trimmed.match(/^(N\d{3})/i);
  if (prefixMatch) {
    return prefixMatch[1].toUpperCase();
  }

  // Search through landmark names
  const lower = trimmed.toLowerCase();
  for (const [nid, name] of Object.entries(HYDERABAD_LANDMARKS)) {
    if (name.toLowerCase().includes(lower) || lower.includes(name.toLowerCase())) {
      return nid;
    }
  }

  // Check in available nodes list
  const nodes = window.traffixNodesList || [];
  for (const n of nodes) {
    if (n.label && (n.label.toLowerCase().includes(lower) || lower.includes(n.label.toLowerCase()))) {
      return n.node_id;
    }
  }

  return null;
}

let mapPickMode = null; // 'origin', 'dest', 'emerg_origin', 'emerg_dest'

function enableMapPick(type) {
  mapPickMode = type;
  const indicator = document.getElementById('map-pick-indicator');
  const targetName = document.getElementById('map-pick-target-name');

  if (indicator && targetName) {
    indicator.style.display = 'block';
    if (type === 'origin') targetName.textContent = 'Civilian FROM (Starting Point)';
    else if (type === 'dest') targetName.textContent = 'Civilian TO (Destination)';
    else if (type === 'emerg_origin') targetName.textContent = 'Emergency FROM (Scene / Dispatch Base)';
    else if (type === 'emerg_dest') targetName.textContent = 'Emergency TO (Trauma Center / Hospital)';
  }

  if (map && !window._hasMapPickListener) {
    map.on('click', handleMapClickPickNode);
    window._hasMapPickListener = true;
  }
}

function handleMapClickPickNode(e) {
  if (!mapPickMode) return;

  const lat = e.latlng.lat;
  const lon = e.latlng.lng;

  let closestNode = null;
  let minDist = Infinity;

  const nodes = window.traffixNodesList || [];
  for (const n of nodes) {
    const d = Math.hypot(n.lat - lat, n.lon - lon);
    if (d < minDist) {
      minDist = d;
      closestNode = n;
    }
  }

  if (closestNode) {
    const nid = closestNode.node_id;
    const label = getNodeDisplayLabel(nid);

    if (mapPickMode === 'origin') {
      const input = document.getElementById('civil-origin-input');
      const sel = document.getElementById('civil-origin');
      if (input) input.value = label;
      if (sel) sel.value = nid;
    } else if (mapPickMode === 'dest') {
      const input = document.getElementById('civil-dest-input');
      const sel = document.getElementById('civil-dest');
      if (input) input.value = label;
      if (sel) sel.value = nid;
    } else if (mapPickMode === 'emerg_origin') {
      const input = document.getElementById('emerg-origin-input');
      const sel = document.getElementById('emerg-origin');
      if (input) input.value = label;
      if (sel) sel.value = nid;
    } else if (mapPickMode === 'emerg_dest') {
      const input = document.getElementById('emerg-dest-input');
      const sel = document.getElementById('emerg-dest');
      if (input) input.value = label;
      if (sel) sel.value = nid;
    } else if (mapPickMode === 'op_origin') {
      const input = document.getElementById('op-origin-input');
      const sel = document.getElementById('op-origin');
      if (input) input.value = label;
      if (sel) sel.value = nid;
    } else if (mapPickMode === 'op_dest') {
      const input = document.getElementById('op-dest-input');
      const sel = document.getElementById('op-dest');
      if (input) input.value = label;
      if (sel) sel.value = nid;
    }

    L.popup()
      .setLatLng([closestNode.lat, closestNode.lon])
      .setContent(`<div style="font-family: var(--font-primary); font-size:0.8rem; font-weight:700; color:#00E5FF; padding:4px;">
        <i class="fa-solid fa-location-dot"></i> Selected Node:<br>
        <span style="color:#fff;">${label}</span>
      </div>`)
      .openOn(map);
  }

  mapPickMode = null;
  const indicator = document.getElementById('map-pick-indicator');
  if (indicator) indicator.style.display = 'none';
}

function handleOriginInput(val) {
  const nid = resolveNodeId(val);
  const civilOrigin = document.getElementById('civil-origin');
  if (nid && civilOrigin) {
    civilOrigin.value = nid;
  }
}

function handleDestInput(val) {
  const nid = resolveNodeId(val);
  const civilDest = document.getElementById('civil-dest');
  if (nid && civilDest) {
    civilDest.value = nid;
  }
}

function syncSelectToInput(type) {
  if (type === 'origin') {
    const sel = document.getElementById('civil-origin');
    const input = document.getElementById('civil-origin-input');
    if (sel && input) {
      input.value = getNodeDisplayLabel(sel.value);
    }
  } else if (type === 'dest') {
    const sel = document.getElementById('civil-dest');
    const input = document.getElementById('civil-dest-input');
    if (sel && input) {
      input.value = getNodeDisplayLabel(sel.value);
    }
  }
}

function clearCivilianInput(type) {
  if (type === 'origin') {
    const input = document.getElementById('civil-origin-input');
    if (input) {
      input.value = '';
      input.focus();
    }
  } else if (type === 'dest') {
    const input = document.getElementById('civil-dest-input');
    if (input) {
      input.value = '';
      input.focus();
    }
  }
}

function swapCivilianEndpoints() {
  const origInput = document.getElementById('civil-origin-input');
  const destInput = document.getElementById('civil-dest-input');
  const origSel = document.getElementById('civil-origin');
  const destSel = document.getElementById('civil-dest');

  if (origInput && destInput) {
    const tempText = origInput.value;
    origInput.value = destInput.value;
    destInput.value = tempText;
  }
  if (origSel && destSel) {
    const tempVal = origSel.value;
    origSel.value = destSel.value;
    destSel.value = tempVal;
  }
}

function setCivilianEndpoints(origId, destId, origLabel, destLabel, btnEl) {
  document.querySelectorAll('.preset-route-btn').forEach(b => b.classList.remove('active-preset'));
  if (btnEl) {
    btnEl.classList.add('active-preset');
  } else {
    document.querySelectorAll('.preset-route-btn').forEach(b => {
      if (b.textContent.includes(origId)) b.classList.add('active-preset');
    });
  }

  const origInput = document.getElementById('civil-origin-input');
  const destInput = document.getElementById('civil-dest-input');
  const origSel = document.getElementById('civil-origin');
  const destSel = document.getElementById('civil-dest');

  if (origInput) origInput.value = `${origId} - ${origLabel}`;
  if (destInput) destInput.value = `${destId} - ${destLabel}`;
  if (origSel) origSel.value = origId;
  if (destSel) destSel.value = destId;

  // Immediate route prediction demo
  calculateMLCivilianRoutes();
}
window.setCivilianEndpoints = setCivilianEndpoints;

// Emergency FROM and TO Handlers
function handleEmergencyOriginInput(val) {
  const nid = resolveNodeId(val);
  const emergOrigin = document.getElementById('emerg-origin');
  if (nid && emergOrigin) {
    emergOrigin.value = nid;
  }
}

function handleEmergencyDestInput(val) {
  const nid = resolveNodeId(val);
  const emergDest = document.getElementById('emerg-dest');
  if (nid && emergDest) {
    emergDest.value = nid;
  }
}

function syncEmergencySelectToInput(type) {
  if (type === 'origin') {
    const sel = document.getElementById('emerg-origin');
    const input = document.getElementById('emerg-origin-input');
    if (sel && input) {
      input.value = getNodeDisplayLabel(sel.value);
    }
  } else if (type === 'dest') {
    const sel = document.getElementById('emerg-dest');
    const input = document.getElementById('emerg-dest-input');
    if (sel && input) {
      input.value = getNodeDisplayLabel(sel.value);
    }
  }
}

function clearEmergencyInput(type) {
  if (type === 'origin') {
    const input = document.getElementById('emerg-origin-input');
    if (input) {
      input.value = '';
      input.focus();
    }
  } else if (type === 'dest') {
    const input = document.getElementById('emerg-dest-input');
    if (input) {
      input.value = '';
      input.focus();
    }
  }
}

function swapEmergencyEndpoints() {
  const origInput = document.getElementById('emerg-origin-input');
  const destInput = document.getElementById('emerg-dest-input');
  const origSel = document.getElementById('emerg-origin');
  const destSel = document.getElementById('emerg-dest');

  if (origInput && destInput) {
    const tempText = origInput.value;
    origInput.value = destInput.value;
    destInput.value = tempText;
  }
  if (origSel && destSel) {
    const tempVal = origSel.value;
    origSel.value = destSel.value;
    destSel.value = tempVal;
  }
}

async function ensureEmsDemoSession() {
  const isAuthorized = ['emergency', 'field_officer', 'operator', 'admin'].includes(currentUser.role) || currentUser.username === 'ems108';
  if (isAuthorized && currentUser.token) {
    return true;
  }
  try {
    const authRes = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username_or_email: 'ems108', password: 'emergency123' })
    });
    if (authRes.ok) {
      const authData = await authRes.json();
      currentUser = {
        username: 'ems108',
        role: 'emergency',
        name: 'Capt. V. Reddy',
        title: 'EMS 108 Priority Dispatch',
        token: authData.access_token
      };
      localStorage.setItem('nexterra_session', JSON.stringify(currentUser));
      const nameEl = document.getElementById('user-display-name');
      const roleEl = document.getElementById('user-display-role');
      if (nameEl) nameEl.textContent = currentUser.name;
      if (roleEl) roleEl.textContent = currentUser.title;
      return true;
    }
  } catch (e) {
    console.warn("EMS Demo Auth Fallback error:", e);
  }
  return false;
}

async function setEmergencyEndpoints(origId, destId, origLabel, destLabel, btnEl) {
  document.querySelectorAll('.preset-emergency-btn').forEach(b => b.classList.remove('active-preset'));
  if (btnEl) {
    btnEl.classList.add('active-preset');
  } else {
    document.querySelectorAll('.preset-emergency-btn').forEach(b => {
      if (b.textContent.includes(origId)) b.classList.add('active-preset');
    });
  }

  const origInput = document.getElementById('emerg-origin-input');
  const destInput = document.getElementById('emerg-dest-input');
  const origSel = document.getElementById('emerg-origin');
  const destSel = document.getElementById('emerg-dest');

  if (origInput) origInput.value = `${origId} - ${origLabel}`;
  if (destInput) destInput.value = `${destId} - ${destLabel}`;
  if (origSel) origSel.value = origId;
  if (destSel) destSel.value = destId;

  // Seamless Instant Demo: Auto-authenticate as EMS if currently unauthenticated
  await ensureEmsDemoSession();

  // Instant emergency green wave corridor dispatch & preview
  activateGreenCorridor();
}
window.setEmergencyEndpoints = setEmergencyEndpoints;

// =========================================================
// OPERATOR ROUTE KEY CONTROLLER (NETWORK STATE TELEMETRY)
// =========================================================
function handleOperatorOriginInput(val) {
  const nid = resolveNodeId(val);
  const opOrigin = document.getElementById('op-origin');
  if (nid && opOrigin) opOrigin.value = nid;
}

function handleOperatorDestInput(val) {
  const nid = resolveNodeId(val);
  const opDest = document.getElementById('op-dest');
  if (nid && opDest) opDest.value = nid;
}

function syncOperatorSelectToInput(type) {
  if (type === 'origin') {
    const sel = document.getElementById('op-origin');
    const input = document.getElementById('op-origin-input');
    if (sel && input) input.value = getNodeDisplayLabel(sel.value);
  } else if (type === 'dest') {
    const sel = document.getElementById('op-dest');
    const input = document.getElementById('op-dest-input');
    if (sel && input) input.value = getNodeDisplayLabel(sel.value);
  }
}

function swapOperatorEndpoints() {
  const origInput = document.getElementById('op-origin-input');
  const destInput = document.getElementById('op-dest-input');
  const origSel = document.getElementById('op-origin');
  const destSel = document.getElementById('op-dest');

  if (origInput && destInput) {
    const tempText = origInput.value;
    origInput.value = destInput.value;
    destInput.value = tempText;
  }
  if (origSel && destSel) {
    const tempVal = origSel.value;
    origSel.value = destSel.value;
    destSel.value = tempVal;
  }
}

function setOperatorEndpoints(origId, destId, origLabel, destLabel, btnEl) {
  document.querySelectorAll('.preset-operator-btn').forEach(b => b.classList.remove('active-preset'));
  if (btnEl) {
    btnEl.classList.add('active-preset');
  } else {
    document.querySelectorAll('.preset-operator-btn').forEach(b => {
      if (b.textContent.includes(origId)) b.classList.add('active-preset');
    });
  }

  const origInput = document.getElementById('op-origin-input');
  const destInput = document.getElementById('op-dest-input');
  const origSel = document.getElementById('op-origin');
  const destSel = document.getElementById('op-dest');

  if (origInput) origInput.value = `${origId} - ${origLabel}`;
  if (destInput) destInput.value = `${destId} - ${destLabel}`;
  if (origSel) origSel.value = origId;
  if (destSel) destSel.value = destId;

  // Immediate operator corridor query & telemetry update
  calculateOperatorRoute();
}
window.setOperatorEndpoints = setOperatorEndpoints;

async function calculateOperatorRoute() {
  const origInput = document.getElementById('op-origin-input');
  const destInput = document.getElementById('op-dest-input');
  const origSel = document.getElementById('op-origin');
  const destSel = document.getElementById('op-dest');

  let origin = (origInput && resolveNodeId(origInput.value)) || (origSel && origSel.value) || 'N014';
  let dest = (destInput && resolveNodeId(destInput.value)) || (destSel && destSel.value) || 'N086';

  if (origInput && origin) origInput.value = getNodeDisplayLabel(origin);
  if (destInput && dest) destInput.value = getNodeDisplayLabel(dest);
  if (origSel && origin) origSel.value = origin;
  if (destSel && dest) destSel.value = dest;

  // Mirror onto civilian endpoints to keep system state cohesive
  const civOrigInput = document.getElementById('civil-origin-input');
  const civDestInput = document.getElementById('civil-dest-input');
  const civOrigSel = document.getElementById('civil-origin');
  const civDestSel = document.getElementById('civil-dest');
  if (civOrigInput) civOrigInput.value = getNodeDisplayLabel(origin);
  if (civDestInput) civDestInput.value = getNodeDisplayLabel(dest);
  if (civOrigSel) civOrigSel.value = origin;
  if (civDestSel) civDestSel.value = dest;

  const activeCorridorEl = document.getElementById('telemetry-active-corridor');
  if (activeCorridorEl) {
    activeCorridorEl.innerHTML = `<b>${origin}</b> &rarr; <b>${dest}</b> (${getNodeDisplayLabel(dest)})`;
  }

  // Calculate ML route and draw on Hyderabad map
  await calculateMLCivilianRoutes();
}

function populateNodeSelects(nodes) {
  window.traffixNodesList = nodes || [];
  const civilOrigin = document.getElementById('civil-origin');
  const civilDest = document.getElementById('civil-dest');
  const civilOriginInput = document.getElementById('civil-origin-input');
  const civilDestInput = document.getElementById('civil-dest-input');
  const civilDatalist = document.getElementById('civil-nodes-datalist');
  const emergOriginInput = document.getElementById('emerg-origin-input');
  const emergDestInput = document.getElementById('emerg-dest-input');
  const emergDatalist = document.getElementById('emerg-nodes-datalist');
  const emergOrigin = document.getElementById('emerg-origin');
  const emergDest = document.getElementById('emerg-dest');

  const opOrigin = document.getElementById('op-origin');
  const opDest = document.getElementById('op-dest');
  const opOriginInput = document.getElementById('op-origin-input');
  const opDestInput = document.getElementById('op-dest-input');
  const opDatalist = document.getElementById('op-nodes-datalist');

  // Populate datalists with all 120 Hyderabad nodes & landmark names (nodes.csv)
  [civilDatalist, emergDatalist, opDatalist].forEach(dl => {
    if (!dl) return;
    dl.innerHTML = '';
    nodes.forEach(n => {
      const opt = document.createElement('option');
      opt.value = getNodeDisplayLabel(n.node_id);
      dl.appendChild(opt);
    });
  });

  // Populate synchronized select dropdowns
  [civilOrigin, civilDest, emergOrigin, emergDest, opOrigin, opDest].forEach(sel => {
    if (!sel) return;
    sel.innerHTML = '';
    nodes.forEach(n => {
      const opt = document.createElement('option');
      opt.value = n.node_id;
      opt.textContent = getNodeDisplayLabel(n.node_id);
      sel.appendChild(opt);
    });
  });

  const defaultFromId = 'N014'; // HITEC City
  const defaultToId = 'N086';   // Secunderabad
  const defaultEmergFrom = 'N014'; // HITEC Cyber Towers
  const defaultEmergTo = 'N031';   // Care Hospital Banjara Hills

  if (civilOrigin) civilOrigin.value = defaultFromId;
  if (civilDest) civilDest.value = defaultToId;
  if (emergOrigin) emergOrigin.value = defaultEmergFrom;
  if (emergDest) emergDest.value = defaultEmergTo;
  if (opOrigin) opOrigin.value = defaultFromId;
  if (opDest) opDest.value = defaultToId;

  if (civilOriginInput) civilOriginInput.value = getNodeDisplayLabel(defaultFromId);
  if (civilDestInput) civilDestInput.value = getNodeDisplayLabel(defaultToId);
  if (emergOriginInput) emergOriginInput.value = getNodeDisplayLabel(defaultEmergFrom);
  if (emergDestInput) emergDestInput.value = getNodeDisplayLabel(defaultEmergTo);
  if (opOriginInput) opOriginInput.value = getNodeDisplayLabel(defaultFromId);
  if (opDestInput) opDestInput.value = getNodeDisplayLabel(defaultToId);

  const activeCorridorEl = document.getElementById('telemetry-active-corridor');
  if (activeCorridorEl) {
    activeCorridorEl.innerHTML = `<b>${defaultFromId}</b> (${getNodeDisplayLabel(defaultFromId)}) &rarr; <b>${defaultToId}</b> (${getNodeDisplayLabel(defaultToId)})`;
  }
}

function populateSegmentSelects(segments) {
  const fSeg = document.getElementById('forecast-segment');
  const whatIfSeg = document.getElementById('whatif-closure');

  if (fSeg) {
    fSeg.innerHTML = '';
    segments.slice(0, 30).forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.segment_id;
      opt.textContent = `${s.segment_id} (${s.source_node} → ${s.target_node})`;
      fSeg.appendChild(opt);
    });
  }

  if (whatIfSeg) {
    whatIfSeg.innerHTML = '<option value="">None (Full Network Open)</option>';
    segments.slice(0, 25).forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.segment_id;
      opt.textContent = `Close Link ${s.segment_id} (${s.source_node} → ${s.target_node})`;
      whatIfSeg.appendChild(opt);
    });
  }
}

// =========================================================
// 2. AUTHENTICATION & ROLE-BASED ACCESS CONTROL (RBAC)
// =========================================================
const VALID_ACCOUNTS = {
  operator: { password: "OperatorPass123!", role: "operator", name: "K. Raman", title: "Network Operations Controller" },
  officer: { password: "OfficerPass123!", role: "field_officer", name: "Insp. S. Rao", title: "Field Sector Officer (Zone-West)" },
  planner: { password: "PlannerPass123!", role: "planner", name: "Ananya Iyer", title: "Principal Urban Transport Planner" },
  admin: { password: "AdminPass123!", role: "admin", name: "Dr. S. K. Murthy", title: "Chief City Traffic Commissioner" },
  viewer: { password: "ViewerPass123!", role: "civilian", name: "Aravind Rao", title: "Hyderabad Civilian Commuter" },
  aravind: { password: "civilian123", role: "civilian", name: "Aravind Rao", title: "Hyderabad Civilian Commuter" },
  ems108: { password: "emergency123", role: "emergency", name: "Capt. V. Reddy", title: "EMS 108 Priority Dispatch" }
};

function togglePasswordVisibility() {
  const pwd = document.getElementById('login-password');
  const icon = document.getElementById('toggle-pwd-btn');
  if (pwd.type === 'password') {
    pwd.type = 'text';
    icon.className = 'fa-solid fa-eye-slash';
  } else {
    pwd.type = 'password';
    icon.className = 'fa-solid fa-eye';
  }
}

function fillCredentials(username, password, role) {
  document.getElementById('login-username').value = username;
  document.getElementById('login-password').value = password;
  hideLoginError();
}

function showLoginError(msg) {
  const alertBox = document.getElementById('login-error-alert');
  const msgSpan = document.getElementById('login-error-msg');
  msgSpan.textContent = msg;
  alertBox.style.display = 'block';
}

function hideLoginError() {
  const alertBox = document.getElementById('login-error-alert');
  if (alertBox) alertBox.style.display = 'none';
}

async function handleCredentialLogin(event) {
  event.preventDefault();
  const username = document.getElementById('login-username').value.trim().toLowerCase();
  const password = document.getElementById('login-password').value.trim();

  hideLoginError();

  try {
    // Attempt backend JWT auth
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username_or_email: username, password: password })
    });

    if (res.ok) {
      const data = await res.json();
      const user = data.user;
      loginSuccess(user.username, user.role, user.full_name || username, user.role, data.access_token);
      return;
    }
  } catch (e) {
    console.warn("Backend auth call failed, checking demo credentials fallback...");
  }

  // Fallback demo validation
  const acc = VALID_ACCOUNTS[username];
  if (!acc || acc.password !== password) {
    showLoginError(`Invalid credentials for "${username}". Please check password or select a demo profile.`);
    return;
  }

  loginSuccess(username, acc.role, acc.name, acc.title, null);
}

function switchAuthTab(mode) {
  const signinTab = document.getElementById('tab-auth-signin');
  const signupTab = document.getElementById('tab-auth-signup');
  const signinSec = document.getElementById('auth-signin-section');
  const signupSec = document.getElementById('auth-signup-section');
  const errorAlert = document.getElementById('login-error-alert');
  const signupAlert = document.getElementById('signup-error-alert');

  if (errorAlert) errorAlert.style.display = 'none';
  if (signupAlert) signupAlert.style.display = 'none';

  if (mode === 'signup') {
    if (signinTab) signinTab.classList.remove('active');
    if (signupTab) signupTab.classList.add('active');
    if (signinSec) signinSec.style.display = 'none';
    if (signupSec) signupSec.style.display = 'block';
  } else {
    if (signupTab) signupTab.classList.remove('active');
    if (signinTab) signinTab.classList.add('active');
    if (signupSec) signupSec.style.display = 'none';
    if (signinSec) signinSec.style.display = 'block';
  }
}
window.switchAuthTab = switchAuthTab;

async function handleCivilianSignUp(event) {
  event.preventDefault();
  const fullName = document.getElementById('signup-fullname').value.trim();
  const username = document.getElementById('signup-username').value.trim().toLowerCase();
  const email = document.getElementById('signup-email').value.trim().toLowerCase();
  const password = document.getElementById('signup-password').value;
  const alertEl = document.getElementById('signup-error-alert');
  const msgEl = document.getElementById('signup-error-msg');

  if (alertEl) alertEl.style.display = 'none';

  try {
    const res = await fetch('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        full_name: fullName,
        username: username,
        email: email,
        password: password,
        role: 'viewer'
      })
    });

    const data = await res.json();
    if (!res.ok) {
      if (alertEl && msgEl) {
        msgEl.textContent = data.detail || 'Registration failed';
        alertEl.style.display = 'block';
      }
      return;
    }

    // Success: auto login newly registered civilian
    const u = data.user;
    loginSuccess(u.username, 'civilian', u.full_name, 'Civilian Commuter', data.access_token);
    alert(`🎉 Welcome ${u.full_name}! Your Civilian Commuter account is ready.`);
  } catch (err) {
    if (alertEl && msgEl) {
      msgEl.textContent = 'Server communication error during registration';
      alertEl.style.display = 'block';
    }
  }
}
window.handleCivilianSignUp = handleCivilianSignUp;

async function handleAdminCreateUser(event) {
  event.preventDefault();
  const username = document.getElementById('admin-new-username').value.trim().toLowerCase();
  const role = document.getElementById('admin-new-role').value;
  const fullName = document.getElementById('admin-new-fullname').value.trim();
  const email = document.getElementById('admin-new-email').value.trim().toLowerCase();
  const password = document.getElementById('admin-new-password').value;
  const statusEl = document.getElementById('admin-user-create-status');

  if (!currentUser || !currentUser.token) {
    statusEl.innerHTML = '<span style="color: var(--nex-crimson);">⚠️ Administrator session token required. Please sign in as admin.</span>';
    return;
  }

  statusEl.innerHTML = '<span style="color: var(--nex-cyan);">Provisioning official account...</span>';

  try {
    const res = await fetch('/users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentUser.token}`
      },
      body: JSON.stringify({
        username: username,
        full_name: fullName,
        email: email,
        password: password,
        role: role
      })
    });

    const data = await res.json();
    if (!res.ok) {
      statusEl.innerHTML = `<span style="color: var(--nex-crimson);"><i class="fa-solid fa-triangle-exclamation"></i> ${data.detail || 'Failed to create user'}</span>`;
      return;
    }

    statusEl.innerHTML = `<span style="color: var(--nex-emerald);"><i class="fa-solid fa-circle-check"></i> Account <b>${data.username}</b> provisioned successfully as <b>${data.role.toUpperCase()}</b>!</span>`;
    document.getElementById('admin-create-user-form').reset();
    loadUsersTable();
    loadAuditLogs();
  } catch (err) {
    statusEl.innerHTML = '<span style="color: var(--nex-crimson);">Error communicating with server</span>';
  }
}
window.handleAdminCreateUser = handleAdminCreateUser;

function loginSuccess(username, role, name, title, token) {
  currentUser = { username, role, name, title, token };
  localStorage.setItem('nexterra_session', JSON.stringify(currentUser));

  // Update profile badge in header
  document.getElementById('user-display-name').textContent = name;
  document.getElementById('user-display-role').textContent = title;

  const avatar = document.getElementById('user-avatar-icon');
  if (role === 'admin') {
    avatar.innerHTML = '<i class="fa-solid fa-user-shield" style="color: var(--nex-amber);"></i>';
  } else if (role === 'field_officer') {
    avatar.innerHTML = '<i class="fa-solid fa-walkie-talkie" style="color: var(--nex-emerald);"></i>';
  } else if (role === 'planner') {
    avatar.innerHTML = '<i class="fa-solid fa-chart-pie" style="color: #c084fc;"></i>';
  } else if (role === 'emergency') {
    avatar.innerHTML = '<i class="fa-solid fa-truck-medical" style="color: var(--nex-crimson);"></i>';
  } else {
    avatar.innerHTML = '<i class="fa-solid fa-car-side" style="color: var(--nex-cyan);"></i>';
  }

  closeAuthModal();
  switchRole(role === 'civilian' ? 'civilian' : role);
}

function openAuthModal() {
  document.getElementById('auth-modal').classList.remove('hidden');
}

function closeAuthModal() {
  document.getElementById('auth-modal').classList.add('hidden');
}

function openChangePwdModal() {
  document.getElementById('change-pwd-modal').classList.remove('hidden');
  document.getElementById('pwd-status-msg').textContent = '';
}

function closeChangePwdModal() {
  document.getElementById('change-pwd-modal').classList.add('hidden');
}

// =========================================================
// 100-MARK EVALUATION SCORECARD MODAL HANDLERS
// =========================================================
function openEvaluationModal() {
  const modal = document.getElementById('eval-modal');
  if (modal) modal.classList.remove('hidden');
  loadEvaluationAndRobustnessData();
}

function closeEvaluationModal() {
  const modal = document.getElementById('eval-modal');
  if (modal) modal.classList.add('hidden');
}

function switchEvalTab(tabId) {
  ['cp1', 'cp2', 'cp3'].forEach(id => {
    const btn = document.getElementById(`eval-tab-btn-${id}`);
    const view = document.getElementById(`eval-view-${id}`);
    if (btn) {
      if (id === tabId) {
        btn.style.borderColor = 'var(--nex-cyan)';
        btn.style.color = 'var(--nex-cyan)';
      } else {
        btn.style.borderColor = 'var(--nex-border)';
        btn.style.color = '#cbd5e1';
      }
    }
    if (view) {
      view.style.display = (id === tabId) ? 'block' : 'none';
    }
  });
}

async function loadEvaluationAndRobustnessData() {
  try {
    // 1. Fetch Incident Metrics
    const incRes = await fetch('/api/incident/metrics');
    if (incRes.ok) {
      const incData = await incRes.json();
      const pEl = document.getElementById('metric-precision');
      const rEl = document.getElementById('metric-recall');
      const f1El = document.getElementById('metric-f1');
      const faEl = document.getElementById('metric-fa');
      if (pEl && incData.precision !== undefined) pEl.textContent = `${(incData.precision * 100).toFixed(1)}%`;
      if (rEl && incData.recall !== undefined) rEl.textContent = `${(incData.recall * 100).toFixed(1)}%`;
      if (f1El && incData.f1_score !== undefined) f1El.textContent = incData.f1_score.toFixed(3);
      if (faEl && incData.false_alarms_per_day !== undefined) faEl.textContent = `${incData.false_alarms_per_day} / day`;
    }

    // 2. Fetch Robustness Scenarios
    const robRes = await fetch('/api/robustness');
    if (robRes.ok) {
      const robData = await robRes.json();
      const robTbody = document.getElementById('robustness-tbody');
      if (robTbody && robData.scenarios && robData.scenarios.length > 0) {
        robTbody.innerHTML = '';
        robData.scenarios.forEach(sc => {
          const tr = document.createElement('tr');
          const degColor = sc.mae_degradation_pct > 25 ? '#ff85a1' : (sc.mae_degradation_pct > 10 ? 'var(--nex-amber)' : 'var(--nex-emerald)');
          tr.innerHTML = `
            <td><b>${sc.scenario_name}</b></td>
            <td style="color: ${degColor}; font-weight: 700;">${sc.mae_degradation_pct > 0 ? '+' : ''}${sc.mae_degradation_pct}%</td>
            <td>${sc.f1_incident_score.toFixed(2)}</td>
            <td><span style="color: var(--nex-emerald); font-weight: 700;">${sc.robustness_rating}</span></td>
          `;
          robTbody.appendChild(tr);
        });
      }
    }

    // 3. Fetch Forecast Benchmark
    const benchRes = await fetch('/api/forecast/benchmark');
    if (benchRes.ok) {
      const benchData = await benchRes.json();
      const benchTbody = document.getElementById('forecast-benchmark-tbody');
      if (benchTbody && Object.keys(benchData).length > 0) {
        benchTbody.innerHTML = '';
        Object.entries(benchData).forEach(([horizon, metrics]) => {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td><b>${horizon} Ahead</b></td>
            <td style="color: var(--nex-cyan); font-weight: 700;">${metrics.our_model.mae} km/h</td>
            <td style="color: #94a3b8;">${metrics.persistence_baseline.mae} km/h</td>
            <td style="color: var(--nex-emerald); font-weight: 800;">+${metrics.improvement_over_persistence_pct}%</td>
          `;
          benchTbody.appendChild(tr);
        });
      }
    }
  } catch (err) {
    console.error("Error loading evaluation telemetry:", err);
  }
}

async function handleChangePassword(event) {
  event.preventDefault();
  const current_password = document.getElementById('current-pwd-input').value;
  const new_password = document.getElementById('new-pwd-input').value;
  const msgEl = document.getElementById('pwd-status-msg');

  msgEl.innerHTML = '<span style="color: var(--nex-cyan);">Updating credentials...</span>';

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (currentUser.token) headers['Authorization'] = `Bearer ${currentUser.token}`;

    const res = await fetch('/auth/change-password', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ current_password, new_password })
    });

    const data = await res.json();
    if (!res.ok) {
      msgEl.innerHTML = `<span style="color: var(--nex-crimson);">${data.detail || 'Password update failed'}</span>`;
      return;
    }

    msgEl.innerHTML = '<span style="color: var(--nex-emerald);"><i class="fa-solid fa-check"></i> Password updated successfully!</span>';
    setTimeout(closeChangePwdModal, 1500);

  } catch (err) {
    msgEl.innerHTML = '<span style="color: var(--nex-crimson);">Error updating password</span>';
  }
}

function logoutUser() {
  localStorage.removeItem('nexterra_session');
  openAuthModal();
}

function showDemoCredentialsHelper() {
  fillCredentials('admin', 'AdminPass123!', 'admin');
}

// =========================================================
// 3. ROLE PORTAL SWITCHER
// =========================================================
function switchRole(roleKey) {
  // Normalize role keys
  const validPills = ['operator', 'field_officer', 'planner', 'admin', 'civilian', 'emergency'];
  const activeKey = validPills.includes(roleKey) ? roleKey : 'operator';

  // Security / Demo Check: Ensure emergency credentials for 108 Emergency Green Corridor Dispatch
  if (activeKey === 'emergency') {
    const isAuthorized = ['emergency', 'field_officer', 'operator', 'admin'].includes(currentUser.role) || currentUser.username === 'ems108';
    if (!isAuthorized || !currentUser.token) {
      // Seamlessly acquire EMS demo session so user can test emergency features instantly
      ensureEmsDemoSession();
    }
  }

  // Toggle pills
  document.querySelectorAll('.nav-pill-btn').forEach(btn => {
    btn.classList.remove('active');
  });

  const pillMap = {
    'operator': 'pill-operator',
    'field_officer': 'pill-field',
    'planner': 'pill-planner',
    'admin': 'pill-admin',
    'civilian': 'pill-civilian',
    'emergency': 'pill-emergency'
  };

  const pillEl = document.getElementById(pillMap[activeKey]);
  if (pillEl) pillEl.classList.add('active');

  // Toggle view panels
  document.querySelectorAll('.nex-tab-view').forEach(v => v.classList.remove('active'));

  const viewMap = {
    'operator': 'view-operator',
    'field_officer': 'view-field',
    'planner': 'view-planner',
    'admin': 'view-admin',
    'civilian': 'view-civilian',
    'emergency': 'view-emergency'
  };

  const viewEl = document.getElementById(viewMap[activeKey]);
  if (viewEl) viewEl.classList.add('active');

  // Trigger role-specific data fetches
  if (activeKey === 'civilian') calculateMLCivilianRoutes();
  if (activeKey === 'field_officer') loadFieldIncidents();
  if (activeKey === 'planner') fetchInfrastructureCandidates();
  if (activeKey === 'admin') { loadUsersTable(); loadAuditLogs(); }
}

function toggleNavOptions() {
  const pills = document.getElementById('main-nav-pills');
  const evalBtn = document.getElementById('btn-eval-rubric');
  if (pills) pills.classList.toggle('show-nav');
  if (evalBtn) evalBtn.classList.toggle('show-nav');
}
window.toggleNavOptions = toggleNavOptions;

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 'm') {
    e.preventDefault();
    toggleNavOptions();
  }
});


// =========================================================
// 4. OPERATOR CONSOLE CONTROLLER
// =========================================================
async function fetchNetworkState(timestamp = null) {
  try {
    let url = '/api/state';
    if (timestamp) url += `?timestamp=${encodeURIComponent(timestamp)}`;
    const res = await fetch(url);
    const data = await res.json();

    currentSegmentStates = data.segment_states || {};
    availableTimestamps = data.available_timestamps || [];

    // Update timeline slider bounds
    const slider = document.getElementById('time-slider');
    if (availableTimestamps.length > 0 && slider) {
      slider.max = availableTimestamps.length - 1;
      if (!timestamp) {
        const timeDisplay = document.getElementById('current-time-display');
        if (timeDisplay) timeDisplay.textContent = availableTimestamps[0];
      }
    }

    // Update Telemetry KPIs
    document.getElementById('kpi-congested').textContent = data.congested_segments_count;
    document.getElementById('kpi-delay').textContent = `${data.total_delay_min} min`;
    document.getElementById('kpi-spillbacks').textContent = data.detected_spillbacks ? data.detected_spillbacks.length : 0;

    // Refresh network styles (only highlight bottlenecks/congested links, keep free-flow clean & transparent)
    if (networkLayer && layerVisibility.segments) {
      networkLayer.eachLayer(layer => {
        const segId = layer.feature.properties.segment_id;
        const state = currentSegmentStates[segId];
        const level = state ? state.congestion_level : "free";
        if (level === 'jam' || level === 'heavy' || level === 'slow') {
          const color = CONGESTION_COLORS[level];
          const weight = (level === 'jam' || level === 'heavy') ? 5.5 : 3.5;
          layer.setStyle({ color: color, weight: weight, opacity: 0.9, fillOpacity: 0.9 });
        } else {
          // Free flow traffic: completely transparent/hidden (no green lines)
          layer.setStyle({ color: 'transparent', weight: 0, opacity: 0, fillOpacity: 0 });
        }
      });
    }

  } catch (err) {
    console.error("Error fetching state:", err);
  }
}

async function fetchAlerts(timestamp = null) {
  try {
    let url = '/api/alerts';
    if (timestamp) url += `?timestamp=${encodeURIComponent(timestamp)}`;
    const res = await fetch(url);
    const alerts = await res.json();

    const container = document.getElementById('alerts-container');
    const countBadge = document.getElementById('alerts-count-badge');
    const kpiCount = document.getElementById('kpi-incidents-count');

    if (countBadge) countBadge.textContent = `${alerts.length} Active`;
    if (kpiCount) kpiCount.textContent = alerts.length;

    // Clear and redraw map incident markers
    if (isGoogleMaps && gMap) {
      gIncidentMarkers.forEach(m => m.setMap(null));
      gIncidentMarkers = [];
      alerts.forEach(a => {
        if (a.coordinates && layerVisibility.incidents) {
          const circle = new google.maps.Circle({
            strokeColor: a.severity >= 2 ? '#FF3366' : '#FFB800',
            strokeOpacity: 0.9,
            strokeWeight: 2,
            fillColor: a.severity >= 2 ? '#FF3366' : '#FFB800',
            fillOpacity: 0.8,
            map: gMap,
            center: { lat: a.coordinates[0], lng: a.coordinates[1] },
            radius: 140
          });
          gIncidentMarkers.push(circle);
        }
      });
    } else if (incidentLayer) {
      incidentLayer.clearLayers();
      alerts.forEach(a => {
        if (a.coordinates && layerVisibility.incidents) {
          const marker = L.circleMarker(a.coordinates, {
            radius: 8,
            color: a.severity >= 2 ? '#FF3366' : '#FFB800',
            fillColor: a.severity >= 2 ? '#FF3366' : '#FFB800',
            fillOpacity: 0.85
          });
          marker.bindPopup(`<b>${a.incident_type}</b><br>Severity: ${a.severity}<br>Speed Drop: -${a.speed_drop_kmh} km/h`);
          incidentLayer.addLayer(marker);
        }
      });
    }

    if (!container) return;

    if (alerts.length === 0) {
      container.innerHTML = '<div style="font-size: 0.8rem; color: #64748b; padding: 12px; text-align: center;">No active anomalies detected. Hyderabad grid nominal.</div>';
      return;
    }

    container.innerHTML = '';
    alerts.forEach(a => {
      const card = document.createElement('div');
      card.className = `incident-card ${a.severity >= 2 ? 'critical' : ''}`;
      card.innerHTML = `
        <div style="display: flex; justify-content: space-between; font-weight: 700; font-size: 0.84rem; margin-bottom: 4px;">
          <span style="color: ${a.severity >= 2 ? 'var(--nex-crimson)' : 'var(--nex-amber)'};">
            <i class="fa-solid fa-triangle-exclamation"></i> ${a.incident_type.replace('_', ' ').toUpperCase()}
          </span>
          <span style="font-size: 0.7rem; color: #fff; background: rgba(0,0,0,0.5); padding: 2px 8px; border-radius: 6px;">Severity ${a.severity}</span>
        </div>
        <div style="font-size: 0.76rem; color: #e2e8f0; margin-bottom: 4px;">
          Link <b>${a.segment_id}</b> (${a.source_node} &rarr; ${a.target_node}) • Speed: <b>${a.speed_kmh} km/h</b> (-${a.speed_drop_kmh} km/h)
        </div>
        <div style="font-size: 0.72rem; color: #94a3b8;">
          ${a.contributing_factors ? a.contributing_factors.join(' • ') : ''}
        </div>
        <div class="incident-actions" style="margin-top: 6px;">
          <button class="btn-action-sm btn-acknowledge" onclick="handleAlertAction('${a.incident_id}', 'acknowledge')">
            <i class="fa-solid fa-check"></i> Ack
          </button>
          <button class="btn-action-sm btn-dismiss" onclick="handleAlertAction('${a.incident_id}', 'dismiss')">
            <i class="fa-solid fa-xmark"></i> Dismiss
          </button>
          <button class="btn-action-sm" onclick="classifyIncidentWithGemini('${a.incident_id}', '${a.segment_id}', ${a.speed_kmh}, ${a.speed_drop_kmh}, ${a.queue_length_veh || 0})" style="background: rgba(0, 229, 255, 0.15); border: 1px solid var(--nex-cyan); color: var(--nex-cyan);">
            <i class="fa-solid fa-brain"></i> Gemini AI
          </button>
        </div>
        <div id="gemini-inc-details-${a.incident_id}" style="display: none; margin-top: 8px; padding: 10px; background: rgba(5, 9, 16, 0.9); border: 1px solid rgba(0, 229, 255, 0.3); border-radius: 8px; font-size: 0.73rem;"></div>
      `;
      container.appendChild(card);
    });

  } catch (err) {
    console.error("Error fetching alerts:", err);
  }
}

async function handleAlertAction(alertId, action) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (currentUser.token) headers['Authorization'] = `Bearer ${currentUser.token}`;

    const res = await fetch(`/api/alerts/${alertId}/action`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ action: action, notes: `Actioned by ${currentUser.username}` })
    });

    if (res.ok) {
      await fetchAlerts();
    }
  } catch (err) {
    console.error("Alert action failed:", err);
  }
}

async function fetchAdvisories(timestamp = null) {
  try {
    let url = '/api/advisories';
    if (timestamp) url += `?timestamp=${encodeURIComponent(timestamp)}`;
    const headers = {};
    if (currentUser.token) headers['Authorization'] = `Bearer ${currentUser.token}`;

    const res = await fetch(url, { headers });
    if (!res.ok) return;
    const advisories = await res.json();

    const container = document.getElementById('advisories-container');
    if (!container) return;

    if (advisories.length === 0) {
      container.innerHTML = '<div style="font-size: 0.8rem; color: #64748b; padding: 12px; text-align: center;">No active dynamic diversions needed.</div>';
      return;
    }

    container.innerHTML = '';
    advisories.slice(0, 5).forEach(adv => {
      const box = document.createElement('div');
      box.style.cssText = 'background: rgba(6, 11, 20, 0.8); border: 1px solid var(--nex-border); border-radius: 12px; padding: 12px; margin-bottom: 8px;';
      box.innerHTML = `
        <div style="display: flex; justify-content: space-between; font-size: 0.8rem; font-weight: 700; color: var(--nex-emerald); margin-bottom: 4px;">
          <span>${adv.advisory_id}</span>
          <span style="color: var(--nex-cyan);">-${adv.simulated_benefit?.delay_reduction_pct || 15}% Delay</span>
        </div>
        <div style="font-size: 0.74rem; color: #cbd5e1; margin-bottom: 6px;">${adv.summary || 'Dynamic diversion route recommended.'}</div>
        <div style="display: flex; gap: 8px;">
          <button class="btn-action-sm btn-reached" onclick="handleAdvisoryAction('${adv.advisory_id}', 'approve')"><i class="fa-solid fa-check"></i> Approve</button>
          <button class="btn-action-sm btn-dismiss" onclick="handleAdvisoryAction('${adv.advisory_id}', 'reject')"><i class="fa-solid fa-xmark"></i> Reject</button>
        </div>
      `;
      container.appendChild(box);
    });
  } catch (err) {
    console.warn("Could not load advisories:", err);
  }
}

async function handleAdvisoryAction(advisoryId, action) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (currentUser.token) headers['Authorization'] = `Bearer ${currentUser.token}`;

    const res = await fetch(`/api/advisories/${advisoryId}/action`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ action: action, reason: `Operator ${currentUser.username} manual action` })
    });
    if (res.ok) await fetchAdvisories();
  } catch (e) {}
}

// Multi-Horizon Forecast Chart
function initForecastChart() {
  const canvas = document.getElementById('forecastChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  forecastChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: ['Now (0m)', '+15m', '+30m', '+45m', '+60m'],
      datasets: [
        {
          label: 'Upper Bound (P90)',
          data: [50, 52, 54, 55, 56],
          borderColor: 'rgba(0, 229, 255, 0.35)',
          borderDash: [4, 4],
          fill: false,
          pointRadius: 0
        },
        {
          label: 'Forecast Speed (P50)',
          data: [50, 48, 46, 49, 52],
          borderColor: '#00E5FF',
          backgroundColor: 'rgba(0, 229, 255, 0.12)',
          fill: true,
          tension: 0.35,
          pointBackgroundColor: '#00F5A0',
          pointRadius: 4
        },
        {
          label: 'Lower Bound (P10)',
          data: [50, 42, 38, 41, 44],
          borderColor: 'rgba(0, 229, 255, 0.35)',
          borderDash: [4, 4],
          fill: false,
          pointRadius: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: {
          title: { display: true, text: 'km/h', color: '#94a3b8' },
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: '#cbd5e1' }
        },
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: '#cbd5e1' }
        }
      }
    }
  });

  updateForecastView();
}

async function updateForecastView() {
  const fSeg = document.getElementById('forecast-segment');
  if (!fSeg || !fSeg.value) return;
  const segId = fSeg.value;

  try {
    const headers = {};
    if (currentUser.token) headers['Authorization'] = `Bearer ${currentUser.token}`;
    const res = await fetch(`/api/forecast?segment_id=${segId}`, { headers });
    if (!res.ok) return;
    const data = await res.json();
    if (!forecastChart) return;

    const curr = data.current_speed_kmh;
    const f15 = data.forecasts['15m'];
    const f30 = data.forecasts['30m'];
    const f45 = data.forecasts['45m'];
    const f60 = data.forecasts['60m'];

    forecastChart.data.datasets[0].data = [curr, f15.upper_bound_kmh, f30.upper_bound_kmh, f45.upper_bound_kmh, f60.upper_bound_kmh];
    forecastChart.data.datasets[1].data = [curr, f15.predicted_speed_kmh, f30.predicted_speed_kmh, f45.predicted_speed_kmh, f60.predicted_speed_kmh];
    forecastChart.data.datasets[2].data = [curr, f15.lower_bound_kmh, f30.lower_bound_kmh, f45.lower_bound_kmh, f60.lower_bound_kmh];
    forecastChart.update();

    document.getElementById('forecast-details').innerHTML = `
      Velocity: <b style="color:#fff;">${curr} km/h</b> (Free Flow: ${data.free_flow_speed_kmh} km/h)<br>
      +30m Outlook: <b style="color:var(--nex-cyan);">${f30.predicted_speed_kmh} km/h</b> [${f30.lower_bound_kmh} - ${f30.upper_bound_kmh} km/h] (Confidence: ${(f30.confidence_score * 100).toFixed(0)}%)
    `;
  } catch (err) {}
}

// Timeline Slider Scrubber
function onTimeSliderChange(index) {
  if (availableTimestamps.length > index) {
    const ts = availableTimestamps[index];
    const timeDisplay = document.getElementById('current-time-display');
    if (timeDisplay) timeDisplay.textContent = ts;
    fetchNetworkState(ts);
    fetchAlerts(ts);
    fetchAdvisories(ts);
  }
}

function togglePlaySimulation() {
  isPlaying = !isPlaying;
  const btn = document.getElementById('play-icon');
  if (btn) {
    btn.className = isPlaying ? 'fa-solid fa-pause' : 'fa-solid fa-play';
  }
  if (isPlaying) {
    playInterval = setInterval(() => {
      const slider = document.getElementById('time-slider');
      if (!slider) return;
      let val = parseInt(slider.value) + 1;
      if (val >= availableTimestamps.length) val = 0;
      slider.value = val;
      onTimeSliderChange(val);
    }, 2200);
  } else {
    clearInterval(playInterval);
  }
}

// =========================================================
// 5. FIELD OFFICER MOBILE-FIRST HUB
// =========================================================
async function loadFieldIncidents() {
  const zone = document.getElementById('field-zone-select').value;
  const container = document.getElementById('field-incidents-list');
  if (!container) return;

  try {
    const res = await fetch('/api/alerts');
    const alerts = await res.json();

    if (alerts.length === 0) {
      container.innerHTML = `<div style="font-size: 0.82rem; color: #64748b; padding: 18px; text-align: center;">No active incidents in ${zone}. Patrol is clear.</div>`;
      return;
    }

    container.innerHTML = '';
    alerts.forEach(a => {
      const card = document.createElement('div');
      card.className = 'incident-card';
      card.innerHTML = `
        <div style="display: flex; justify-content: space-between; font-weight: 700; font-size: 0.86rem; margin-bottom: 6px;">
          <span style="color: var(--nex-amber);"><i class="fa-solid fa-triangle-exclamation"></i> ${a.incident_type.replace('_', ' ').toUpperCase()}</span>
          <span class="badge-role badge-field">${zone}</span>
        </div>
        <div style="font-size: 0.78rem; color: #fff; margin-bottom: 6px;">
          Segment: <b>${a.segment_id}</b> (${a.source_node} &rarr; ${a.target_node})
        </div>
        <div style="font-size: 0.72rem; color: #94a3b8; margin-bottom: 10px;">
          Speed: <b>${a.speed_kmh} km/h</b> • Delay: <b>${a.queue_length_veh || 12} veh</b> queued
        </div>
        <div style="display: flex; gap: 6px; flex-wrap: wrap;">
          <button class="btn-action-sm btn-reached" onclick="handleFieldIncidentAction('${a.incident_id}', 'reached')">
            <i class="fa-solid fa-location-crosshairs"></i> Arrived
          </button>
          <button class="btn-action-sm btn-cleared" onclick="handleFieldIncidentAction('${a.incident_id}', 'cleared')">
            <i class="fa-solid fa-circle-check"></i> Cleared
          </button>
          <button class="btn-action-sm btn-false-alarm" onclick="handleFieldIncidentAction('${a.incident_id}', 'false_alarm')">
            <i class="fa-solid fa-ban"></i> False Alarm
          </button>
        </div>
      `;
      container.appendChild(card);
    });

  } catch (err) {
    container.innerHTML = '<div style="font-size: 0.8rem; color: #ff85a1;">Error loading field incidents</div>';
  }
}

async function handleFieldIncidentAction(incidentId, status) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (currentUser.token) headers['Authorization'] = `Bearer ${currentUser.token}`;

    const res = await fetch('/api/field/incident-action', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        incident_id: incidentId,
        status: status,
        notes: `Reported from patrol terminal by ${currentUser.username}`
      })
    });

    if (res.ok) {
      alert(`Incident status updated to: ${status.toUpperCase()}`);
      await loadFieldIncidents();
      await fetchAlerts();
    }
  } catch (e) {
    alert("Could not update incident status");
  }
}

// =========================================================
// 6. CITY PLANNER SANDBOX & INFRASTRUCTURE
// =========================================================
async function fetchInfrastructureCandidates() {
  try {
    const headers = {};
    if (currentUser.token) headers['Authorization'] = `Bearer ${currentUser.token}`;

    const res = await fetch('/api/infrastructure', { headers });
    if (!res.ok) return;
    allCandidates = await res.json();

    const select = document.getElementById('candidate-select');
    if (!select) return;
    select.innerHTML = '';

    allCandidates.slice(0, 15).forEach((c, idx) => {
      const opt = document.createElement('option');
      opt.value = idx;
      opt.textContent = `${c.candidate_id}: ${c.intervention_type} on ${c.target_segment} (+${c.capacity_delta_vph} vph)`;
      select.appendChild(opt);
    });

    updateCandidateView();
  } catch (err) {}
}

function updateCandidateView() {
  const idx = document.getElementById('candidate-select').value;
  if (idx === '' || !allCandidates[idx]) return;
  const c = allCandidates[idx];

  document.getElementById('candidate-metrics').innerHTML = `
    <div style="background: rgba(5, 9, 16, 0.85); border: 1px solid var(--nex-border); padding: 12px; border-radius: 14px; margin-top: 8px;">
      <div style="display:flex; justify-content:space-between; margin-bottom: 6px; font-size: 0.8rem;">
        <span style="color:#cbd5e1;">Intervention: <b>${c.intervention_type}</b></span>
        <span style="color:var(--nex-cyan); font-weight:700;">${c.feasibility_band.toUpperCase()} FEASIBILITY</span>
      </div>
      <div style="display:flex; justify-content:space-between; margin-bottom: 6px; font-size: 0.8rem;">
        <span>Delay Before: <b style="color:var(--nex-crimson);">${c.before_metrics.delay_min} min</b></span>
        <span>Delay After: <b style="color:var(--nex-emerald);">${c.after_metrics.delay_min} min</b></span>
      </div>
      <div style="display:flex; justify-content:space-between; margin-bottom: 6px; font-size: 0.8rem;">
        <span>Speed Before: <b>${c.before_metrics.speed_kmh} km/h</b></span>
        <span>Speed After: <b>${c.after_metrics.speed_kmh} km/h</b></span>
      </div>
      <div style="border-top: 1px solid rgba(255,255,255,0.08); padding-top: 6px; margin-top: 6px; color: #c084fc; font-size: 0.82rem; font-weight: 700; display: flex; justify-content: space-between;">
        <span>Net Saved: ${c.impact.travel_time_saved_min} min (${c.impact.delay_reduction_pct}%)</span>
        <span>BCR Index: ${c.impact.benefit_cost_ratio}</span>
      </div>
    </div>
  `;
}

async function runWhatIfSimulation() {
  const demand = parseFloat(document.getElementById('whatif-demand').value);
  const closed = document.getElementById('whatif-closure').value || null;
  const resDiv = document.getElementById('whatif-results');

  resDiv.style.display = 'block';
  resDiv.innerHTML = '<span style="color: var(--nex-cyan);"><i class="fa-solid fa-spinner fa-spin"></i> Running BPR macroscopic simulator...</span>';

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (currentUser.token) headers['Authorization'] = `Bearer ${currentUser.token}`;

    const res = await fetch('/api/simulation/what-if', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ demand_multiplier: demand, closed_segment: closed })
    });

    const data = await res.json();
    if (!res.ok) {
      resDiv.innerHTML = `<span style="color: var(--nex-crimson);">${data.detail || 'Simulation error'}</span>`;
      return;
    }

    resDiv.innerHTML = `
      <div style="font-weight: 700; font-size: 0.84rem; color: #fff; margin-bottom: 6px;">Simulation Results:</div>
      <div style="font-size: 0.78rem; color: #cbd5e1;">
        Simulated Network Congestion: <b style="color: var(--nex-crimson);">${data.simulated_congestion_pct}%</b><br>
        Total Projected Delay: <b style="color: var(--nex-amber);">${data.simulated_total_delay_min} min</b><br>
        Bottleneck Spillbacks: <b style="color: #c084fc;">${data.spillbacks_detected}</b>
      </div>
    `;
  } catch (err) {
    resDiv.innerHTML = '<span style="color: var(--nex-crimson);">Simulation request failed</span>';
  }
}

// =========================================================
// 7. SYSTEM ADMIN DIRECTORY & AUDIT LOGS
// =========================================================
async function loadUsersTable() {
  const tbody = document.getElementById('users-tbody');
  if (!tbody) return;

  try {
    const headers = {};
    if (currentUser.token) headers['Authorization'] = `Bearer ${currentUser.token}`;
    const res = await fetch('/users', { headers });
    if (!res.ok) {
      tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: #64748b;">Requires Administrator Privileges</td></tr>';
      return;
    }

    const users = await res.json();
    tbody.innerHTML = '';
    users.forEach(u => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><b>${u.username}</b></td>
        <td><span class="badge-role badge-${u.role}">${u.role.toUpperCase()}</span></td>
        <td><span style="color: ${u.is_active ? 'var(--nex-emerald)' : 'var(--nex-crimson)'};">${u.is_active ? 'Active' : 'Locked'}</span></td>
      `;
      tbody.appendChild(tr);
    });

  } catch (err) {}
}

async function loadAuditLogs() {
  const tbody = document.getElementById('audit-tbody');
  if (!tbody) return;

  try {
    const headers = {};
    if (currentUser.token) headers['Authorization'] = `Bearer ${currentUser.token}`;
    const res = await fetch('/audit-logs?limit=15', { headers });
    if (!res.ok) {
      tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: #64748b;">Requires Administrator Privileges</td></tr>';
      return;
    }

    const logs = await res.json();
    tbody.innerHTML = '';
    logs.forEach(l => {
      const tr = document.createElement('tr');
      const timeStr = l.timestamp ? l.timestamp.split('T')[1].split('.')[0] : '--:--';
      tr.innerHTML = `
        <td style="font-family: var(--font-mono); font-size: 0.72rem; color: #94a3b8;">${timeStr}</td>
        <td><b>${l.username}</b></td>
        <td style="color: var(--nex-cyan);">${l.action}</td>
      `;
      tbody.appendChild(tr);
    });

  } catch (err) {}
}

async function handleDatasetUpload(event) {
  event.preventDefault();
  const category = document.getElementById('upload-category').value;
  const fileInput = document.getElementById('upload-file');
  const statusDiv = document.getElementById('upload-status');

  if (!fileInput.files || fileInput.files.length === 0) {
    alert("Please select a CSV file to upload.");
    return;
  }

  const formData = new FormData();
  formData.append('file_type', category);
  formData.append('file', fileInput.files[0]);

  statusDiv.innerHTML = '<span style="color: var(--nex-cyan);"><i class="fa-solid fa-spinner fa-spin"></i> Ingesting and validating schema...</span>';

  try {
    const headers = {};
    if (currentUser.token) headers['Authorization'] = `Bearer ${currentUser.token}`;

    const res = await fetch('/api/admin/upload', {
      method: 'POST',
      headers: headers,
      body: formData
    });
    const result = await res.json();

    if (!res.ok) {
      statusDiv.innerHTML = `<span style="color: var(--nex-crimson);">Upload error: ${result.detail || 'Validation failed'}</span>`;
      return;
    }

    statusDiv.innerHTML = `<span style="color: var(--nex-emerald);"><i class="fa-solid fa-check"></i> ${result.status}</span>`;
    await fetchNetworkState();
    await fetchAlerts();

  } catch (err) {
    statusDiv.innerHTML = `<span style="color: var(--nex-crimson);">Network error during upload</span>`;
  }
}

// =========================================================
// 8. COMMUTER & EMERGENCY GREEN CORRIDOR CONTROLLER
// =========================================================
async function calculateMLCivilianRoutes() {
  const origInput = document.getElementById('civil-origin-input');
  const destInput = document.getElementById('civil-dest-input');
  const origSel = document.getElementById('civil-origin');
  const destSel = document.getElementById('civil-dest');

  let origin = (origInput && resolveNodeId(origInput.value)) || (origSel && origSel.value) || 'N014';
  let dest = (destInput && resolveNodeId(destInput.value)) || (destSel && destSel.value) || 'N086';

  // Synchronize inputs with canonical node labels
  if (origInput && origin) origInput.value = getNodeDisplayLabel(origin);
  if (destInput && dest) destInput.value = getNodeDisplayLabel(dest);
  if (origSel && origin) origSel.value = origin;
  if (destSel && dest) destSel.value = dest;

  if (origin === dest) {
    alert("Please select different FROM (Origin) and TO (Destination) junctions.");
    return;
  }

  const origLabel = origInput ? origInput.value : getNodeDisplayLabel(origin);
  const destLabel = destInput ? destInput.value : getNodeDisplayLabel(dest);
  const timeDisplay = document.getElementById('live-departure-clock');
  const presTimeStr = timeDisplay ? timeDisplay.textContent.trim() : 'Live Departure (IST)';

  try {
    const res = await fetch('/api/route/ml-predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin_node: origin,
        destination_node: dest,
        k: 3,
        origin_label: origLabel,
        destination_label: destLabel,
        present_time: presTimeStr
      })
    });
    const data = await res.json();

    if (!res.ok) {
      alert(data.detail || "Route prediction failed");
      return;
    }

    currentMLRoutes = data.routes || [];
    if (data.gemini_historical_decision && currentMLRoutes.length > 0) {
      currentMLRoutes[0]._cached_decision = data.gemini_historical_decision;
    }
    renderMLRoutes(currentMLRoutes, data.emergency_alert);

    if (data.gemini_historical_decision || data.gemini_advisory) {
      renderGeminiRouteAdvisor(data.gemini_advisory, data.gemini_historical_decision);
    }

    if (currentMLRoutes.length > 0) {
      selectMLRoute(0);
    }
  } catch (err) {
    console.error("ML Route Prediction Error:", err);
  }
}

function renderGeminiRouteAdvisor(advisory, historicalDecision) {
  const card = document.getElementById('gemini-route-advisor-card');
  if (!card) return;

  const decision = historicalDecision || advisory;
  if (!decision) return;

  card.style.display = 'block';

  // Core title and reasoning
  const title = document.getElementById('gemini-route-title');
  const reasoning = document.getElementById('gemini-route-reasoning');
  const histInsight = document.getElementById('gemini-route-hist-insight');
  const badge = document.getElementById('gemini-route-badge');
  const dbGroundingBadge = document.getElementById('gemini-db-grounding-badge');
  const dbGroundingText = document.getElementById('gemini-db-grounding-text');
  const urgency = document.getElementById('gemini-route-urgency');
  const hazard = document.getElementById('gemini-route-hazard');
  const reliability = document.getElementById('gemini-route-reliability');
  const tipsList = document.getElementById('gemini-route-tips');
  const verdictBanner = document.getElementById('gemini-route-verdict');
  const verdictText = document.getElementById('gemini-route-verdict-text');

  // Time anchors & speed comparison elements
  const timePres = document.getElementById('gemini-time-present');
  const timePast = document.getElementById('gemini-time-past');
  const spdPres = document.getElementById('gemini-speed-present');
  const spdPast = document.getElementById('gemini-speed-past');
  const spdDelta = document.getElementById('gemini-speed-delta');
  const recEl = document.getElementById('gemini-recurrence');

  if (title) title.textContent = decision.decision_title || decision.recommendation_title || 'AI Route Recommendation';
  if (reasoning) reasoning.textContent = decision.present_vs_past_analysis || decision.ai_reasoning || '';

  if (histInsight) {
    if (decision.historical_pattern_insight) {
      histInsight.style.display = 'block';
      histInsight.innerHTML = `<b><i class="fa-solid fa-chart-line"></i> Historical DB Insight:</b> ${decision.historical_pattern_insight}`;
    } else {
      histInsight.style.display = 'none';
    }
  }

  if (badge) badge.textContent = decision.powered_by || 'Google Gemini 1.5 Flash';
  if (dbGroundingText) {
    dbGroundingText.textContent = decision.historical_db_grounding ? 'Verified DB' : '30k+ DB Records';
  }
  if (urgency) urgency.textContent = decision.departure_urgency || 'Depart Now';
  if (hazard) {
    const haz = decision.hazard_assessment || (decision.decision_verdict ? decision.decision_verdict.replace('_', ' ') : 'Low Risk');
    hazard.textContent = haz;
    hazard.style.color = haz.includes('CONFLICT') ? 'var(--nex-crimson)' : (haz.includes('BOTTLENECK') || haz.includes('MODERATE') ? 'var(--nex-amber)' : 'var(--nex-cyan)');
  }
  if (reliability) reliability.textContent = decision.safety_and_reliability_rating || decision.expected_reliability || '94%';

  // Verdict style banner
  if (verdictBanner && verdictText) {
    const v = decision.decision_verdict || 'ROUTE CONFIRMED (OPTIMAL)';
    verdictBanner.className = 'verdict-banner ' + (v.includes('CONFLICT') ? 'verdict-conflict' : (v.includes('BOTTLENECK') || v.includes('CAUTION') ? 'verdict-bottleneck' : 'verdict-optimal'));
    verdictText.innerHTML = `<i class="fa-solid ${v.includes('CONFLICT') ? 'fa-triangle-exclamation' : (v.includes('BOTTLENECK') ? 'fa-clock' : 'fa-circle-check')}"></i> ${v}`;
  }

  // Speed Metrics & Time Anchors from database
  const metrics = decision.speed_metrics || (decision.historical_analytics || {});
  if (metrics) {
    if (timePres) timePres.textContent = metrics.present_time || (document.getElementById('live-departure-clock') ? document.getElementById('live-departure-clock').textContent.trim() : 'Live Present Time');
    if (timePast) timePast.textContent = metrics.past_time || 'Historical Baseline (T-60m)';
    if (spdPres) spdPres.textContent = `${metrics.present_speed_kmh || 42.0} km/h`;
    if (spdPast) spdPast.textContent = `${metrics.past_avg_speed_kmh || 46.5} km/h`;
    if (spdDelta) {
      const delta = metrics.speed_delta_pct !== undefined ? metrics.speed_delta_pct : 0.0;
      spdDelta.textContent = `${delta > 0 ? '+' : ''}${delta}%`;
      spdDelta.style.color = delta >= 0 ? 'var(--nex-emerald)' : (delta > -20 ? 'var(--nex-amber)' : 'var(--nex-crimson)');
    }
    if (recEl) recEl.textContent = `${metrics.recurrence_rate_pct !== undefined ? metrics.recurrence_rate_pct : 12}%`;
  }

  const tips = decision.commuter_driving_tips || (decision.recommended_action ? [decision.recommended_action] : []);
  if (tipsList && Array.isArray(tips)) {
    tipsList.innerHTML = tips.map(tip => `<li style="margin-bottom: 3px;">${tip}</li>`).join('');
  }
}

function renderMLRoutes(routes, emergencyAlert) {
  const container = document.getElementById('ml-route-options-card');
  const countBadge = document.getElementById('ml-routes-count-badge');
  const listEl = document.getElementById('ml-routes-list');
  const alertBanner = document.getElementById('route-emergency-alert-banner');
  const alertMsg = document.getElementById('route-emergency-alert-msg');

  if (!container || !listEl) return;

  container.style.display = 'block';
  countBadge.textContent = `${routes.length} Paths`;

  const civilRouteAlert = document.getElementById('civilian-emergency-route-alert');
  const civilAlertMsg = document.getElementById('civilian-emergency-route-alert-msg');

  if (emergencyAlert) {
    alertBanner.style.display = 'block';
    alertMsg.textContent = emergencyAlert.message;
    if (civilRouteAlert) {
      civilRouteAlert.style.display = 'block';
      if (civilAlertMsg) {
        civilAlertMsg.innerHTML = `<b>🚨 ACTIVE PRIORITY EMERGENCY MISSION:</b> ${emergencyAlert.message}<br><span style="color: #fff; font-weight: 700;">⚠️ Traffic signals on this corridor are preempted for emergency services. This alert will remain active until Emergency Services explicitly disables it.</span>`;
      }
    }
  } else {
    const hasConflict = routes.some(r => r.corridor_conflict);
    if (hasConflict) {
      alertBanner.style.display = 'block';
      alertMsg.textContent = "One or more paths cross an active Emergency Green Corridor! Commuters advised to yield.";
      if (civilRouteAlert) {
        civilRouteAlert.style.display = 'block';
        if (civilAlertMsg) {
          civilAlertMsg.innerHTML = `<b>🚨 EMERGENCY CONFLICT DETECTED:</b> Your selected journey route intersects an armed Priority Green Corridor.<br><span style="color: #fff; font-weight: 700;">⚠️ Civilian vehicles must yield right-of-way and take alternative paths. This alert will remain active until Emergency Services disables it.</span>`;
        }
      }
    } else {
      alertBanner.style.display = 'none';
    }
  }

  listEl.innerHTML = '';
  routes.forEach((r, idx) => {
    const card = document.createElement('div');
    card.className = `ml-route-card ${idx === selectedRouteIndex ? 'selected' : ''} ${r.corridor_conflict ? 'emergency-blocked' : ''}`;
    card.id = `ml-route-card-${idx}`;
    card.onclick = () => selectMLRoute(idx);

    let badgeClass = 'badge-optimal';
    let badgeText = 'OPTIMAL SAFE';
    let badgeIcon = 'fa-circle-check';

    if (r.corridor_conflict || r.ml_classification === 'EMERGENCY_CONFLICT') {
      badgeClass = 'badge-conflict';
      badgeText = 'EMERGENCY CONFLICT';
      badgeIcon = 'fa-triangle-exclamation';
    } else if (r.ml_classification === 'BOTTLENECK_PRONE') {
      badgeClass = 'badge-bottleneck';
      badgeText = 'BOTTLENECK PRONE';
      badgeIcon = 'fa-triangle-exclamation';
    } else if (r.ml_classification === 'MODERATE_CONGESTION') {
      badgeClass = 'badge-moderate';
      badgeText = 'MODERATE FLOW';
      badgeIcon = 'fa-clock';
    }

    let barColor = 'var(--nex-emerald)';
    if (r.reliability_score < 50) barColor = 'var(--nex-crimson)';
    else if (r.reliability_score < 75) barColor = 'var(--nex-amber)';

    card.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
        <span style="font-weight: 700; font-size: 0.88rem; color: #fff;">
          ${r.route_label} ${r.is_recommended ? '<span style="color: var(--nex-cyan); font-size: 0.72rem; margin-left: 6px;">[RECOMMENDED]</span>' : ''}
        </span>
        <span class="route-badge ${badgeClass}"><i class="fa-solid ${badgeIcon}"></i> ${badgeText}</span>
      </div>

      <div style="display: flex; justify-content: space-between; font-size: 0.8rem; color: #cbd5e1; margin-bottom: 6px;">
        <span>Pred. Journey: <b style="color: var(--nex-cyan); font-size: 0.95rem;">${r.predicted_travel_time_min} min</b></span>
        <span>Delay: <b style="color: ${r.predicted_delay_min > 0 ? 'var(--nex-amber)' : 'var(--nex-emerald)'};">+${r.predicted_delay_min} min</b></span>
        <span>Dist: <b>${r.distance_km} km</b></span>
      </div>

      <div style="font-size: 0.72rem; color: #94a3b8; display: flex; justify-content: space-between; align-items: center; margin-top: 6px;">
        <span>Signals: <b>${r.signals_count}</b> • ML Conf: <b>${(r.confidence * 100).toFixed(0)}%</b></span>
        <span style="font-weight: 700; color: ${barColor};">Reliability: ${r.reliability_score}%</span>
      </div>
      <div class="reliability-bar-bg">
        <div class="reliability-bar-fill" style="width: ${r.reliability_score}%; background: ${barColor};"></div>
      </div>
    `;

    listEl.appendChild(card);
  });
}

function selectMLRoute(index) {
  if (!currentMLRoutes || !currentMLRoutes[index]) return;
  selectedRouteIndex = index;
  const route = currentMLRoutes[index];
  const routeColor = route.corridor_conflict ? '#FF3366' : (route.is_recommended ? '#00E5FF' : '#38bdf8');

  document.querySelectorAll('.ml-route-card').forEach((c, idx) => {
    if (idx === index) c.classList.add('selected');
    else c.classList.remove('selected');
  });

  const resCard = document.getElementById('civil-route-result');
  if (resCard) {
    resCard.style.display = 'block';
    document.getElementById('civil-eta').textContent = `${route.predicted_travel_time_min} min`;
    document.getElementById('civil-delay').textContent = `${route.predicted_delay_min} min`;
    document.getElementById('civil-dist').textContent = `${route.distance_km} km`;
    document.getElementById('civil-reliability').textContent = `${route.reliability_score}%`;
    const sigEl = document.getElementById('civil-signals');
    if (sigEl) sigEl.textContent = `${route.signals_count}`;

    // Calculate arrival time from live current time
    const now = new Date();
    const travelMin = Number(route.predicted_travel_time_min) || 0;
    const arrival = new Date(now.getTime() + travelMin * 60000);
    const arrEl = document.getElementById('civil-arrival-clock');
    if (arrEl) {
      arrEl.textContent = arrival.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit' }) + ' IST';
    }

    let adv = `Predicted travel time: ${route.predicted_travel_time_min} min across ${route.distance_km} km (${route.signals_count} signals).`;
    if (route.corridor_conflict) {
      adv = `🚨 CAUTION: Intersects active Priority Green Corridor! Yield and consider alternative.`;
    } else if (route.is_recommended) {
      adv = `✅ OPTIMAL: Recommended path with ${route.reliability_score}% reliability and minimal delay.`;
    }
    document.getElementById('civil-advisory').textContent = adv;

    // Async Gemini Route Safety Audit
    fetch('/api/ai/classify-route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin_node: route.nodes ? route.nodes[0] : 'Origin',
        destination_node: route.nodes ? route.nodes[route.nodes.length - 1] : 'Dest',
        distance_km: Number(route.distance_km),
        estimated_time_min: Number(route.predicted_travel_time_min),
        normal_free_flow_time_min: Number(route.free_flow_travel_time_min || route.predicted_travel_time_min),
        has_emergency_conflict: Boolean(route.corridor_conflict)
      })
    }).then(r => r.json()).then(gData => {
      if (gData && gData.commuter_advisory) {
        document.getElementById('civil-advisory').innerHTML = `
          <div style="margin-bottom: 4px; font-weight: 700; color: var(--nex-cyan); display: flex; justify-content: space-between;">
            <span><i class="fa-solid fa-brain"></i> Gemini Safety: ${gData.safety_classification} (${gData.safety_score}/100)</span>
            <span style="font-size: 0.68rem; color: #94a3b8;">${gData.powered_by}</span>
          </div>
          <div>${gData.commuter_advisory}</div>
        `;
      }
    }).catch(err => {
      console.warn("Gemini classify error:", err);
    });

    // Real-Time Gemini Historical Route Decision grounded in Database
    if (route._cached_decision) {
      renderGeminiRouteAdvisor(null, route._cached_decision);
    } else {
      const gCard = document.getElementById('gemini-route-advisor-card');
      const gTitle = document.getElementById('gemini-route-title');
      const gBadge = document.getElementById('gemini-route-badge');
      if (gCard && gCard.style.display !== 'none') {
        if (gTitle) gTitle.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="color: var(--nex-cyan);"></i> Analyzing ${route.route_label} with Gemini AI & DB...`;
        if (gBadge) {
          gBadge.textContent = 'EVALUATING';
          gBadge.style.color = '#38bdf8';
          gBadge.style.borderColor = '#38bdf8';
        }
      }

      const origNode = route.nodes ? route.nodes[0] : 'N014';
      const destNode = route.nodes ? route.nodes[route.nodes.length - 1] : 'N086';
      const timeDisplay = document.getElementById('live-departure-clock');
      const presTimeStr = timeDisplay ? timeDisplay.textContent.trim() : 'Live Departure (IST)';

      fetch('/api/route/gemini-decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origin_node: origNode,
          destination_node: destNode,
          selected_route_id: route.route_id,
          present_time: presTimeStr,
          origin_label: document.getElementById('civil-origin-input') ? document.getElementById('civil-origin-input').value : null,
          destination_label: document.getElementById('civil-dest-input') ? document.getElementById('civil-dest-input').value : null
        })
      }).then(r => r.json()).then(histDec => {
        if (histDec && (histDec.decision_title || histDec.decision_verdict)) {
          route._cached_decision = histDec;
          renderGeminiRouteAdvisor(null, histDec);
        }
      }).catch(err => {
        console.warn("Gemini historical route decision fetch:", err);
      });
    }
  }

  // Instant Synchronous Map Polyline and Waypoint Rendering
  if (isGoogleMaps && gMap) {
    if (gActiveRoutePolyline) gActiveRoutePolyline.setMap(null);
    const path = route.coordinates.map(c => ({ lat: c[0], lng: c[1] }));
    gActiveRoutePolyline = new google.maps.Polyline({
      path: path,
      strokeColor: routeColor,
      strokeOpacity: 0.95,
      strokeWeight: 7,
      map: gMap
    });
    const b = new google.maps.LatLngBounds();
    path.forEach(pt => b.extend(pt));
    gMap.fitBounds(b);
  } else if (map) {
    if (activeRouteLayer) map.removeLayer(activeRouteLayer);
    if (routeMarkersLayer) routeMarkersLayer.clearLayers();

    // 1. Glowing Route Polyline on Leaflet
    activeRouteLayer = L.polyline(route.coordinates, {
      color: routeColor,
      weight: 7,
      opacity: 0.95,
      lineCap: 'round',
      lineJoin: 'round',
      dashArray: route.corridor_conflict ? '8, 8' : null
    }).addTo(map);

    // 2. High-Contrast Start & Destination Markers (near Hyderabad)
    if (route.coordinates.length > 0 && routeMarkersLayer) {
      const startCoord = route.coordinates[0];
      const startNode = route.nodes ? route.nodes[0] : 'Start';
      const startLabel = getNodeDisplayLabel(startNode);
      const startIcon = L.divIcon({
        className: 'custom-route-pin route-pin-from',
        html: '<i class="fa-solid fa-play" style="font-size: 11px;"></i>',
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      });
      L.marker(startCoord, { icon: startIcon, zIndexOffset: 1000 })
        .bindPopup(`
          <div style="font-family: var(--font-primary); font-size: 0.8rem; color: #fff; background: #0c121d; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--nex-cyan);">
            <div style="color: var(--nex-cyan); font-weight: 800; font-size: 0.72rem; text-transform: uppercase;">FROM (Starting Junction)</div>
            <b style="font-size: 0.85rem;">${startLabel}</b>
            <div style="color: #94a3b8; font-size: 0.72rem; margin-top: 3px;">Coordinates: ${startCoord[0].toFixed(4)}° N, ${startCoord[1].toFixed(4)}° E</div>
          </div>
        `)
        .addTo(routeMarkersLayer);

      const endCoord = route.coordinates[route.coordinates.length - 1];
      const endNode = route.nodes ? route.nodes[route.nodes.length - 1] : 'End';
      const endLabel = getNodeDisplayLabel(endNode);
      const endIcon = L.divIcon({
        className: 'custom-route-pin route-pin-to',
        html: '<i class="fa-solid fa-flag-checkered" style="font-size: 12px;"></i>',
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      });
      L.marker(endCoord, { icon: endIcon, zIndexOffset: 1000 })
        .bindPopup(`
          <div style="font-family: var(--font-primary); font-size: 0.8rem; color: #fff; background: #0c121d; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--nex-emerald);">
            <div style="color: var(--nex-emerald); font-weight: 800; font-size: 0.72rem; text-transform: uppercase;">TO (Destination Arrival)</div>
            <b style="font-size: 0.85rem;">${endLabel}</b>
            <div style="color: #94a3b8; font-size: 0.72rem; margin-top: 3px;">Coordinates: ${endCoord[0].toFixed(4)}° N, ${endCoord[1].toFixed(4)}° E</div>
          </div>
        `)
        .addTo(routeMarkersLayer);

      // 3. Subtle Waypoint Junction Dots along path
      if (route.coordinates.length > 2) {
        for (let i = 1; i < route.coordinates.length - 1; i++) {
          const wpCoord = route.coordinates[i];
          const wpNode = route.nodes && route.nodes[i] ? route.nodes[i] : `W${i}`;
          const dotIcon = L.divIcon({
            className: 'route-waypoint-dot',
            iconSize: [8, 8],
            iconAnchor: [4, 4]
          });
          L.marker(wpCoord, { icon: dotIcon, interactive: true })
            .bindTooltip(`Junction ${wpNode}: ${getNodeDisplayLabel(wpNode)}`, { direction: 'top', offset: [0, -4] })
            .addTo(routeMarkersLayer);
        }
      }
    }

    // 4. Smoothly Fit Map Viewport to Hyderabad Route
    map.fitBounds(activeRouteLayer.getBounds(), { padding: [70, 70], maxZoom: 15, animate: true });
  }
}

// Emergency Green Corridor Activation
async function activateGreenCorridor() {
  const isAuthorized = ['emergency', 'field_officer', 'operator', 'admin'].includes(currentUser.role) || currentUser.username === 'ems108';
  if (!isAuthorized || !currentUser.token) {
    await ensureEmsDemoSession();
  }

  const vehicle = document.getElementById('emerg-vehicle').value;
  const origInput = document.getElementById('emerg-origin-input');
  const destInput = document.getElementById('emerg-dest-input');
  const origSel = document.getElementById('emerg-origin');
  const destSel = document.getElementById('emerg-dest');

  let origin = (origInput && resolveNodeId(origInput.value)) || (origSel && origSel.value) || 'N014';
  let dest = (destInput && resolveNodeId(destInput.value)) || (destSel && destSel.value) || 'N031';

  // Synchronize inputs
  if (origInput && origin) origInput.value = getNodeDisplayLabel(origin);
  if (destInput && dest) destInput.value = getNodeDisplayLabel(dest);
  if (origSel && origin) origSel.value = origin;
  if (destSel && dest) destSel.value = dest;

  if (origin === dest) {
    alert("Please select different emergency FROM (Scene) and TO (Hospital) locations.");
    return;
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (currentUser.token) headers['Authorization'] = `Bearer ${currentUser.token}`;

    const res = await fetch('/api/route/emergency', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        origin_node: origin,
        destination_node: dest,
        vehicle_type: vehicle,
        priority_level: "Critical"
      })
    });
    const data = await res.json();

    if (!res.ok) {
      alert(data.detail || "Emergency corridor routing failed");
      return;
    }

    currentEmergencyCorridorId = data.corridor_id;

    document.getElementById('emerg-telemetry').style.display = 'block';
    document.getElementById('emerg-eta').textContent = `${data.estimated_emergency_travel_time_min} min`;
    document.getElementById('emerg-saved').textContent = `${data.time_saved_min} min`;

    // Update Emergency Service Switch Card UI to ACTIVE (ON)
    const stateBadge = document.getElementById('emerg-service-state-badge');
    const stateDesc = document.getElementById('emerg-service-state-desc');
    const powerIcon = document.getElementById('emerg-service-power-icon');
    const btnOn = document.getElementById('btn-turn-on-emergency');
    const btnOff = document.getElementById('btn-turn-off-emergency');

    if (stateBadge) {
      stateBadge.textContent = 'ACTIVE (ON)';
      stateBadge.style.color = '#fff';
      stateBadge.style.background = 'var(--nex-crimson)';
      stateBadge.style.borderColor = 'var(--nex-crimson)';
    }
    if (stateDesc) {
      stateDesc.textContent = `🚨 Priority ${vehicle} corridor active (${origin} ➔ ${dest})! Green wave preemption is broadcasting alerts to civilian users on this route.`;
      stateDesc.style.color = '#fecdd3';
    }
    if (powerIcon) {
      powerIcon.style.color = 'var(--nex-crimson)';
      powerIcon.style.background = 'rgba(255, 51, 102, 0.25)';
      powerIcon.style.borderColor = 'var(--nex-crimson)';
      powerIcon.classList.add('emerg-service-active-pulse');
    }
    if (btnOn) btnOn.style.display = 'none';
    if (btnOff) btnOff.style.display = 'inline-flex';

    const tbody = document.getElementById('signal-tbody');
    tbody.innerHTML = '';
    data.signal_preemptions.forEach(sp => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="color: var(--nex-cyan); font-weight: 700;">${sp.signal_id}</td>
        <td>${sp.junction_node}</td>
        <td>+${sp.eta_seconds}s</td>
        <td><span style="color: var(--nex-emerald); font-weight: 800;">ARMED GREEN</span></td>
      `;
      tbody.appendChild(tr);
    });

    if (isGoogleMaps && gMap) {
      if (gEmergencyCorridorPolyline) gEmergencyCorridorPolyline.setMap(null);
      const ePath = data.coordinates.map(c => ({ lat: c[0], lng: c[1] }));
      gEmergencyCorridorPolyline = new google.maps.Polyline({
        path: ePath,
        strokeColor: '#00F5A0',
        strokeOpacity: 0.95,
        strokeWeight: 9,
        map: gMap
      });
      const eb = new google.maps.LatLngBounds();
      ePath.forEach(pt => eb.extend(pt));
      gMap.fitBounds(eb);
    } else if (map) {
      if (emergencyCorridorLayer) map.removeLayer(emergencyCorridorLayer);
      if (routeMarkersLayer) routeMarkersLayer.clearLayers();

      // 1. Emergency Green Wave Polyline
      emergencyCorridorLayer = L.polyline(data.coordinates, {
        color: '#00F5A0',
        weight: 9,
        opacity: 0.95,
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(map);

      // 2. High-Contrast Emergency Scene (FROM) and Hospital (TO) Markers
      if (data.coordinates.length > 0 && routeMarkersLayer) {
        const startCoord = data.coordinates[0];
        const startNode = data.nodes ? data.nodes[0] : 'Scene';
        const startLabel = getNodeDisplayLabel(startNode);
        const startIcon = L.divIcon({
          className: 'custom-route-pin route-pin-emerg-from',
          html: '<i class="fa-solid fa-truck-medical" style="font-size: 13px;"></i>',
          iconSize: [32, 32],
          iconAnchor: [16, 16]
        });
        L.marker(startCoord, { icon: startIcon, zIndexOffset: 1200 })
          .bindPopup(`
            <div style="font-family: var(--font-primary); font-size: 0.8rem; color: #fff; background: #0c121d; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--nex-crimson);">
              <div style="color: var(--nex-crimson); font-weight: 800; font-size: 0.72rem; text-transform: uppercase;">🚨 EMERGENCY SCENE (ORIGIN)</div>
              <b style="font-size: 0.85rem;">${startLabel}</b>
              <div style="color: #94a3b8; font-size: 0.72rem; margin-top: 3px;">Coordinates: ${startCoord[0].toFixed(4)}° N, ${startCoord[1].toFixed(4)}° E</div>
            </div>
          `)
          .addTo(routeMarkersLayer);

        const endCoord = data.coordinates[data.coordinates.length - 1];
        const endNode = data.nodes ? data.nodes[data.nodes.length - 1] : 'Hospital';
        const endLabel = getNodeDisplayLabel(endNode);
        const endIcon = L.divIcon({
          className: 'custom-route-pin route-pin-emerg-to',
          html: '<i class="fa-solid fa-hospital" style="font-size: 14px;"></i>',
          iconSize: [32, 32],
          iconAnchor: [16, 16]
        });
        L.marker(endCoord, { icon: endIcon, zIndexOffset: 1200 })
          .bindPopup(`
            <div style="font-family: var(--font-primary); font-size: 0.8rem; color: #fff; background: #0c121d; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--nex-emerald);">
              <div style="color: var(--nex-emerald); font-weight: 800; font-size: 0.72rem; text-transform: uppercase;">🏥 DESIGNATED TRAUMA HOSPITAL</div>
              <b style="font-size: 0.85rem;">${endLabel}</b>
              <div style="color: #94a3b8; font-size: 0.72rem; margin-top: 3px;">Coordinates: ${endCoord[0].toFixed(4)}° N, ${endCoord[1].toFixed(4)}° E</div>
            </div>
          `)
          .addTo(routeMarkersLayer);
      }

      // 3. Smoothly Fit Map Viewport to Hyderabad Emergency Corridor
      map.fitBounds(emergencyCorridorLayer.getBounds(), { padding: [70, 70], maxZoom: 15, animate: true });
    }

    await checkActiveEmergencyAlerts();

  } catch (err) {
    console.error("Emergency corridor error:", err);
  }
}

function disableEmergencyService() {
  clearActiveEmergencyCorridor();
}
window.disableEmergencyService = disableEmergencyService;

async function clearActiveEmergencyCorridor() {
  const isAuthorized = ['emergency', 'field_officer', 'operator', 'admin'].includes(currentUser.role) || currentUser.username === 'ems108';
  if (!isAuthorized || !currentUser.token) {
    await ensureEmsDemoSession();
  }

  if (emergencyCorridorLayer && map) {
    map.removeLayer(emergencyCorridorLayer);
    emergencyCorridorLayer = null;
  }
  if (routeMarkersLayer) {
    routeMarkersLayer.clearLayers();
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (currentUser.token) headers['Authorization'] = `Bearer ${currentUser.token}`;

    const res = await fetch('/api/emergency/clear', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ corridor_id: currentEmergencyCorridorId || "all" })
    });

    if (isGoogleMaps && gEmergencyCorridorPolyline) {
      gEmergencyCorridorPolyline.setMap(null);
      gEmergencyCorridorPolyline = null;
    }
    if (emergencyCorridorLayer && map) {
      map.removeLayer(emergencyCorridorLayer);
      emergencyCorridorLayer = null;
    }

    currentEmergencyCorridorId = null;
    const emergTel = document.getElementById('emerg-telemetry');
    if (emergTel) emergTel.style.display = 'none';

    // Reset Emergency Service Switch Card UI to STANDBY (OFF)
    const stateBadge = document.getElementById('emerg-service-state-badge');
    const stateDesc = document.getElementById('emerg-service-state-desc');
    const powerIcon = document.getElementById('emerg-service-power-icon');
    const btnOn = document.getElementById('btn-turn-on-emergency');
    const btnOff = document.getElementById('btn-turn-off-emergency');

    if (stateBadge) {
      stateBadge.textContent = 'STANDBY (OFF)';
      stateBadge.style.color = '#94a3b8';
      stateBadge.style.background = 'rgba(100, 116, 139, 0.2)';
      stateBadge.style.borderColor = '#64748b';
    }
    if (stateDesc) {
      stateDesc.textContent = 'Turn ON to activate green wave signal preemption and broadcast emergency alerts to users on this route.';
      stateDesc.style.color = '#94a3b8';
    }
    if (powerIcon) {
      powerIcon.style.color = '#64748b';
      powerIcon.style.background = 'rgba(255, 255, 255, 0.06)';
      powerIcon.style.borderColor = 'var(--nex-border)';
      powerIcon.classList.remove('emerg-service-active-pulse');
    }
    if (btnOn) btnOn.style.display = 'inline-flex';
    if (btnOff) btnOff.style.display = 'none';

    // Hide emergency alerts across civilian & operator dashboards
    const civilRouteAlert = document.getElementById('civilian-emergency-route-alert');
    if (civilRouteAlert) civilRouteAlert.style.display = 'none';
    const alertBanner = document.getElementById('route-emergency-alert-banner');
    if (alertBanner) alertBanner.style.display = 'none';
    const broadcastBanner = document.getElementById('emergency-broadcast-banner');
    if (broadcastBanner) broadcastBanner.style.display = 'none';

    await checkActiveEmergencyAlerts();

  } catch (err) {
    console.error("Error clearing emergency corridor:", err);
  }
}

// Emergency Alert Broadcast Poller
async function checkActiveEmergencyAlerts() {
  try {
    const res = await fetch('/api/emergency/alerts');
    if (!res.ok) return;
    const data = await res.json();
    const banner = document.getElementById('emergency-broadcast-banner');
    const bannerText = document.getElementById('emergency-broadcast-text');
    const civilRouteAlert = document.getElementById('civilian-emergency-route-alert');
    const civilAlertMsg = document.getElementById('civilian-emergency-route-alert-msg');
    const civilMissionId = document.getElementById('civilian-emerg-mission-id');

    const stateBadge = document.getElementById('emerg-service-state-badge');
    const stateDesc = document.getElementById('emerg-service-state-desc');
    const powerIcon = document.getElementById('emerg-service-power-icon');
    const btnOn = document.getElementById('btn-turn-on-emergency');
    const btnOff = document.getElementById('btn-turn-off-emergency');

    if (data.active_count > 0 && data.alerts && data.alerts.length > 0) {
      const active = data.alerts[0];

      // 1. Top Siren Broadcast Banner
      if (banner && bannerText) {
        banner.style.display = 'flex';
        bannerText.textContent = `🚨 ${active.vehicle_type.toUpperCase()} EN ROUTE: ${active.origin_node} (${getNodeDisplayLabel(active.origin_node)}) ➔ ${active.destination_node} (${getNodeDisplayLabel(active.destination_node)}). Preempting ${active.signal_preemptions ? active.signal_preemptions.length : 'all'} signals. Civilian traffic auto-diverted!`;
      }

      // 2. Emergency Dashboard Switch UI (ON)
      if (stateBadge) {
        stateBadge.textContent = 'ACTIVE (ON)';
        stateBadge.style.color = '#fff';
        stateBadge.style.background = 'var(--nex-crimson)';
        stateBadge.style.borderColor = 'var(--nex-crimson)';
      }
      if (stateDesc) {
        stateDesc.textContent = `🚨 Priority ${active.vehicle_type} corridor active (${active.origin_node} ➔ ${active.destination_node})! Green wave preemption is broadcasting alerts to users on this route.`;
        stateDesc.style.color = '#fecdd3';
      }
      if (powerIcon) {
        powerIcon.style.color = 'var(--nex-crimson)';
        powerIcon.style.background = 'rgba(255, 51, 102, 0.25)';
        powerIcon.style.borderColor = 'var(--nex-crimson)';
        powerIcon.classList.add('emerg-service-active-pulse');
      }
      if (btnOn) btnOn.style.display = 'none';
      if (btnOff) btnOff.style.display = 'inline-flex';

      // 3. Show Emergency Alert to Civilian User on That Route (Active until EMS disables it)
      if (civilRouteAlert) {
        civilRouteAlert.style.display = 'block';
        if (civilMissionId) {
          civilMissionId.textContent = `${active.vehicle_type.toUpperCase()} (${active.origin_node} ➔ ${active.destination_node})`;
        }
        if (civilAlertMsg) {
          civilAlertMsg.innerHTML = `
            <b>🚨 ACTIVE PRIORITY EMERGENCY MISSION:</b> A 108 ${active.vehicle_type} is currently traversing between <b>${getNodeDisplayLabel(active.origin_node)}</b> and <b>${getNodeDisplayLabel(active.destination_node)}</b>.<br>
            <span style="color: #fff; font-weight: 700;">⚠️ Signals on this corridor are locked to green waves. All civilian drivers on this route MUST yield right-of-way and take alternative paths. This alert will remain active until Emergency Services explicitly disables it.</span>
          `;
        }
      }

      // 4. Operator Console Telemetry Indicator
      const opCorridorEl = document.getElementById('telemetry-active-corridor');
      if (opCorridorEl) {
        opCorridorEl.innerHTML = `<span style="color: var(--nex-crimson); font-weight: 800;">🚨 EMERGENCY ACTIVE:</span> ${active.origin_node} &rarr; ${active.destination_node} (${active.vehicle_type})`;
      }

      // 5. Draw active corridor on map
      if (isGoogleMaps && gMap) {
        if (!gEmergencyCorridorPolyline && active.coordinates) {
          const ePath = active.coordinates.map(c => ({ lat: c[0], lng: c[1] }));
          gEmergencyCorridorPolyline = new google.maps.Polyline({
            path: ePath,
            strokeColor: '#00F5A0',
            strokeOpacity: 0.95,
            strokeWeight: 9,
            map: gMap
          });
        }
      } else if (map) {
        if (!emergencyCorridorLayer && active.coordinates) {
          emergencyCorridorLayer = L.polyline(active.coordinates, {
            color: '#00F5A0',
            weight: 9,
            opacity: 0.95
          }).addTo(map);
        }
      }

    } else {
      // Emergency Service is OFF / Disabled
      if (banner) banner.style.display = 'none';
      if (civilRouteAlert) civilRouteAlert.style.display = 'none';

      if (stateBadge) {
        stateBadge.textContent = 'STANDBY (OFF)';
        stateBadge.style.color = '#94a3b8';
        stateBadge.style.background = 'rgba(100, 116, 139, 0.2)';
        stateBadge.style.borderColor = '#64748b';
      }
      if (stateDesc) {
        stateDesc.textContent = 'Turn ON to activate green wave signal preemption and broadcast emergency alerts to users on this route.';
        stateDesc.style.color = '#94a3b8';
      }
      if (powerIcon) {
        powerIcon.style.color = '#64748b';
        powerIcon.style.background = 'rgba(255, 255, 255, 0.06)';
        powerIcon.style.borderColor = 'var(--nex-border)';
        powerIcon.classList.remove('emerg-service-active-pulse');
      }
      if (btnOn) btnOn.style.display = 'inline-flex';
      if (btnOff) btnOff.style.display = 'none';

      if (isGoogleMaps && gEmergencyCorridorPolyline) {
        gEmergencyCorridorPolyline.setMap(null);
        gEmergencyCorridorPolyline = null;
      }
      if (emergencyCorridorLayer && map) {
        map.removeLayer(emergencyCorridorLayer);
        emergencyCorridorLayer = null;
      }
    }
  } catch (err) {}
}

// =========================================================
// 9. DOM READY BOOTSTRAP & LIVE CLOCK ENGINE
// =========================================================

function startLiveClock() {
  function tick() {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' IST';
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

    const navClock = document.getElementById('nav-live-clock');
    if (navClock) navClock.textContent = timeStr;

    const civilClock = document.getElementById('civil-live-clock');
    if (civilClock) civilClock.textContent = timeStr;

    const civilDate = document.getElementById('civil-live-date');
    if (civilDate) civilDate.textContent = dateStr;

    const emergClock = document.getElementById('emerg-live-clock');
    if (emergClock) emergClock.textContent = timeStr;

    // Dynamically update expected arrival clock if a civilian route is selected
    if (currentMLRoutes && currentMLRoutes[selectedRouteIndex]) {
      const travelMin = Number(currentMLRoutes[selectedRouteIndex].predicted_travel_time_min) || 0;
      const arrival = new Date(now.getTime() + travelMin * 60000);
      const arrEl = document.getElementById('civil-arrival-clock');
      if (arrEl) {
        arrEl.textContent = arrival.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit' }) + ' IST';
      }
    }
  }
  tick();
  setInterval(tick, 1000);
}

function openGeminiKeyModal() {
  const m = document.getElementById('gemini-modal');
  const inp = document.getElementById('input-gemini-key');
  if (inp && !inp.value) {
    inp.value = 'AIzaSyDefaultTraffixNeuraxGeminiPipelineKey2026';
  }
  if (m) m.classList.remove('hidden');
}

function closeGeminiKeyModal() {
  const m = document.getElementById('gemini-modal');
  if (m) m.classList.add('hidden');
}

function toggleGeminiKeyVisibility() {
  const inp = document.getElementById('input-gemini-key');
  const icon = document.getElementById('toggle-gemini-key-btn');
  if (inp) {
    if (inp.type === 'password') {
      inp.type = 'text';
      if (icon) icon.className = 'fa-solid fa-eye-slash';
    } else {
      inp.type = 'password';
      if (icon) icon.className = 'fa-solid fa-eye';
    }
  }
}

async function saveGeminiKey() {
  const keyInput = document.getElementById('input-gemini-key');
  const statusEl = document.getElementById('gemini-config-status');
  const key = keyInput ? keyInput.value.trim() : '';

  if (statusEl) {
    statusEl.innerHTML = '<span style="color: var(--nex-cyan);"><i class="fa-solid fa-spinner fa-spin"></i> Testing key connectivity with Google Gemini...</span>';
  }

  try {
    const res = await fetch('/api/gemini/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key })
    });
    const data = await res.json();
    if (data.is_configured) {
      if (statusEl) statusEl.innerHTML = '<span style="color: var(--nex-emerald);"><i class="fa-solid fa-circle-check"></i> Google Gemini API key configured and active!</span>';
      checkGeminiStatus();
      setTimeout(closeGeminiKeyModal, 1500);
    } else {
      if (statusEl) statusEl.innerHTML = '<span style="color: var(--nex-amber);"><i class="fa-solid fa-circle-check"></i> Key saved. Calibrated AI intelligence mode active.</span>';
      checkGeminiStatus();
      setTimeout(closeGeminiKeyModal, 1500);
    }
  } catch (err) {
    if (statusEl) statusEl.innerHTML = '<span style="color: var(--nex-crimson);">Failed to save Gemini key.</span>';
  }
}

window.addEventListener('DOMContentLoaded', () => {
  initMap();
  loadNetworkData();
  startLiveClock();

  const saved = localStorage.getItem('nexterra_session');
  if (saved) {
    try {
      const u = JSON.parse(saved);
      loginSuccess(u.username, u.role, u.name, u.title, u.token);
    } catch(e) {
      openAuthModal();
    }
  } else {
    openAuthModal();
  }

  // Start periodic check for active emergency alerts every 4 seconds
  checkActiveEmergencyAlerts();
  setInterval(checkActiveEmergencyAlerts, 4000);

  // Initialize Gemini AI Copilot status
  checkGeminiStatus();
});

// =========================================================
// 10. GEMINI AI DECISION SUPPORT & CLASSIFICATION CONTROLLER
// =========================================================

async function checkGeminiStatus() {
  try {
    const res = await fetch('/api/ai/status');
    if (!res.ok) return;
    const data = await res.json();
    const badge = document.getElementById('gemini-status-badge');
    if (badge) {
      if (data.api_configured) {
        badge.innerHTML = `<i class="fa-solid fa-sparkles"></i> ${data.model} (Active)`;
        badge.style.color = 'var(--nex-emerald)';
        badge.style.borderColor = 'rgba(0, 245, 160, 0.4)';
      } else {
        badge.innerHTML = `<i class="fa-solid fa-shield-halved"></i> Calibrated AI Mode`;
        badge.style.color = 'var(--nex-cyan)';
        badge.style.borderColor = 'rgba(0, 229, 255, 0.3)';
      }
    }
  } catch (err) {
    console.warn("Could not check Gemini status:", err);
  }
}

async function generateGeminiBriefing() {
  const container = document.getElementById('gemini-copilot-content');
  if (!container) return;
  container.style.display = 'block';
  container.innerHTML = '<div style="color: var(--nex-cyan);"><i class="fa-solid fa-spinner fa-spin"></i> Generating Gemini Executive Situation Briefing...</div>';

  try {
    const timeDisplay = document.getElementById('current-time-display');
    const ts = timeDisplay ? timeDisplay.textContent : null;
    let url = '/api/ai/situation-briefing';
    if (ts && ts.includes('-')) url += `?timestamp=${encodeURIComponent(ts)}`;

    const res = await fetch(url);
    const data = await res.json();

    container.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
        <span style="font-weight: 800; color: #fff; font-size: 0.82rem;">
          <i class="fa-solid fa-shield-halved" style="color: var(--nex-cyan);"></i> Executive Situation Brief
        </span>
        <span style="font-size: 0.68rem; color: var(--nex-cyan); background: rgba(0, 229, 255, 0.15); padding: 2px 8px; border-radius: 4px; font-weight: 700;">
          ${data.powered_by || 'Gemini 1.5 Flash'}
        </span>
      </div>
      <div style="color: #e2e8f0; margin-bottom: 8px; line-height: 1.4;">${data.executive_summary}</div>
      <div style="background: rgba(0,0,0,0.4); border-radius: 8px; padding: 8px; margin-bottom: 8px;">
        <div style="font-size: 0.7rem; color: #94a3b8; text-transform: uppercase; font-weight: 700;">Critical Corridors</div>
        <div style="color: var(--nex-amber); font-weight: 600; margin-top: 2px;">
          ${Array.isArray(data.hotspot_corridors) ? data.hotspot_corridors.join(' • ') : data.hotspot_corridors}
        </div>
      </div>
      <div style="margin-bottom: 6px;">
        <span style="color: var(--nex-emerald); font-weight: 700;">Priority Action:</span>
        <span style="color: #cbd5e1;"> ${data.priority_action}</span>
      </div>
      <div>
        <span style="color: var(--nex-cyan); font-weight: 700;">30-Min Outlook:</span>
        <span style="color: #cbd5e1;"> ${data.traffic_outlook_30m}</span>
      </div>
    `;
  } catch (err) {
    container.innerHTML = '<div style="color: var(--nex-crimson);">Failed to generate situation briefing.</div>';
  }
}

async function runGeminiDataAudit() {
  const container = document.getElementById('gemini-copilot-content');
  if (!container) return;
  container.style.display = 'block';
  container.innerHTML = '<div style="color: var(--nex-cyan);"><i class="fa-solid fa-spinner fa-spin"></i> Running Gemini Telemetry & Provenance Audit...</div>';

  try {
    const res = await fetch('/api/ai/preprocess', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await res.json();

    const tierColor = data.quality_tier === 'EXCELLENT' ? 'var(--nex-emerald)' : (data.quality_tier === 'ACCEPTABLE' ? 'var(--nex-amber)' : 'var(--nex-crimson)');

    container.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
        <span style="font-weight: 800; color: #fff; font-size: 0.82rem;">
          <i class="fa-solid fa-microchip" style="color: var(--nex-emerald);"></i> Telemetry Quality Audit
        </span>
        <span style="font-size: 0.68rem; color: ${tierColor}; background: rgba(0,0,0,0.5); padding: 2px 8px; border-radius: 4px; font-weight: 800; border: 1px solid ${tierColor};">
          ${data.quality_tier || 'NOMINAL'}
        </span>
      </div>
      <div style="display: flex; gap: 14px; margin-bottom: 8px;">
        <div>
          <div style="font-size: 0.68rem; color: #94a3b8;">Sensor Integrity</div>
          <div style="font-size: 1.2rem; font-weight: 800; color: ${tierColor}; font-family: var(--font-display);">${data.sensor_integrity_score} / 100</div>
        </div>
        <div style="flex: 1;">
          <div style="font-size: 0.68rem; color: #94a3b8;">Classification</div>
          <div style="color: #fff; font-weight: 600; font-size: 0.78rem;">${data.anomaly_classification}</div>
        </div>
      </div>
      <div style="background: rgba(0,0,0,0.4); border-radius: 8px; padding: 8px; margin-bottom: 8px;">
        <div style="font-size: 0.7rem; color: #94a3b8; text-transform: uppercase; font-weight: 700;">Imputation Policy</div>
        <div style="color: #e2e8f0; margin-top: 2px;">${data.recommended_imputation_policy}</div>
      </div>
      <div style="color: #cbd5e1; line-height: 1.4; margin-bottom: 6px;">${data.provenance_summary}</div>
      <div style="font-size: 0.68rem; color: #64748b; text-align: right;">${data.powered_by}</div>
    `;
  } catch (err) {
    container.innerHTML = '<div style="color: var(--nex-crimson);">Failed to run telemetry audit.</div>';
  }
}

async function classifyIncidentWithGemini(incidentId, segmentId, speed, speedDrop, queue) {
  const detailBox = document.getElementById(`gemini-inc-details-${incidentId}`);
  if (!detailBox) return;

  if (detailBox.style.display === 'block') {
    detailBox.style.display = 'none';
    return;
  }

  detailBox.style.display = 'block';
  detailBox.innerHTML = '<div style="color: var(--nex-cyan);"><i class="fa-solid fa-spinner fa-spin"></i> Gemini AI analyzing telemetry disturbance...</div>';

  try {
    const payload = {
      segment_id: String(segmentId),
      speed_kmh: Number(speed),
      speed_drop_kmh: Number(speedDrop),
      queue_length_veh: Number(queue),
      v_c_ratio: 0.95
    };

    const res = await fetch('/api/ai/classify-incident', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    const mitigationsHtml = Array.isArray(data.tactical_mitigations)
      ? data.tactical_mitigations.map(m => `<li>${m}</li>`).join('')
      : `<li>${data.tactical_mitigations}</li>`;

    detailBox.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 4px;">
        <span style="font-weight: 800; color: #fff;">
          <i class="fa-solid fa-triangle-exclamation" style="color: var(--nex-crimson);"></i> ${data.incident_type}
        </span>
        <span style="color: var(--nex-amber); font-weight: 700;">Grade ${data.severity_grade}/5</span>
      </div>
      <div style="color: #cbd5e1; margin-bottom: 6px;"><b>Attribution:</b> ${data.root_cause_attribution}</div>
      <div style="color: #94a3b8; margin-bottom: 6px;"><b>Est. Clearance:</b> <span style="color: #fff;">~${data.estimated_clearance_min} min</span></div>
      <div style="color: #94a3b8; font-weight: 700; margin-bottom: 4px;">Tactical Multi-Agency Actions:</div>
      <ul style="margin: 0; padding-left: 16px; color: #e2e8f0; line-height: 1.4;">${mitigationsHtml}</ul>
      <div style="margin-top: 6px; font-size: 0.68rem; color: var(--nex-cyan); text-align: right;">${data.powered_by}</div>
    `;
  } catch (err) {
    detailBox.innerHTML = '<div style="color: var(--nex-crimson);">Gemini analysis failed.</div>';
  }
}
