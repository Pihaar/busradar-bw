// === CONFIGURATION ===
export var CONFIG = {
  fallbackCenter: [49.2944, 8.6434],
  defaultZoom: 14,
  defaultRadius: 15000,
  // Marker-Interpolationsdauer je posMode: die Animation soll ~bis zum nächsten
  // SSE-Push dauern (glatter Glide statt Sprung). Die Push-Kadenz ist server-fix
  // (tick.py); bei Server-Änderung hier manuell nachziehen. Einheit ms, tick.py
  // ist Sekunden → ×1000.
  markerAnimMsCalc: 10000, // = tick.py SSE_PUSH_PERIOD (10 s) × 1000 — CALC-Push-Kadenz
  markerAnimMsGps: 30000, // = tick.py TICK_PERIOD (30 s) × 1000 — REPORT_ONLY-Push-Kadenz
  zoomThresholdNoAnimation: 12,
  tileUrl: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  tileAttribution:
    '© <a href="https://www.openstreetmap.org/copyright">OSM</a> © <a href="https://carto.com/attributions">CARTO</a>',
  fallbackTileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  apiBase: '/api',
  graceperiodCycles: 2,
  hafasStationboardLimit: 50,
};
