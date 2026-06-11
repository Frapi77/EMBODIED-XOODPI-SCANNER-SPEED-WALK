import "./style.css";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { toJpeg } from "html-to-image";
import JSZip from "jszip";

const PROJECT_TITLE = "EMBODIED XXODPI SCANNER SPEED WALK";
const FILE_PREFIX = "embodied-xxodpi-scanner-speed-walk";
const RECIPIENT_EMAIL = "mail.francescopi@gmail.com";

const SCANNER_SPEED_M_PER_HOUR = 883;
const SCANNER_SPEED_M_PER_SECOND = SCANNER_SPEED_M_PER_HOUR / 3600;
const GPS_MAX_ACCURACY_M = 20;
const GPS_MIN_MOVEMENT_M = 0.3;
const GPS_MAX_WALKING_SPEED_MPS = 4.0;
const STEP_MATCH_WINDOW_S = 2.0;

const state = {
  page: "welcome",
  consent: false,

  nickname: "",
  stepLengthCm: "",
  calculatedIntervalS: null,

  motionEnabled: false,
  gpsEnabled: false,
  gpsDenied: false,

  sensitivity: 6,
  peakThreshold: 0.98,
  refractoryMs: 783,
  motionSignal: 0,
  motionSource: "none",

  sessionStartedAt: null,
  sessionEndedAt: null,
  elapsedS: 0,

  theoreticalStepIndex: 0,
  detectedStepIndex: 0,

  theoreticalSteps: [],
  detectedSteps: [],
  alignmentRows: [],

  totalDriftS: 0,
  averageDriftS: 0,
  averageAbsoluteDriftS: 0,
  medianAbsoluteDriftS: 0,
  maxLateStepS: 0,
  maxEarlyStepS: 0,
  attunementScore: 0,

gpsTrack: [],
gpsDistanceM: 0,
stepDistanceM: 0,
lastGpsAccuracyM: null,
  reflectionActivity: "",
  reflectionDifficulty: "",
  reflectionNotes: "",
};

let timer = null;
let theoreticalTimer = null;
let gpsWatchId = null;
let audioContext = null;

let lastDetectedStepTime = 0;
let previousSignal = 0;
let smoothedSignal = 0;
let gravityBaseline = 9.81;

let resultsMap = null;
let resultsPolyline = null;
let resultsStartMarker = null;
let resultsEndMarker = null;

function safeFilenameText(value) {
  return (
    String(value || "anonymous")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "anonymous"
  );
}

function formatS(value) {
  return Number(value || 0).toFixed(3);
}

function csvEscape(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function safeIsoFilenamePart() {
  return new Date().toISOString().replaceAll(":", "-");
}

function mapSensitivity(value) {
  const threshold = 1.8 - ((value - 1) / 9) * 1.45;
  const refractory = Math.round(1150 - ((value - 1) / 9) * 650);
  return { threshold, refractory };
}

function applySensitivity(value) {
  state.sensitivity = value;
  const mapped = mapSensitivity(value);
  state.peakThreshold = mapped.threshold;
  state.refractoryMs = mapped.refractory;
}

applySensitivity(state.sensitivity);

async function ensureAudioContext() {
  if (!audioContext) {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;

    if (!AudioCtor) {
      alert("Audio is not supported on this browser.");
      return;
    }

    audioContext = new AudioCtor();
  }

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }
}

async function playScannerBeep() {
  await ensureAudioContext();

  if (!audioContext) return;

  const now = audioContext.currentTime;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(880, now);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.35, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);

  oscillator.connect(gain);
  gain.connect(audioContext.destination);

  oscillator.start(now);
  oscillator.stop(now + 0.18);
}

function getSessionTimeS() {
  if (!state.sessionStartedAt) return 0;
  const end = state.sessionEndedAt || Date.now();
  return (end - state.sessionStartedAt) / 1000;
}

function resetMotionSignal() {
  lastDetectedStepTime = 0;
  previousSignal = 0;
  smoothedSignal = 0;
  gravityBaseline = 9.81;
  state.motionSignal = 0;
  state.motionSource = "none";
}

function resetSessionData() {
  stopTimers();
  stopGpsWatch();
  destroyResultsMap();

  state.sessionStartedAt = null;
  state.sessionEndedAt = null;
  state.elapsedS = 0;

  state.theoreticalStepIndex = 0;
  state.detectedStepIndex = 0;

  state.theoreticalSteps = [];
  state.detectedSteps = [];
  state.alignmentRows = [];

  state.totalDriftS = 0;
  state.averageDriftS = 0;
  state.averageAbsoluteDriftS = 0;
  state.medianAbsoluteDriftS = 0;
  state.maxLateStepS = 0;
  state.maxEarlyStepS = 0;
  state.attunementScore = 0;

  state.gpsTrack = [];
state.gpsDistanceM = 0;
state.stepDistanceM = 0;
state.lastGpsAccuracyM = null;
  resetMotionSignal();
}

function stopTimers() {
  if (timer) {
    window.clearInterval(timer);
    timer = null;
  }

  if (theoreticalTimer) {
    window.clearInterval(theoreticalTimer);
    theoreticalTimer = null;
  }
}

function calculateStats() {
  const rows = state.alignmentRows;

  if (rows.length === 0) {
    state.totalDriftS = 0;
    state.averageDriftS = 0;
    state.averageAbsoluteDriftS = 0;
    state.medianAbsoluteDriftS = 0;
    state.maxLateStepS = 0;
    state.maxEarlyStepS = 0;
    state.attunementScore = 0;
    return;
  }

  const drifts = rows.map((row) => row.misalignmentS);
  const absoluteDrifts = drifts.map((value) => Math.abs(value));

  state.totalDriftS = drifts.reduce((sum, value) => sum + value, 0);
  state.averageDriftS = state.totalDriftS / rows.length;
  state.averageAbsoluteDriftS =
    absoluteDrifts.reduce((sum, value) => sum + value, 0) / rows.length;

  const sortedAbs = [...absoluteDrifts].sort((a, b) => a - b);
  const mid = Math.floor(sortedAbs.length / 2);

  state.medianAbsoluteDriftS =
    sortedAbs.length % 2 === 0
      ? (sortedAbs[mid - 1] + sortedAbs[mid]) / 2
      : sortedAbs[mid];

  state.maxLateStepS = Math.max(...drifts);
  state.maxEarlyStepS = Math.min(...drifts);

  const toleranceS = 1;
  state.attunementScore = Math.max(
    0,
    Math.min(100, 100 * (1 - state.averageAbsoluteDriftS / toleranceS))
  );
}

function findClosestTheoreticalStep(actualTimeS) {
  let best = null;
  let bestDistance = Infinity;

  for (const step of state.theoreticalSteps) {
    if (step.matched) continue;

    const distance = Math.abs(actualTimeS - step.theoreticalTimeS);

    if (distance < bestDistance) {
      best = step;
      bestDistance = distance;
    }
  }

  return best;
}

function recordTheoreticalStep() {
  if (!state.sessionStartedAt || !state.calculatedIntervalS) return;

  state.theoreticalStepIndex += 1;

  const theoreticalTimeS =
    state.theoreticalStepIndex * state.calculatedIntervalS;

  state.theoreticalSteps.push({
    stepIndex: state.theoreticalStepIndex,
    theoreticalTimeS,
    matched: false,
  });

  void playScannerBeep();
}

function recordDetectedStep(source = "manual") {
  if (!state.sessionStartedAt || state.sessionEndedAt) return;

  state.detectedStepIndex += 1;

const stepLengthM = Number(state.stepLengthCm) / 100;

if (Number.isFinite(stepLengthM) && stepLengthM > 0) {
  state.stepDistanceM += stepLengthM;
}

  const actualTimeS = getSessionTimeS();

  state.detectedSteps.push({
    detectedIndex: state.detectedStepIndex,
    actualTimeS,
    source,
  });

  const closest = findClosestTheoreticalStep(actualTimeS);

if (
  closest &&
  Math.abs(actualTimeS - closest.theoreticalTimeS) <= STEP_MATCH_WINDOW_S
) 
{    closest.matched = true;

    const misalignmentS = actualTimeS - closest.theoreticalTimeS;

    state.alignmentRows.push({
      stepIndex: closest.stepIndex,
      theoreticalTimeS: closest.theoreticalTimeS,
      actualTimeS,
      misalignmentS,
      source,
    });

    calculateStats();
  }

  updateWalkMetrics();
}

function getMotionValue(event) {
  const acc = event.acceleration;

  if (acc && acc.x != null && acc.y != null && acc.z != null) {
    state.motionSource = "acceleration";
    const x = acc.x || 0;
    const y = acc.y || 0;
    const z = acc.z || 0;
    return Math.sqrt(x * x + y * y + z * z);
  }

  const accG = event.accelerationIncludingGravity;

  if (accG && accG.x != null && accG.y != null && accG.z != null) {
    state.motionSource = "accelerationIncludingGravity";
    const x = accG.x || 0;
    const y = accG.y || 0;
    const z = accG.z || 0;
    const magnitude = Math.sqrt(x * x + y * y + z * z);

    gravityBaseline = 0.03 * magnitude + 0.97 * gravityBaseline;
    return Math.abs(magnitude - gravityBaseline);
  }

  state.motionSource = "none";
  return null;
}

function handleMotionEvent(event) {
  const rawValue = getMotionValue(event);
  if (rawValue == null) return;

  smoothedSignal = 0.35 * rawValue + 0.65 * smoothedSignal;
  state.motionSignal = smoothedSignal;

  const now = Date.now();
  const enoughTimePassed = now - lastDetectedStepTime > state.refractoryMs;
  const crossedUp =
    previousSignal <= state.peakThreshold &&
    state.motionSignal > state.peakThreshold;

  if (state.sessionStartedAt && !state.sessionEndedAt && crossedUp && enoughTimePassed) {
    lastDetectedStepTime = now;
    recordDetectedStep("motion");
  }

  previousSignal = state.motionSignal;
  updateWalkMetrics();
}

async function enableMotion() {
  try {
    const MotionEventWithPermission = DeviceMotionEvent;

    if (
      typeof MotionEventWithPermission !== "undefined" &&
      typeof MotionEventWithPermission.requestPermission === "function"
    ) {
      const permission = await MotionEventWithPermission.requestPermission();

      if (permission !== "granted") {
        alert("Motion permission denied.");
        return;
      }
    }

    window.removeEventListener("devicemotion", handleMotionEvent);
    window.addEventListener("devicemotion", handleMotionEvent);

    state.motionEnabled = true;
    render();
  } catch (error) {
    console.error(error);
    alert("Unable to enable motion on this device/browser.");
  }
}

function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371000;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

function shouldUseGpsPoint(point) {
  return (
    Number.isFinite(point.accuracyM) &&
    point.accuracyM > 0 &&
    point.accuracyM <= GPS_MAX_ACCURACY_M
  );
}
function buildGpsPoint(position) {
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracyM: position.coords.accuracy,
    absoluteTimeMs: position.timestamp,
    timeS: state.sessionStartedAt
      ? (position.timestamp - state.sessionStartedAt) / 1000
      : 0,
  };
}

function addGpsPoint(position) {
  const point = buildGpsPoint(position);

  if (!shouldUseGpsPoint(point)) return;

  state.lastGpsAccuracyM = point.accuracyM;

  if (state.gpsTrack.length === 0) {
    state.gpsTrack.push(point);
    updateWalkMetrics();
    return;
  }

  const previous = state.gpsTrack[state.gpsTrack.length - 1];

  const segmentDistance = haversineDistanceMeters(
    previous.latitude,
    previous.longitude,
    point.latitude,
    point.longitude
  );

  const timeDiffS = point.timeS - previous.timeS;

  if (timeDiffS <= 0) return;

  const speedMps = segmentDistance / timeDiffS;

  if (segmentDistance < GPS_MIN_MOVEMENT_M) {
    return;
  }

  if (speedMps > GPS_MAX_WALKING_SPEED_MPS) {
    return;
  }

  state.gpsDistanceM += segmentDistance;
  state.gpsTrack.push(point);

  updateWalkMetrics();
}
function enableGps() {
  if (!navigator.geolocation) {
    alert("Geolocation is not supported on this device/browser.");
    return;
  }

  state.gpsDenied = false;

  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.gpsEnabled = true;

      if (state.sessionStartedAt && !state.sessionEndedAt) {
        addGpsPoint(position);
      }

      render();
    },
    (error) => {
      console.error(error);
      state.gpsEnabled = false;
      state.gpsDenied = true;
      render();
      alert("GPS denied or unavailable.");
    },
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10000,
    }
  );
}

function startGpsWatch() {
  if (!state.gpsEnabled || !navigator.geolocation) return;

  stopGpsWatch();

  gpsWatchId = navigator.geolocation.watchPosition(
    (position) => {
      if (state.sessionStartedAt && !state.sessionEndedAt) {
        addGpsPoint(position);
      }
    },
    (error) => {
      console.error(error);
      state.gpsDenied = true;
      stopGpsWatch();
    },
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10000,
    }
  );
}

function stopGpsWatch() {
  if (gpsWatchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }
}

async function startSession() {
  resetSessionData();

  await ensureAudioContext();

  state.sessionStartedAt = Date.now();
  state.sessionEndedAt = null;
  state.elapsedS = 0;

  timer = window.setInterval(() => {
    state.elapsedS = getSessionTimeS();
    updateWalkMetrics();
  }, 100);

  recordTheoreticalStep();

  theoreticalTimer = window.setInterval(() => {
    recordTheoreticalStep();
  }, state.calculatedIntervalS * 1000);

  startGpsWatch();
}

function endSession() {
  stopTimers();
  stopGpsWatch();

  state.sessionEndedAt = Date.now();
  state.elapsedS = getSessionTimeS();
  calculateStats();

  state.page = "reflection";
  render();
}

function updateWalkMetrics() {
  const elapsed = document.querySelector("#elapsed-time");
  if (elapsed) elapsed.textContent = `${formatS(state.elapsedS)} s`;

  const theoreticalSteps = document.querySelector("#theoretical-steps");
  if (theoreticalSteps) theoreticalSteps.textContent = state.theoreticalSteps.length;

  const detectedSteps = document.querySelector("#detected-steps");
  if (detectedSteps) detectedSteps.textContent = state.detectedSteps.length;

  const avgAbs = document.querySelector("#average-absolute-drift");
  if (avgAbs) avgAbs.textContent = `${formatS(state.averageAbsoluteDriftS)} s`;

  const gpsPoints = document.querySelector("#gps-points");
  if (gpsPoints) gpsPoints.textContent = state.gpsTrack.length;

const gpsDistance = document.querySelector("#gps-distance");
if (gpsDistance) gpsDistance.textContent = `${state.gpsDistanceM.toFixed(2)} m`;

const stepDistance = document.querySelector("#step-distance");
if (stepDistance) stepDistance.textContent = `${state.stepDistanceM.toFixed(2)} m`;

const gpsAccuracy = document.querySelector("#gps-accuracy");
if (gpsAccuracy) {
  gpsAccuracy.textContent =
    state.lastGpsAccuracyM === null
      ? "n/a"
      : `${state.lastGpsAccuracyM.toFixed(1)} m`;
}
  const motionSignal = document.querySelector("#motion-signal");
  if (motionSignal) motionSignal.textContent = state.motionSignal.toFixed(3);
}

function buildCsvString() {
  const rows = [];

  rows.push(["SESSION_SUMMARY"]);
  rows.push(["metric", "value", "unit"]);
  rows.push(["project_title", PROJECT_TITLE, ""]);
  rows.push(["nickname", state.nickname || "anonymous", ""]);
  rows.push(["exported_at", new Date().toISOString(), ""]);
  rows.push([
    "session_started_at",
    state.sessionStartedAt ? new Date(state.sessionStartedAt).toISOString() : "",
    "",
  ]);
  rows.push([
    "session_ended_at",
    state.sessionEndedAt ? new Date(state.sessionEndedAt).toISOString() : "",
    "",
  ]);
  rows.push(["session_duration", formatS(state.elapsedS), "s"]);
  rows.push(["scanner_speed", SCANNER_SPEED_M_PER_HOUR, "m/hour"]);
  rows.push(["scanner_speed", SCANNER_SPEED_M_PER_SECOND.toFixed(3), "m/s"]);
  rows.push(["step_length", state.stepLengthCm, "cm"]);
  rows.push(["theoretical_step_interval", formatS(state.calculatedIntervalS), "s"]);
  rows.push(["theoretical_steps", state.theoreticalSteps.length, "count"]);
  rows.push(["detected_steps", state.detectedSteps.length, "count"]);
  rows.push(["matched_steps", state.alignmentRows.length, "count"]);

  rows.push([]);
  rows.push(["ATTUNEMENT_METRICS"]);
  rows.push(["metric", "value", "unit"]);
  rows.push(["attunement_score", state.attunementScore.toFixed(1), "percent"]);
  rows.push(["total_temporal_drift", formatS(state.totalDriftS), "s"]);
  rows.push(["average_temporal_drift", formatS(state.averageDriftS), "s"]);
  rows.push(["average_absolute_drift", formatS(state.averageAbsoluteDriftS), "s"]);
  rows.push(["median_absolute_drift", formatS(state.medianAbsoluteDriftS), "s"]);
  rows.push(["maximum_positive_deviation", formatS(state.maxLateStepS), "s"]);
  rows.push(["maximum_negative_deviation", formatS(state.maxEarlyStepS), "s"]);

  rows.push([]);
  rows.push(["STEP_ALIGNMENT_TABLE"]);
  rows.push([
    "step_index",
    "theoretical_time_s",
    "actual_time_s",
    "misalignment_s",
    "source",
  ]);

  state.alignmentRows.forEach((row) => {
    rows.push([
      row.stepIndex,
      formatS(row.theoreticalTimeS),
      formatS(row.actualTimeS),
      formatS(row.misalignmentS),
      row.source,
    ]);
  });

  rows.push([]);
  rows.push(["ROUTE_METRICS"]);
  rows.push(["metric", "value", "unit"]);
rows.push(["distance_steps", state.stepDistanceM.toFixed(3), "m"]);
rows.push(["distance_gps", state.gpsDistanceM.toFixed(3), "m"]);  rows.push(["gps_points", state.gpsTrack.length, "count"]);

  if (state.gpsTrack.length > 0) {
    const first = state.gpsTrack[0];
    const last = state.gpsTrack[state.gpsTrack.length - 1];

    rows.push(["gps_start_latitude", first.latitude, "decimal degrees"]);
    rows.push(["gps_start_longitude", first.longitude, "decimal degrees"]);
    rows.push(["gps_end_latitude", last.latitude, "decimal degrees"]);
    rows.push(["gps_end_longitude", last.longitude, "decimal degrees"]);
  }

  rows.push([]);
  rows.push(["GPS_TRACK"]);
  rows.push(["point_index", "timestamp_s", "latitude", "longitude", "accuracy_m"]);

  state.gpsTrack.forEach((point, index) => {
    rows.push([
      index + 1,
      formatS(point.timeS),
      point.latitude,
      point.longitude,
      point.accuracyM,
    ]);
  });

  rows.push([]);
  rows.push(["OPTIONAL_REFLECTION"]);
  rows.push(["metric", "value", "unit"]);
  rows.push(["daily_activity", state.reflectionActivity, ""]);
  rows.push(["attunement_difficulty", state.reflectionDifficulty, "1-5"]);
  rows.push(["notes", state.reflectionNotes, ""]);

  return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
}

function buildGpxString() {
  const points = state.gpsTrack
    .map((point) => {
      const isoTime = new Date(point.absoluteTimeMs).toISOString();

      return `
      <trkpt lat="${point.latitude}" lon="${point.longitude}">
        <time>${isoTime}</time>
        <hdop>${point.accuracyM}</hdop>
      </trkpt>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="${PROJECT_TITLE}" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${PROJECT_TITLE}</name>
    <time>${new Date().toISOString()}</time>
  </metadata>
  <trk>
    <name>${PROJECT_TITLE} Session Track</name>
    <trkseg>${points}
    </trkseg>
  </trk>
</gpx>`;
}

function buildGeoJsonString() {
  const geojson = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {
          project_title: PROJECT_TITLE,
          nickname: state.nickname || "anonymous",
          exported_at: new Date().toISOString(),
          distance_steps_m: Number(state.stepDistanceM.toFixed(3)),
distance_gps_m: Number(state.gpsDistanceM.toFixed(3)),          gps_points: state.gpsTrack.length,
        },
        geometry: {
          type: "LineString",
          coordinates: state.gpsTrack.map((point) => [
            point.longitude,
            point.latitude,
          ]),
        },
      },
    ],
  };

  return JSON.stringify(geojson, null, 2);
}

function downloadBlob(content, filename, type) {
  const file = new Blob([content], { type });
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  URL.revokeObjectURL(url);
}

function downloadCsv() {
  const nickname = safeFilenameText(state.nickname);

  downloadBlob(
    buildCsvString(),
    `${nickname}-${FILE_PREFIX}-session-${safeIsoFilenamePart()}.csv`,
    "text/csv;charset=utf-8"
  );
}

function downloadGpx() {
  const nickname = safeFilenameText(state.nickname);

  downloadBlob(
    buildGpxString(),
    `${nickname}-${FILE_PREFIX}-track-${safeIsoFilenamePart()}.gpx`,
    "application/gpx+xml"
  );
}

function downloadGeoJson() {
  const nickname = safeFilenameText(state.nickname);

  downloadBlob(
    buildGeoJsonString(),
    `${nickname}-${FILE_PREFIX}-track-${safeIsoFilenamePart()}.geojson`,
    "application/geo+json"
  );
}

async function downloadMapJpeg() {
  const nickname = safeFilenameText(state.nickname);
  const mapElement = document.querySelector("#results-map");

  if (!mapElement) {
    alert("Map is not available.");
    return;
  }

  try {
    await new Promise((resolve) => window.setTimeout(resolve, 700));

    const dataUrl = await toJpeg(mapElement, {
      cacheBust: true,
      pixelRatio: 2,
      backgroundColor: "#ffffff",
    });

    const response = await fetch(dataUrl);
    const blob = await response.blob();

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download = `${nickname}-${FILE_PREFIX}-map-${safeIsoFilenamePart()}.jpg`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    URL.revokeObjectURL(url);
  } catch (error) {
    console.error(error);
    alert("Map JPEG export failed. Try downloading CSV, GPX or GeoJSON instead.");
  }
}
async function downloadAllFiles() {
  const nickname = safeFilenameText(state.nickname);
  const timestamp = safeIsoFilenamePart();

  const zip = new JSZip();

  zip.file(
    `${nickname}-${FILE_PREFIX}-session-${timestamp}.csv`,
    buildCsvString()
  );

  if (state.gpsTrack.length > 0) {
    zip.file(
      `${nickname}-${FILE_PREFIX}-track-${timestamp}.gpx`,
      buildGpxString()
    );

    zip.file(
      `${nickname}-${FILE_PREFIX}-track-${timestamp}.geojson`,
      buildGeoJsonString()
    );

    const mapElement = document.querySelector("#results-map");

    if (mapElement) {
      try {
        await new Promise((resolve) => window.setTimeout(resolve, 700));

        const dataUrl = await toJpeg(mapElement, {
          cacheBust: true,
          pixelRatio: 2,
          backgroundColor: "#ffffff",
        });

        const response = await fetch(dataUrl);
        const mapBlob = await response.blob();

        zip.file(
          `${nickname}-${FILE_PREFIX}-map-${timestamp}.jpg`,
          mapBlob
        );
      } catch (error) {
        console.error(error);
        alert("Map JPEG could not be added to the ZIP. CSV, GPX and GeoJSON will still be included.");
      }
    }
  }

  const blob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: {
      level: 9,
    },
  });

  downloadBlob(
    blob,
    `${nickname}-${FILE_PREFIX}-package-${timestamp}.zip`,
    "application/zip"
  );
}
function prepareEmail() {
  const nickname = state.nickname || "anonymous";

  const subject = encodeURIComponent(`${nickname} - ${PROJECT_TITLE}`);

const body = encodeURIComponent(
  `Session data from ${nickname}.

Please attach the downloaded session files.

Project: ${PROJECT_TITLE}
Duration: ${formatS(state.elapsedS)} s
Theoretical step interval: ${formatS(state.calculatedIntervalS)} s
Matched steps: ${state.alignmentRows.length}
Average temporal drift: ${formatS(state.averageDriftS)} s
Average absolute drift: ${formatS(state.averageAbsoluteDriftS)} s
Attunement score: ${state.attunementScore.toFixed(1)}%
Distance from steps: ${state.stepDistanceM.toFixed(2)} m
Distance from GPS: ${state.gpsDistanceM.toFixed(2)} m
GPS points: ${state.gpsTrack.length}`
);

window.location.href =
  `mailto:${RECIPIENT_EMAIL}?subject=${subject}&body=${body}`;
  }
function destroyResultsMap() {
  if (resultsMap) {
    resultsMap.remove();
    resultsMap = null;
  }

  resultsPolyline = null;
  resultsStartMarker = null;
  resultsEndMarker = null;
}

function initOrUpdateResultsMap() {
  const mapContainer = document.querySelector("#results-map");
  if (!mapContainer) return;

  if (!resultsMap) {
    resultsMap = L.map(mapContainer, {
      zoomControl: true,
      attributionControl: true,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      crossOrigin: true,
      maxZoom: 19,
    }).addTo(resultsMap);
  }

  if (resultsPolyline) {
    resultsPolyline.remove();
    resultsPolyline = null;
  }

  if (resultsStartMarker) {
    resultsStartMarker.remove();
    resultsStartMarker = null;
  }

  if (resultsEndMarker) {
    resultsEndMarker.remove();
    resultsEndMarker = null;
  }

  if (state.gpsTrack.length === 0) {
    resultsMap.setView([0, 0], 2);
    resultsMap.invalidateSize();
    return;
  }

  const latLngs = state.gpsTrack.map((point) =>
    L.latLng(point.latitude, point.longitude)
  );

  if (latLngs.length === 1) {
    resultsStartMarker = L.circleMarker(latLngs[0], {
      radius: 8,
      color: "#2b7a3d",
      fillColor: "#2b7a3d",
      fillOpacity: 1,
      weight: 2,
    }).addTo(resultsMap);

    resultsMap.setView(latLngs[0], 17);
    resultsMap.invalidateSize();
    return;
  }

  resultsPolyline = L.polyline(latLngs, {
    color: "#1f1b16",
    weight: 4,
    opacity: 0.9,
  }).addTo(resultsMap);

  resultsStartMarker = L.circleMarker(latLngs[0], {
    radius: 7,
    color: "#2b7a3d",
    fillColor: "#2b7a3d",
    fillOpacity: 1,
    weight: 2,
  }).addTo(resultsMap);

  resultsEndMarker = L.circleMarker(latLngs[latLngs.length - 1], {
    radius: 7,
    color: "#8f2d2d",
    fillColor: "#8f2d2d",
    fillOpacity: 1,
    weight: 2,
  }).addTo(resultsMap);

  const bounds = L.latLngBounds(latLngs);
  resultsMap.fitBounds(bounds.pad(0.15));
  resultsMap.invalidateSize();
}

function resetApp() {
  window.removeEventListener("devicemotion", handleMotionEvent);

  state.page = "welcome";
  state.consent = false;

  state.nickname = "";
  state.stepLengthCm = "";
  state.calculatedIntervalS = null;

  state.motionEnabled = false;
  state.gpsEnabled = false;
  state.gpsDenied = false;

  state.reflectionActivity = "";
  state.reflectionDifficulty = "";
  state.reflectionNotes = "";

  resetSessionData();
}

function render() {
  const app = document.querySelector("#app");
  if (!app) return;

  if (state.page !== "results") {
    destroyResultsMap();
  }

  if (state.page === "welcome") {
    app.innerHTML = `
      <main class="app-shell">
        <section class="screen">
          <header class="topbar">
            <div class="project-tag">${PROJECT_TITLE}</div>
          </header>

          <div class="content">
            <h1>Welcome</h1>

            <p>This interface proposes a simple exercise in attunement.</p>

            <p>
              A scanning device operates at a fixed speed of 883 meters per hour.
              You are invited to continue with an ordinary daily activity while
              attempting to move with the scanner's pace.
            </p>

            <button id="to-consent" class="primary-button">Begin</button>
          </div>
        </section>
      </main>
    `;
  }

  if (state.page === "consent") {
    app.innerHTML = `
      <main class="app-shell">
        <section class="screen">
          <header class="topbar">
            <button id="back" class="ghost-button">Back</button>
            <div class="project-tag">Consent</div>
          </header>

          <div class="content">
            <h1>Data consent</h1>

            <p>
              During the activity, this app may record session timing,
              motion-based step alignment data, optional GPS route data,
              and optional reflection data.
            </p>

            <p>
              GPS can be enabled or skipped. Nickname and reflection are optional.
            </p>

            <label class="checkbox-row">
              <input id="consent-checkbox" type="checkbox" ${state.consent ? "checked" : ""}>
              <span>I understand and agree to continue.</span>
            </label>

            <button id="to-setup" class="primary-button">Continue</button>
          </div>
        </section>
      </main>
    `;
  }

  if (state.page === "setup") {
    app.innerHTML = `
      <main class="app-shell">
        <section class="screen">
          <header class="topbar">
            <button id="back" class="ghost-button">Back</button>
            <div class="project-tag">Body setup</div>
          </header>

          <div class="content">
            <h1>Body setup</h1>

            <p>
              Add a nickname if you want your exported file to be identifiable.
              You can also leave it empty and continue anonymously.
            </p>

            <label class="field">
              <span>Nickname optional</span>
              <input id="nickname" type="text" value="${state.nickname}" placeholder="anonymous">
            </label>

            <label class="field">
              <span>Step length in centimeters</span>
              <input id="step-length" type="number" value="${state.stepLengthCm}" placeholder="Example: 72">
            </label>

            <button id="to-calibration" class="primary-button">Continue</button>
          </div>
        </section>
      </main>
    `;
  }

  if (state.page === "calibration") {
    const gpsStatus = state.gpsDenied
      ? "Denied"
      : state.gpsEnabled
        ? "Enabled"
        : "Not enabled";

    app.innerHTML = `
      <main class="app-shell">
        <section class="screen">
          <header class="topbar">
            <button id="back" class="ghost-button">Back</button>
            <div class="project-tag">Calibration</div>
          </header>

          <div class="content">
            <h1>Calculated scanner rhythm</h1>

            <div class="metric-card">
              <span class="metric-label">Theoretical step interval</span>
              <span class="metric-value">${formatS(state.calculatedIntervalS)} s</span>
            </div>

            <p>
              When the session starts, you will hear one acoustic signal for each
              theoretical scanner step. Each signal indicates the moment at which
              you should attempt to take a step while continuing your daily activity.
            </p>

            <label class="field">
              <span>Detection sensitivity</span>
              <input id="sensitivity-slider" type="range" min="1" max="10" step="1" value="${state.sensitivity}">
            </label>

            <div class="metric-card">
              <span class="metric-label">Motion</span>
              <span class="metric-value">${state.motionEnabled ? "Enabled" : "Not enabled"}</span>
            </div>

            <div class="metric-card">
              <span class="metric-label">GPS</span>
              <span class="metric-value">${gpsStatus}</span>
            </div>

            <div class="metric-card">
              <span class="metric-label">Threshold / refractory</span>
              <span class="metric-value">${state.peakThreshold.toFixed(2)} / ${state.refractoryMs} ms</span>
            </div>

            <button id="enable-motion" class="secondary-button">Enable motion detection</button>
            <button id="enable-gps" class="secondary-button">Enable GPS optional</button>

            <p>
              During the activity, let the acoustic signal accompany your movement
              without interrupting what you are already doing.
            </p>

            <button id="to-walk" class="primary-button" ${!state.motionEnabled ? "disabled" : ""}>
              Start session with acoustic cue
            </button>
          </div>
        </section>
      </main>
    `;
  }

  if (state.page === "walk") {
    app.innerHTML = `
      <main class="app-shell">
        <section class="screen">
          <header class="topbar">
            <div class="project-tag">Performance</div>
          </header>

          <div class="content">
            <h1>Daily activity</h1>

            <p>Continue with the activity you intended to do.</p>

            <p>
              You will hear an acoustic signal at each theoretical scanner step.
              Each signal marks the moment at which you should attempt to take a
              step. The objective is not precision, but an attunement attempt
              between your daily activity and the scanner's pace.
            </p>

            <div class="metric-card">
              <span class="metric-label">Elapsed time</span>
              <span class="metric-value" id="elapsed-time">${formatS(state.elapsedS)} s</span>
            </div>

            <div class="metric-card">
              <span class="metric-label">Theoretical steps / acoustic cues</span>
              <span class="metric-value" id="theoretical-steps">${state.theoreticalSteps.length}</span>
            </div>

            <div class="metric-card">
              <span class="metric-label">Detected steps</span>
              <span class="metric-value" id="detected-steps">${state.detectedSteps.length}</span>
            </div>

            <div class="metric-card">
              <span class="metric-label">Average absolute drift</span>
              <span class="metric-value" id="average-absolute-drift">${formatS(state.averageAbsoluteDriftS)} s</span>
            </div>

            <div class="metric-card">
              <span class="metric-label">GPS points</span>
              <span class="metric-value" id="gps-points">${state.gpsTrack.length}</span>
            </div>

            <div class="metric-card">
  <span class="metric-label">Distance from steps</span>
  <span class="metric-value" id="step-distance">${state.stepDistanceM.toFixed(2)} m</span>
</div>

<div class="metric-card">
  <span class="metric-label">Distance from GPS</span>
  <span class="metric-value" id="gps-distance">${state.gpsDistanceM.toFixed(2)} m</span>
</div>

<div class="metric-card">
  <span class="metric-label">GPS accuracy</span>
  <span class="metric-value" id="gps-accuracy">${
    state.lastGpsAccuracyM === null ? "n/a" : `${state.lastGpsAccuracyM.toFixed(1)} m`
  }</span>
</div>
            <div class="metric-card">
              <span class="metric-label">Motion signal</span>
              <span class="metric-value" id="motion-signal">${state.motionSignal.toFixed(3)}</span>
            </div>

            <button id="record-step" class="secondary-button">
              Record step manually
            </button>

            <button id="end-session" class="primary-button">
              End session
            </button>
          </div>
        </section>
      </main>
    `;
  }

  if (state.page === "reflection") {
    app.innerHTML = `
      <main class="app-shell">
        <section class="screen">
          <header class="topbar">
            <div class="project-tag">Optional reflection</div>
          </header>

          <div class="content">
            <h1>Reflection optional</h1>

            <p>
              You may add a short reflection about the daily activity and the
              difficulty of attuning to the scanner pace. This section is optional
              and can be skipped.
            </p>

            <label class="field">
              <span>What activity were you doing? optional</span>
              <input id="reflection-activity" type="text" value="${state.reflectionActivity}" placeholder="Example: commuting, shopping, cleaning">
            </label>

            <label class="field">
              <span>How difficult was attunement? optional</span>
              <select id="reflection-difficulty">
                <option value="">Skip</option>
                <option value="1" ${state.reflectionDifficulty === "1" ? "selected" : ""}>1 very easy</option>
                <option value="2" ${state.reflectionDifficulty === "2" ? "selected" : ""}>2 easy</option>
                <option value="3" ${state.reflectionDifficulty === "3" ? "selected" : ""}>3 neutral</option>
                <option value="4" ${state.reflectionDifficulty === "4" ? "selected" : ""}>4 difficult</option>
                <option value="5" ${state.reflectionDifficulty === "5" ? "selected" : ""}>5 very difficult</option>
              </select>
            </label>

            <label class="field">
              <span>Additional notes optional</span>
              <textarea id="reflection-notes" rows="4" placeholder="Write anything you want to remember">${state.reflectionNotes}</textarea>
            </label>

            <button id="save-reflection" class="primary-button">Save reflection</button>
            <button id="skip-reflection" class="secondary-button">Skip reflection</button>
          </div>
        </section>
      </main>
    `;
  }

  if (state.page === "results") {
    const firstGps = state.gpsTrack[0];
    const lastGps = state.gpsTrack[state.gpsTrack.length - 1];

    app.innerHTML = `
      <main class="app-shell">
        <section class="screen">
          <header class="topbar">
            <div class="project-tag">Results</div>
          </header>

          <div class="content">
            <h1>Session complete</h1>

            <div class="metric-card">
              <span class="metric-label">Nickname</span>
              <span class="metric-value">${state.nickname || "anonymous"}</span>
            </div>

            <div class="metric-card">
              <span class="metric-label">Duration</span>
              <span class="metric-value">${formatS(state.elapsedS)} s</span>
            </div>

            <div class="metric-card">
              <span class="metric-label">Theoretical step interval</span>
              <span class="metric-value">${formatS(state.calculatedIntervalS)} s</span>
            </div>

            <div class="metric-card">
              <span class="metric-label">Matched steps</span>
              <span class="metric-value">${state.alignmentRows.length}</span>
            </div>

            <div class="metric-card">
              <span class="metric-label">Total temporal drift</span>
              <span class="metric-value">${formatS(state.totalDriftS)} s</span>
            </div>

            <div class="metric-card">
              <span class="metric-label">Average temporal drift</span>
              <span class="metric-value">${formatS(state.averageDriftS)} s</span>
            </div>

            <div class="metric-card">
              <span class="metric-label">Average absolute drift</span>
              <span class="metric-value">${formatS(state.averageAbsoluteDriftS)} s</span>
            </div>

            <div class="metric-card">
              <span class="metric-label">Attunement score</span>
              <span class="metric-value">${state.attunementScore.toFixed(1)}%</span>
            </div>

<div class="metric-card">
  <span class="metric-label">Distance from steps</span>
  <span class="metric-value">${state.stepDistanceM.toFixed(2)} m</span>
</div>

<div class="metric-card">
  <span class="metric-label">Distance from GPS</span>
  <span class="metric-value">${state.gpsDistanceM.toFixed(2)} m</span>
</div>

<div class="metric-card">
  <span class="metric-label">Last GPS accuracy</span>
  <span class="metric-value">${
    state.lastGpsAccuracyM === null
      ? "n/a"
      : `${state.lastGpsAccuracyM.toFixed(1)} m`
  }</span>
</div>
            <div class="metric-card">
              <span class="metric-label">GPS points</span>
              <span class="metric-value">${state.gpsTrack.length}</span>
            </div>

            <section class="metric-card">
              <span class="metric-label">Route map</span>
              <div id="results-map" class="leaflet-map"></div>
              <p>
                Start:
                ${firstGps ? `${firstGps.latitude.toFixed(6)}, ${firstGps.longitude.toFixed(6)}` : "n/a"}
              </p>
              <p>
                End:
                ${lastGps ? `${lastGps.latitude.toFixed(6)}, ${lastGps.longitude.toFixed(6)}` : "n/a"}
              </p>
            </section>

            <button id="download-csv" class="primary-button">Download CSV</button>
            <button id="download-gpx" class="secondary-button" ${state.gpsTrack.length === 0 ? "disabled" : ""}>Download GPX</button>
            <button id="download-geojson" class="secondary-button" ${state.gpsTrack.length === 0 ? "disabled" : ""}>Download GeoJSON</button>
            <button id="download-map" class="secondary-button" ${state.gpsTrack.length === 0 ? "disabled" : ""}>Download map JPEG</button>
            <button id="download-all" class="secondary-button">Download all available files</button>
            <button id="share-email" class="secondary-button">Prepare email</button>
            <button id="restart" class="ghost-button">Start again</button>
          </div>
        </section>
      </main>
    `;

    window.requestAnimationFrame(() => {
      initOrUpdateResultsMap();
    });
  }

  bindEvents();
}

function bindEvents() {
  document.querySelector("#to-consent")?.addEventListener("click", () => {
    state.page = "consent";
    render();
  });

  document.querySelector("#consent-checkbox")?.addEventListener("change", (event) => {
    state.consent = event.target.checked;
  });

  document.querySelector("#to-setup")?.addEventListener("click", () => {
    if (!state.consent) {
      alert("Please accept the consent before continuing.");
      return;
    }

    state.page = "setup";
    render();
  });

  document.querySelector("#to-calibration")?.addEventListener("click", () => {
    state.nickname = document.querySelector("#nickname").value.trim();
    state.stepLengthCm = document.querySelector("#step-length").value.trim();

    const stepLength = Number(state.stepLengthCm);

    if (!stepLength || Number.isNaN(stepLength) || stepLength <= 0) {
      alert("Please enter a valid step length.");
      return;
    }

    const stepLengthM = stepLength / 100;
    state.calculatedIntervalS = stepLengthM / SCANNER_SPEED_M_PER_SECOND;

    state.page = "calibration";
    render();
  });

  document.querySelector("#sensitivity-slider")?.addEventListener("input", (event) => {
    applySensitivity(Number(event.target.value));
    render();
  });

  document.querySelector("#enable-motion")?.addEventListener("click", async () => {
    await enableMotion();
  });

  document.querySelector("#enable-gps")?.addEventListener("click", () => {
    enableGps();
  });

  document.querySelector("#to-walk")?.addEventListener("click", async () => {
    if (!state.motionEnabled) {
      alert("Please enable motion detection before starting.");
      return;
    }

    state.page = "walk";
    render();
    await startSession();
  });

  document.querySelector("#record-step")?.addEventListener("click", () => {
    recordDetectedStep("manual");
  });

  document.querySelector("#end-session")?.addEventListener("click", () => {
    endSession();
  });

  document.querySelector("#save-reflection")?.addEventListener("click", () => {
    state.reflectionActivity = document.querySelector("#reflection-activity").value.trim();
    state.reflectionDifficulty = document.querySelector("#reflection-difficulty").value;
    state.reflectionNotes = document.querySelector("#reflection-notes").value.trim();

    state.page = "results";
    render();
  });

  document.querySelector("#skip-reflection")?.addEventListener("click", () => {
    state.reflectionActivity = "";
    state.reflectionDifficulty = "";
    state.reflectionNotes = "";

    state.page = "results";
    render();
  });

  document.querySelector("#download-csv")?.addEventListener("click", () => {
    downloadCsv();
  });

  document.querySelector("#download-gpx")?.addEventListener("click", () => {
    downloadGpx();
  });

  document.querySelector("#download-geojson")?.addEventListener("click", () => {
    downloadGeoJson();
  });

  document.querySelector("#download-map")?.addEventListener("click", async () => {
    await downloadMapJpeg();
  });

  document.querySelector("#download-all")?.addEventListener("click", async () => {
    await downloadAllFiles();
  });

  document.querySelector("#share-email")?.addEventListener("click", () => {
    prepareEmail();
  });

  document.querySelector("#restart")?.addEventListener("click", () => {
    resetApp();
    render();
  });

  document.querySelectorAll("#back").forEach((button) => {
    button.addEventListener("click", () => {
      if (state.page === "consent") state.page = "welcome";
      else if (state.page === "setup") state.page = "consent";
      else if (state.page === "calibration") state.page = "setup";
      render();
    });
  });
}

render();
