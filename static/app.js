const form = document.querySelector("#trip-form");
const alertBox = document.querySelector("#alert");
const routeList = document.querySelector("#route-list");
const routeHint = document.querySelector("#route-hint");
const datalist = document.querySelector("#location-options");
const svg = document.querySelector("#city-map");
const mapFrame = document.querySelector(".map-frame");
const mapViewport = document.querySelector("#map-viewport");
const weatherRisksGroup = document.querySelector("#weather-risks");
const pathwaysGroup = document.querySelector("#pathways");
const obstructionsGroup = document.querySelector("#map-obstructions");
const selectedRouteGroup = document.querySelector("#selected-route");
const locationsGroup = document.querySelector("#map-locations");
const movingMarkerGroup = document.querySelector("#simulation-marker");
const timeKind = document.querySelector("#time-kind");
const timeLabel = document.querySelector("#time-label");
const submitButton = form.querySelector('button[type="submit"]');
const startSimulationButton = document.querySelector("#start-simulation");
const playPauseButton = document.querySelector("#play-pause");
const resetButton = document.querySelector("#reset-simulation");
const speedSelect = document.querySelector("#simulation-speed");
const clockReadout = document.querySelector("#simulation-clock");
const etaReadout = document.querySelector("#simulation-eta");
const randomIncidentButton = document.querySelector("#random-incident");
const incidentPathwaySelect = document.querySelector("#incident-pathway");
const blockageButton = document.querySelector("#trigger-blockage");
const delayButton = document.querySelector("#trigger-delay");
const cyclePathwayButton = document.querySelector("#cycle-pathway-state");
const edgeStateLive = document.querySelector("#edge-state-live");
const weatherForecastReadout = document.querySelector("#weather-forecast");
const weatherOverrideSelect = document.querySelector("#weather-override");
const scheduleContent = document.querySelector("#schedule-content");

let cityGraph;
let selectedRoute = null;
let journey = null;
let simulationTime = 0;
let lastFrameTime = null;
let animationFrame = null;
let isPlaying = false;
let pendingTransitionUntil = null;
const edgeStates = new Map();
const pathwayByKey = new Map();
const pathwayElements = new Map();
const failedObstructionSyncs = new Map();
let obstructionSync = Promise.resolve();
let routeRefreshTimer = null;
let routeRefreshGeneration = 0;
let routeRefreshInFlight = false;
let routeRefreshPending = false;
let mapScale = 1;
let mapTranslateX = 0;
let mapTranslateY = 0;
let mapPointer = null;
let suppressMapClick = false;
let activeExplanation = null;
let weatherRequestGeneration = 0;
submitButton.disabled = true;
startSimulationButton.disabled = true;

// Convert the backend's city coordinates into the SVG viewBox.
function mapPoint(location) {
  return { x: 45 + location.x * 9.1, y: 805 - location.y * 7.5 };
}

// Convert a partial-edge position returned by the rerouting API to SVG space.
function mapCoordinate(x, y) {
  return { x: 45 + x * 9.1, y: 805 - y * 7.5 };
}

// Offset parallel pathway types so roads, pavements, and rail remain distinguishable.
function pathwayPoints(start, end, pathway) {
  const offset = pathway === "pavement" ? 7 : pathway === "train" ? -7 : 0;
  const length = Math.hypot(end.x - start.x, end.y - start.y) || 1;
  const perpendicularX = -(end.y - start.y) / length;
  const perpendicularY = (end.x - start.x) / length;
  return {
    start: {
      x: start.x + perpendicularX * offset,
      y: start.y + perpendicularY * offset,
    },
    end: {
      x: end.x + perpendicularX * offset,
      y: end.y + perpendicularY * offset,
    },
  };
}

// Create a namespaced SVG element and apply its attributes.
function svgElement(name, attributes = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

// Canonicalize an undirected edge for state and selection maps.
function pathwayKey(start, end, pathway) {
  return [start, end].sort().concat(pathway).join("|");
}

// Transform the complete map together, and convert screen positions back to SVG
// coordinates so zoom anchors and drag offsets remain accurate at every scale.
function svgPointFromClient(clientX, clientY) {
  const point = svg.createSVGPoint();
  point.x = clientX;
  point.y = clientY;
  return point.matrixTransform(svg.getScreenCTM().inverse());
}

function applyMapViewport() {
  if (mapScale === 1) {
    mapTranslateX = 0;
    mapTranslateY = 0;
    mapViewport.removeAttribute("transform");
    mapFrame.classList.remove("is-zoomed");
    return;
  }
  mapViewport.setAttribute(
    "transform",
    `translate(${mapTranslateX} ${mapTranslateY}) scale(${mapScale})`,
  );
  mapFrame.classList.add("is-zoomed");
}

function zoomMap(factor, anchor = { x: 500, y: 425 }) {
  const nextScale = Math.min(5, Math.max(1, mapScale * factor));
  if (nextScale === mapScale) return;
  const scaleRatio = nextScale / mapScale;
  mapTranslateX = anchor.x - (anchor.x - mapTranslateX) * scaleRatio;
  mapTranslateY = anchor.y - (anchor.y - mapTranslateY) * scaleRatio;
  mapScale = nextScale;
  applyMapViewport();
}

function resetMapViewport() {
  mapScale = 1;
  mapTranslateX = 0;
  mapTranslateY = 0;
  applyMapViewport();
}

mapFrame.addEventListener("wheel", (event) => {
  if (!svg.contains(event.target)) return;
  event.preventDefault();
  zoomMap(event.deltaY < 0 ? 1.15 : 1 / 1.15, svgPointFromClient(event.clientX, event.clientY));
}, { passive: false });

mapFrame.addEventListener("keydown", (event) => {
  if (event.target.closest("button")) return;
  if (event.key === "+" || event.key === "-") {
    event.preventDefault();
    zoomMap(event.key === "+" ? 1.2 : 1 / 1.2);
  } else if (event.key === "=") {
    event.preventDefault();
    resetMapViewport();
  }
});

mapFrame.addEventListener("pointerdown", (event) => {
  if (!svg.contains(event.target) || !event.isPrimary || event.button !== 0) return;
  mapPointer = {
    pointerId: event.pointerId,
    clientX: event.clientX,
    clientY: event.clientY,
    startPoint: svgPointFromClient(event.clientX, event.clientY),
    startTranslateX: mapTranslateX,
    startTranslateY: mapTranslateY,
    dragging: false,
  };
});

window.addEventListener("pointermove", (event) => {
  if (!mapPointer || event.pointerId !== mapPointer.pointerId) return;
  const distance = Math.hypot(
    event.clientX - mapPointer.clientX,
    event.clientY - mapPointer.clientY,
  );
  if (!mapPointer.dragging && distance > 5) {
    mapPointer.dragging = true;
    suppressMapClick = true;
  }
  if (!mapPointer.dragging || mapScale === 1) return;
  event.preventDefault();
  const point = svgPointFromClient(event.clientX, event.clientY);
  mapTranslateX = mapPointer.startTranslateX
    + (point.x - mapPointer.startPoint.x) / mapScale;
  mapTranslateY = mapPointer.startTranslateY
    + (point.y - mapPointer.startPoint.y) / mapScale;
  applyMapViewport();
});

window.addEventListener("pointerup", (event) => {
  if (!mapPointer || event.pointerId !== mapPointer.pointerId) return;
  mapPointer = null;
  if (suppressMapClick) window.setTimeout(() => { suppressMapClick = false; }, 0);
});

svg.addEventListener("click", (event) => {
  if (!suppressMapClick) return;
  event.preventDefault();
  event.stopPropagation();
  suppressMapClick = false;
}, true);

document.querySelector("#map-zoom-in").addEventListener("click", () => zoomMap(1.25));
document.querySelector("#map-zoom-out").addEventListener("click", () => zoomMap(1 / 1.25));
document.querySelector("#map-reset-view").addEventListener("click", resetMapViewport);

// Populate the map, location picker, and editable pathway state from the city API.
function renderCity(graph) {
  cityGraph = graph;
  edgeStates.clear();
  graph.manual_obstructions.forEach((item) => {
    if (item.kind !== "normal") {
      edgeStates.set(pathwayKey(item.start, item.end, item.pathway), item.kind);
    }
  });
  const locationByName = new Map(graph.locations.map((location) => [location.name, location]));
  const options = graph.locations.map((location) => {
    const option = document.createElement("option");
    option.value = location.name;
    return option;
  });
  datalist.replaceChildren(...options);

  const lines = graph.pathways.map((pathway) => {
    const points = pathwayPoints(
      mapPoint(locationByName.get(pathway.start)),
      mapPoint(locationByName.get(pathway.end)),
      pathway.pathway,
    );
    const key = pathwayKey(pathway.start, pathway.end, pathway.pathway);
    const group = svgElement("g", { "data-edge-key": key });
    const line = svgElement("line", {
      x1: points.start.x, y1: points.start.y,
      x2: points.end.x, y2: points.end.y,
      class: `pathway pathway-${pathway.pathway} pathway-state`,
    });
    const title = svgElement("title");
    title.textContent = `${pathway.name}: ${pathway.start} to ${pathway.end}`;
    line.append(title);
    const hitArea = svgElement("line", {
      x1: points.start.x, y1: points.start.y,
      x2: points.end.x, y2: points.end.y,
      class: "pathway-hit-area",
      "data-edge-key": key,
      role: "button",
      tabindex: "0",
    });
    pathwayByKey.set(key, pathway);
    pathwayElements.set(key, { line, hitArea });
    group.append(line, hitArea);
    return group;
  });
  pathwaysGroup.replaceChildren(...lines);

  const nodes = graph.locations.flatMap((location) => {
    const point = mapPoint(location);
    const marker = svgElement(location.is_station ? "rect" : "circle", location.is_station
      ? { x: point.x - 5, y: point.y - 5, width: 10, height: 10, class: "map-node station" }
      : { cx: point.x, cy: point.y, r: 5, class: "map-node" });
    const label = svgElement("text", {
      x: point.x + 8, y: point.y - 7, class: "map-node-label",
    });
    label.textContent = location.name;
    return [marker, label];
  });
  locationsGroup.replaceChildren(...nodes);

  const incidentOptions = graph.pathways.map((pathway) => {
    const option = document.createElement("option");
    option.value = pathwayKey(pathway.start, pathway.end, pathway.pathway);
    return option;
  });
  incidentPathwaySelect.replaceChildren(...incidentOptions);
  graph.pathways.forEach((pathway) => updateEdgeStateView(
    pathwayKey(pathway.start, pathway.end, pathway.pathway),
  ));
  refreshObstructionIcons();
}

// Forecast and risk-map updates use one response so the visible conditions and
// the prediction halos always describe the same simulated weather state.
async function refreshWeatherForecast() {
  if (!cityGraph || !form.elements.time.value) return;
  const generation = ++weatherRequestGeneration;
  const params = new URLSearchParams({
    time: form.elements.time.value,
    weather_override: weatherOverrideSelect.value,
  });
  try {
    const response = await fetch(`/api/weather?${params}`);
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.detail || "The weather forecast could not be loaded.");
    }
    if (generation !== weatherRequestGeneration) return;
    const highRiskCount = result.risk_edges.filter((item) => item.level === "high").length;
    const moderateRiskCount = result.risk_edges.length - highRiskCount;
    weatherForecastReadout.textContent = `${result.label} — ${result.description} `
      + `Predicted risk: ${highRiskCount} high, ${moderateRiskCount} moderate pathway(s).`;
    const lines = result.risk_edges.map((risk) => {
      const pathway = pathwayByKey.get(pathwayKey(risk.start, risk.end, risk.pathway));
      if (!pathway) return null;
      const start = mapPoint(cityGraph.locations.find((item) => item.name === risk.start));
      const end = mapPoint(cityGraph.locations.find((item) => item.name === risk.end));
      const points = pathwayPoints(start, end, risk.pathway);
      const halo = svgElement("line", {
        x1: points.start.x,
        y1: points.start.y,
        x2: points.end.x,
        y2: points.end.y,
        class: `weather-risk-halo ${risk.level}`,
        "aria-label": `Predicted ${risk.level} weather risk: ${risk.reason}`,
      });
      const title = svgElement("title");
      title.textContent = `Predicted ${risk.level} risk — ${risk.name}: ${risk.reason}`;
      halo.append(title);
      return halo;
    }).filter(Boolean);
    // This group is the first visual group in the map viewport, below every network layer.
    weatherRisksGroup.replaceChildren(...lines);
  } catch (error) {
    if (generation !== weatherRequestGeneration) return;
    weatherForecastReadout.textContent = "The simulated forecast is unavailable.";
    showError(error instanceof Error ? error.message : "The weather forecast could not be loaded.");
  }
}

// Convert the internal state value into wording used by controls and announcements.
function stateLabel(kind) {
  return ({ delay: "Delay", block: "Blocked" })[kind] || "Normal";
}

// Keep the visible edge style, accessible name, picker label, and announcement aligned.
function updateEdgeStateView(key, announce = false) {
  const pathway = pathwayByKey.get(key);
  const elements = pathwayElements.get(key);
  if (!pathway || !elements) return;
  const kind = edgeStates.get(key) || "normal";
  elements.line.classList.toggle("pathway-delayed", kind === "delay");
  elements.line.classList.toggle("pathway-blocked", kind === "block");
  const label = `${pathway.name}: ${pathway.start} to ${pathway.end} (${pathway.pathway}), ${stateLabel(kind)}`;
  elements.hitArea.setAttribute("aria-label", label);
  const option = [...incidentPathwaySelect.options].find((item) => item.value === key);
  if (option) {
    option.textContent = `${pathway.name} — ${pathway.start} to ${pathway.end} (${pathway.pathway}) — ${stateLabel(kind)}`;
  }
  // Keep the keyboard pathway option and its live announcement synchronized
  // with the same state and visual class used by map-edge clicks.
  if (announce && incidentPathwaySelect.value === key) {
    edgeStateLive.textContent = `${pathway.name}, ${pathway.start} to ${pathway.end}: ${stateLabel(kind)}.`;
  }
}

// Serialize state changes so the server applies rapid toggles in their original order.
function queueObstructionSync(pathway, kind) {
  const key = pathwayKey(pathway.start, pathway.end, pathway.pathway);
  const request = obstructionSync.then(async () => {
    const response = await fetch("/api/obstructions", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        start: pathway.start,
        end: pathway.end,
        pathway: pathway.pathway,
        kind,
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(Array.isArray(result.detail)
        ? result.detail.map((item) => item.msg).join(" ")
        : result.detail || "The pathway state could not be synchronized.");
    }
    failedObstructionSyncs.delete(key);
  });
  obstructionSync = request.catch((error) => {
    failedObstructionSyncs.set(key, error);
    showError(error instanceof Error ? error.message : "The pathway state could not be synchronized.");
  });
  return obstructionSync;
}

// Apply a pathway change locally, synchronize it, then update the route or active journey.
async function setEdgeState(key, kind, reroute = true) {
  const pathway = pathwayByKey.get(key);
  if (!pathway) return;
  if (kind === "normal") edgeStates.delete(key);
  else edgeStates.set(key, kind);
  updateEdgeStateView(key, true);
  refreshObstructionIcons(journey ? journey.route : null);
  const sync = queueObstructionSync(pathway, kind);
  if (reroute && journey) await triggerIncident(kind, false, pathway, sync);
  else if (reroute) scheduleAutomaticRouteRefresh();
}

// Cycle an edge through its three supported states.
function cycleEdgeState(key) {
  const current = edgeStates.get(key) || "normal";
  const next = ({ normal: "delay", delay: "block", block: "normal" })[current];
  setEdgeState(key, next);
}

// Produce SVG lines for the timed legs of a route, including partial edges.
function makeRouteLines(route) {
  const locationByName = new Map(cityGraph.locations.map((location) => [location.name, location]));
  return route.legs.map((leg) => {
    const start = leg.start_x === undefined
      ? mapPoint(locationByName.get(leg.start))
      : mapCoordinate(leg.start_x, leg.start_y);
    const end = leg.end_x === undefined
      ? mapPoint(locationByName.get(leg.end))
      : mapCoordinate(leg.end_x, leg.end_y);
    return svgElement("line", {
      x1: start.x, y1: start.y, x2: end.x, y2: end.y, class: "route-segment",
    });
  });
}

// Draw a route and its endpoints, and synchronize the selected route card.
function highlightRoute(route) {
  const locationByName = new Map(cityGraph.locations.map((location) => [location.name, location]));
  const markers = [route.locations[0], route.locations[route.locations.length - 1]]
    .filter((name, index, names) => name && names.indexOf(name) === index)
    .map((name) => {
      const location = locationByName.get(name);
      if (!location) return null;
      const point = mapPoint(location);
      const marker = svgElement("circle", {
        cx: point.x, cy: point.y, r: 9, class: "map-marker",
      });
      const title = svgElement("title");
      title.textContent = name;
      marker.append(title);
      return marker;
    }).filter(Boolean);
  selectedRouteGroup.replaceChildren(...makeRouteLines(route), ...markers);
  routeList.querySelectorAll(".route-card").forEach((card) => {
    const isSelected = Number(card.dataset.routeId) === route.id;
    card.classList.toggle("is-selected", isSelected);
    card.querySelector(".route-select").setAttribute("aria-pressed", String(isSelected));
  });
  svg.setAttribute("aria-label", `City map with selected route: ${route.locations.join(" to ")}`);
}

// Format an API timestamp for the route cards and readouts.
function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium", timeStyle: "short",
  }).format(new Date(value));
}

// Calculate the remaining whole minutes from the simulator's current clock.
function routeDuration(route) {
  return Math.max(0, Math.ceil(
    (new Date(route.arrival).getTime() - simulationTime) / 60000,
  ));
}

function closeRouteExplanation(restoreFocus = false) {
  if (!activeExplanation) return;
  const { trigger, tooltip } = activeExplanation;
  trigger.setAttribute("aria-expanded", "false");
  tooltip.hidden = true;
  activeExplanation = null;
  if (restoreFocus) trigger.focus();
}

function openRouteExplanation(trigger, tooltip) {
  if (activeExplanation && activeExplanation.trigger === trigger) {
    closeRouteExplanation(true);
    return;
  }
  closeRouteExplanation();
  trigger.setAttribute("aria-expanded", "true");
  tooltip.hidden = false;
  activeExplanation = { trigger, tooltip };
  tooltip.querySelector(".route-explanation-close").focus();
}

document.addEventListener("click", (event) => {
  if (!activeExplanation) return;
  if (activeExplanation.tooltip.contains(event.target)
    || activeExplanation.trigger.contains(event.target)) return;
  closeRouteExplanation();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && activeExplanation) {
    event.preventDefault();
    closeRouteExplanation(true);
  }
});

// Rebuild route cards and keep the prior route index when it is still available.
function showRoutes(routes, preferredRouteId = null) {
  closeRouteExplanation();
  routeList.replaceChildren();
  routes.forEach((route) => {
    const card = document.createElement("article");
    card.className = "route-card";
    card.dataset.routeId = String(route.id);
    const selectButton = document.createElement("button");
    selectButton.type = "button";
    selectButton.className = "route-select";
    selectButton.dataset.routeId = String(route.id);
    selectButton.setAttribute("aria-pressed", "false");
    selectButton.setAttribute("aria-label",
      `Route ${route.id}: ${route.summary}, ${route.duration_minutes} minutes`);

    const title = document.createElement("strong");
    title.textContent = `Option ${route.id} · ${route.duration_minutes} min`;
    const summary = document.createElement("span");
    summary.textContent = `Via ${route.summary} · ${route.distance_km.toFixed(1)} km`;
    const times = document.createElement("span");
    times.textContent = `${formatTime(route.departure)} – ${formatTime(route.arrival)}`;
    selectButton.append(title, summary, times);
    selectButton.addEventListener("click", () => selectRoute(route));

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "route-explanation-trigger";
    trigger.textContent = "?";
    trigger.setAttribute("aria-label", "Explain why this route was chosen");
    trigger.setAttribute("aria-expanded", "false");
    trigger.title = "Explain why this route was chosen";

    const tooltip = document.createElement("div");
    tooltip.id = `route-explanation-${route.id}`;
    tooltip.className = "route-explanation";
    tooltip.setAttribute("role", "dialog");
    tooltip.setAttribute("aria-label", "Why this route?");
    tooltip.hidden = true;
    trigger.setAttribute("aria-controls", tooltip.id);
    const explanationTitle = document.createElement("h3");
    explanationTitle.textContent = "Why this route?";
    const explanation = document.createElement("p");
    explanation.textContent = route.explanation;
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "route-explanation-close";
    closeButton.textContent = "×";
    closeButton.setAttribute("aria-label", "Close route explanation");
    closeButton.title = "Close route explanation";
    closeButton.addEventListener("click", () => closeRouteExplanation(true));
    tooltip.append(explanationTitle, explanation, closeButton);
    trigger.addEventListener("click", () => openRouteExplanation(trigger, tooltip));
    card.append(selectButton, trigger, tooltip);
    routeList.append(card);
  });
  routeHint.textContent = `${routes.length} route option${routes.length === 1 ? "" : "s"} found.`;
  selectRoute(routes.find((route) => route.id === preferredRouteId) || routes[0]);
}

// Find scheduled disruptions that apply at departure or while traversing a leg.
function activeScheduledObstructions(route) {
  const tripMode = form.elements.mode.value;
  const tripDate = new Date(route.departure);
  // Scheduled warnings use the trip's local weekday and departure time, matching
  // the API's half-open window; route legs are also checked at their expected
  // traversal time so warnings remain visible when a trip reaches one later.
  return cityGraph.obstructions.filter((item) => {
    if (!item.modes.includes(tripMode)) return false;
    const matchesAt = (value) => {
      const date = new Date(value);
      const weekday = (date.getDay() + 6) % 7;
      const minute = date.getHours() * 60 + date.getMinutes();
      const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      return (!item.starts_on || dateKey >= item.starts_on)
        && (!item.ends_on || dateKey <= item.ends_on)
        && (!item.weekdays.length || item.weekdays.includes(weekday))
        && item.start_minute <= minute && minute < item.end_minute;
    };
    return matchesAt(tripDate)
      || route.legs.some((leg) =>
        pathwayKey(leg.start, leg.end, leg.pathway)
          === pathwayKey(item.start, item.end, item.pathway)
        && matchesAt(leg.departure),
      );
  });
}

// Create a labeled warning symbol at the midpoint of an obstructed pathway.
function drawObstruction(obstruction, injected = false) {
  const start = cityGraph.locations.find((item) => item.name === obstruction.start);
  const end = cityGraph.locations.find((item) => item.name === obstruction.end);
  if (!start || !end) return null;
  const first = mapPoint(start);
  const second = mapPoint(end);
  const x = (first.x + second.x) / 2;
  const y = (first.y + second.y) / 2;
  const marker = svgElement("g", {
    "aria-label": obstruction.reason,
    class: obstruction.blocked ? "obstruction-blocked" : "obstruction-delayed",
  });
  marker.append(svgElement("circle", {
    cx: x, cy: y, r: 11,
    class: `obstruction-marker${injected ? " obstruction-injected" : ""}${obstruction.blocked ? " obstruction-blocked" : ""}`,
  }));
  const label = svgElement("text", {
    x, y: y + 5,
    class: `obstruction-label${obstruction.blocked ? " obstruction-blocked" : ""}`,
  });
  label.textContent = injected && obstruction.blocked ? "×" : "!";
  const title = svgElement("title");
  title.textContent = `${obstruction.reason}: ${obstruction.start} to ${obstruction.end}`;
  marker.append(label, title);
  return marker;
}

// Redraw applicable scheduled notices and all manually selected pathway notices.
function refreshObstructionIcons(route = null) {
  const markers = route
    ? activeScheduledObstructions(route).map((item) => drawObstruction(item))
    : [];
  edgeStates.forEach((kind, key) => {
    const pathway = pathwayByKey.get(key);
    if (!pathway) return;
    const marker = drawObstruction({
      ...pathway,
      blocked: kind === "block",
      reason: kind === "block" ? "Manual blockage" : "Manual delay",
    }, true);
    if (marker) markers.push(marker);
  });
  obstructionsGroup.replaceChildren(...markers);
}

// Set the selected route and reset playback to the route's initial state.
function selectRoute(route) {
  resetSimulation();
  selectedRoute = route;
  highlightRoute(route);
  refreshObstructionIcons(route);
  clockReadout.textContent = "Not started";
  etaReadout.textContent = formatTime(route.arrival);
  startSimulationButton.disabled = false;
  setTestingControls(false);
}

// Present an error in the shared polite live region.
function showError(message) {
  alertBox.textContent = message;
  alertBox.hidden = false;
}

// Serialize a JavaScript timestamp as local wall-clock time for datetime-local inputs.
function localDateTime(milliseconds) {
  const date = new Date(milliseconds - new Date(milliseconds).getTimezoneOffset() * 60000);
  return date.toISOString().slice(0, 19);
}

// Enable incident controls only while journey playback can accept a new event.
function setTestingControls(enabled) {
  const canInject = enabled && pendingTransitionUntil === null;
  randomIncidentButton.disabled = !canInject;
  blockageButton.disabled = !canInject;
  delayButton.disabled = !canInject;
  // Keep the pathway selector and cycle button available at all times so
  // keyboard and screen-reader users can configure states before a route.
  incidentPathwaySelect.disabled = !cityGraph;
  cyclePathwayButton.disabled = !cityGraph;
}

// Stop playback and clear transient journey state without discarding the route.
function resetSimulation() {
  if (animationFrame !== null) cancelAnimationFrame(animationFrame);
  animationFrame = null;
  isPlaying = false;
  lastFrameTime = null;
  journey = null;
  pendingTransitionUntil = null;
  movingMarkerGroup.replaceChildren();
  playPauseButton.textContent = "Play";
  playPauseButton.disabled = true;
  resetButton.disabled = true;
  startSimulationButton.disabled = !selectedRoute;
  setTestingControls(false);
}

// Create the SVG marker that moves along the active journey.
function createJourneyMarker() {
  const marker = svgElement("g", { "aria-label": "Current journey position" });
  marker.append(
    svgElement("circle", { r: 12, class: "journey-marker" }),
    svgElement("circle", { r: 4, class: "journey-marker-core" }),
  );
  movingMarkerGroup.replaceChildren(marker);
  return marker;
}

// Find the map position corresponding to a timestamp along the route.
function positionOnJourney(route, atTime) {
  const locationByName = new Map(cityGraph.locations.map((location) => [location.name, location]));
  if (!route.legs.length) {
    const location = locationByName.get(route.locations[0]);
    return location ? mapPoint(location) : null;
  }
  const firstLeg = route.legs[0];
  let lastPoint = firstLeg.start_x === undefined
    ? mapPoint(locationByName.get(firstLeg.start))
    : mapCoordinate(firstLeg.start_x, firstLeg.start_y);
  for (const leg of route.legs) {
    const start = leg.start_x === undefined
      ? mapPoint(locationByName.get(leg.start))
      : mapCoordinate(leg.start_x, leg.start_y);
    const end = leg.end_x === undefined
      ? mapPoint(locationByName.get(leg.end))
      : mapCoordinate(leg.end_x, leg.end_y);
    lastPoint = end;
    const departure = new Date(leg.departure).getTime();
    const arrival = new Date(leg.arrival).getTime();
    if (atTime < departure) return start;
    if (atTime <= arrival && arrival > departure) {
      const progress = Math.max(0, Math.min(1, (atTime - departure) / (arrival - departure)));
      return {
        x: start.x + (end.x - start.x) * progress,
        y: start.y + (end.y - start.y) * progress,
        legIndex: route.legs.indexOf(leg),
        progress,
      };
    }
  }
  return lastPoint;
}

// Refresh the simulated clock and estimated arrival text.
function updateReadouts() {
  clockReadout.textContent = formatTime(simulationTime);
  const remaining = routeDuration(journey.route);
  etaReadout.textContent = remaining <= 0
    ? `Arrived · ${formatTime(journey.route.arrival)}`
    : `${formatTime(journey.route.arrival)} · ${remaining} min remaining`;
}

// Advance the journey clock and position marker by one animation frame.
function updateSimulationFrame(frameTime) {
  if (!isPlaying || !journey) return;
  if (lastFrameTime !== null) {
    // Each real animation-frame interval advances the journey clock by the
    // selected multiplier; leg timestamps then determine waits and movement.
    simulationTime += (frameTime - lastFrameTime) * Number(speedSelect.value);
  }
  lastFrameTime = frameTime;
  if (pendingTransitionUntil !== null && simulationTime >= pendingTransitionUntil) {
    pendingTransitionUntil = null;
    setTestingControls(isPlaying);
  }
  const point = positionOnJourney(journey.route, simulationTime);
  if (point) {
    if (!movingMarkerGroup.firstChild) createJourneyMarker();
    movingMarkerGroup.firstChild.setAttribute("transform", `translate(${point.x} ${point.y})`);
  }
  updateReadouts();
  if (simulationTime >= new Date(journey.route.arrival).getTime()) {
    simulationTime = new Date(journey.route.arrival).getTime();
    isPlaying = false;
    playPauseButton.textContent = "Play";
    setTestingControls(false);
    updateReadouts();
    return;
  }
  animationFrame = requestAnimationFrame(updateSimulationFrame);
}

// Start playback from the selected route's requested departure.
function startSimulation() {
  resetSimulation();
  refreshObstructionIcons(selectedRoute);
  journey = { route: selectedRoute };
  simulationTime = new Date(selectedRoute.departure).getTime();
  createJourneyMarker();
  isPlaying = true;
  playPauseButton.disabled = false;
  resetButton.disabled = false;
  speedSelect.disabled = false;
  startSimulationButton.disabled = true;
  playPauseButton.textContent = "Pause";
  setTestingControls(isPlaying);
  updateSimulationFrame(performance.now());
}

// Pause or resume playback without changing the simulated journey time.
function togglePlayback() {
  if (!journey) return;
  isPlaying = !isPlaying;
  lastFrameTime = null;
  playPauseButton.textContent = isPlaying ? "Pause" : "Play";
  setTestingControls(isPlaying);
  if (isPlaying) animationFrame = requestAnimationFrame(updateSimulationFrame);
}

// Return the current leg and progress for incident placement.
function activeJourneyLeg() {
  if (!journey) return null;
  const legs = journey.route.legs;
  for (let index = 0; index < legs.length; index += 1) {
    const departure = new Date(legs[index].departure).getTime();
    const arrival = new Date(legs[index].arrival).getTime();
    if (simulationTime <= arrival) {
      const progress = arrival > departure
        ? Math.max(0, Math.min(1, (simulationTime - departure) / (arrival - departure)))
        : 0;
      return { leg: legs[index], index, progress };
    }
  }
  return null;
}

// Select an unobstructed pathway on the remaining journey for a random incident.
function findIncidentPathway(selection, randomAhead) {
  if (randomAhead) {
    const current = activeJourneyLeg();
    const startIndex = current ? current.index : 0;
    const ahead = journey.route.legs.slice(startIndex).filter((leg) =>
      pathwayByKey.has(pathwayKey(leg.start, leg.end, leg.pathway))
      && !edgeStates.has(pathwayKey(leg.start, leg.end, leg.pathway)),
    );
    if (!ahead.length) return null;
    const leg = ahead[Math.floor(Math.random() * ahead.length)];
    return pathwayByKey.get(pathwayKey(leg.start, leg.end, leg.pathway));
  }
  return pathwayByKey.get(selection);
}

// Request and apply a mid-journey reroute around the selected incident.
async function triggerIncident(kind, randomAhead = false, chosenPathway = null, sync = Promise.resolve()) {
  if (!journey || pendingTransitionUntil !== null) return;
  await sync;
  if (failedObstructionSyncs.size) return;
  const wasPlaying = isPlaying;
  const incidentTime = simulationTime;
  const active = activeJourneyLeg();
  const pathway = chosenPathway
    || findIncidentPathway(incidentPathwaySelect.value, randomAhead);
  if (!active || !pathway) {
    showError("There is no pathway ahead available for a new incident.");
    return;
  }
  [randomIncidentButton, blockageButton, delayButton].forEach((button) => {
    button.disabled = true;
  });
  isPlaying = false;
  lastFrameTime = null;
  playPauseButton.disabled = true;
  playPauseButton.textContent = "Play";
  const data = new FormData(form);
  const payload = {
    destination: journey.route.locations[journey.route.locations.length - 1],
    time: localDateTime(incidentTime),
    mode: data.get("mode"),
    current_edge_start: active.leg.start,
    current_edge_end: active.leg.end,
    current_edge_pathway: active.leg.pathway,
    progress: active.progress,
    incident: { start: pathway.start, end: pathway.end, pathway: pathway.pathway, kind },
    additional_incidents: [...edgeStates.entries()]
      .filter(([key]) => key !== pathwayKey(pathway.start, pathway.end, pathway.pathway))
      .map(([key, state]) => {
        const item = pathwayByKey.get(key);
        return {
          start: item.start,
          end: item.end,
          pathway: item.pathway,
          kind: state,
        };
      }),
    avoid_tolls: data.has("avoid_tolls"),
    avoid_highways: data.has("avoid_highways"),
    priority: data.get("priority"),
    weather_override: weatherOverrideSelect.value,
    consider_weather: data.get("consider_weather") === "yes",
  };
  try {
    const response = await fetch("/api/reroute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(Array.isArray(result.detail)
        ? result.detail.map((item) => item.msg).join(" ")
        : result.detail || "The journey could not be rerouted.");
    }
    // The API returns a partial-edge approach for walkers, but a next-node
    // transition for transit and driving; its reaction interval is spent at that node.
    const approachStart = incidentTime;
    const approachEnd = approachStart + result.approach_minutes * 60000;
    const switchTime = approachEnd + result.reaction_minutes * 60000;
    const approach = {
      start: "Current position",
      end: result.switch_node,
      start_x: result.approach_start_x,
      start_y: result.approach_start_y,
      end_x: result.approach_end_x,
      end_y: result.approach_end_y,
      departure: localDateTime(approachStart),
      arrival: localDateTime(approachEnd),
    };
    const rerouted = {
      ...result.route,
      legs: [approach, ...result.route.legs],
      locations: [result.switch_node, ...result.route.locations.slice(1)],
    };
    journey = { route: rerouted };
    simulationTime = approachStart;
    isPlaying = wasPlaying;
    pendingTransitionUntil = switchTime > simulationTime ? switchTime : null;
    playPauseButton.disabled = false;
    playPauseButton.textContent = isPlaying ? "Pause" : "Play";
    highlightRoute(rerouted);
    refreshObstructionIcons(rerouted);
    // Backend suffix timestamps include the approach and driver reaction delay,
    // so the marker pauses at a node before the new path begins when required.
    etaReadout.textContent = `${formatTime(result.route.arrival)} · new ETA`;
    alertBox.textContent = `${result.reason}. Route updated via ${result.route.summary}; estimated arrival ${formatTime(result.route.arrival)}.`;
    alertBox.hidden = false;
    if (switchTime > new Date(result.route.arrival).getTime()) {
      throw new Error("The new route arrival time is earlier than its transition.");
    }
    setTestingControls(isPlaying);
    if (isPlaying) {
      animationFrame = requestAnimationFrame(updateSimulationFrame);
    } else {
      const point = positionOnJourney(journey.route, simulationTime);
      if (point) {
        if (!movingMarkerGroup.firstChild) createJourneyMarker();
        movingMarkerGroup.firstChild.setAttribute("transform", `translate(${point.x} ${point.y})`);
      }
      updateReadouts();
    }
  } catch (error) {
    showError(error instanceof Error ? error.message : "The journey could not be rerouted.");
    isPlaying = wasPlaying;
    pendingTransitionUntil = null;
    playPauseButton.disabled = false;
    playPauseButton.textContent = isPlaying ? "Pause" : "Play";
    setTestingControls(isPlaying);
    if (isPlaying) animationFrame = requestAnimationFrame(updateSimulationFrame);
  }
}

// Resolve valid form selections without prompting or triggering browser validation UI.
function hasValidRouteSelections() {
  if (!cityGraph) return false;
  const names = new Set(cityGraph.locations.map((location) => location.name.toLowerCase()));
  const start = form.elements.start.value.trim().toLowerCase();
  const destination = form.elements.destination.value.trim().toLowerCase();
  return names.has(start) && names.has(destination) && form.elements.time.validity.valid;
}

// Build the same route request body for manual searches and automatic refreshes.
function routeRequestPayload() {
  const data = new FormData(form);
  return {
    start: data.get("start"),
    destination: data.get("destination"),
    time_kind: data.get("time_kind"),
    time: data.get("time"),
    mode: data.get("mode"),
    priority: data.get("priority"),
    avoid_tolls: data.has("avoid_tolls"),
    avoid_highways: data.has("avoid_highways"),
    weather_override: weatherOverrideSelect.value,
    consider_weather: data.get("consider_weather") === "yes",
  };
}

// Debounce pre-simulation pathway edits and invalidate any older response.
function scheduleAutomaticRouteRefresh(delay = 250) {
  if (journey || !hasValidRouteSelections()) return;
  routeRefreshGeneration += 1;
  const generation = routeRefreshGeneration;
  if (routeRefreshTimer !== null) clearTimeout(routeRefreshTimer);
  routeRefreshTimer = setTimeout(() => {
    routeRefreshTimer = null;
    refreshRoutesAutomatically(generation);
  }, delay);
}

// Recalculate after pathway synchronization and discard stale or overlapping results.
async function refreshRoutesAutomatically(generation) {
  if (generation !== routeRefreshGeneration || journey) return;
  if (routeRefreshInFlight) {
    routeRefreshPending = true;
    return;
  }
  routeRefreshInFlight = true;
  try {
    await obstructionSync;
    if (generation !== routeRefreshGeneration || journey) return;
    if (failedObstructionSyncs.size) {
      throw new Error("Wait for pathway changes to synchronize before calculating routes.");
    }
    const response = await fetch("/api/routes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(routeRequestPayload()),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(Array.isArray(result.detail)
        ? result.detail.map((item) => item.msg).join(" ")
        : result.detail || "The route request could not be completed.");
    }
    if (generation !== routeRefreshGeneration || journey) return;
    const selectedId = selectedRoute && selectedRoute.id;
    alertBox.hidden = true;
    showRoutes(result.routes, selectedId);
  } catch (error) {
    if (generation !== routeRefreshGeneration || journey) return;
    clearRouteResults(error instanceof Error ? error.message : "The routes could not be refreshed.");
  } finally {
    routeRefreshInFlight = false;
    if (routeRefreshPending) {
      routeRefreshPending = false;
      scheduleAutomaticRouteRefresh(0);
    }
  }
}

// Remove stale route choices and announce why no current route can be shown.
function clearRouteResults(message) {
  closeRouteExplanation();
  selectedRoute = null;
  resetSimulation();
  routeList.replaceChildren();
  selectedRouteGroup.replaceChildren();
  refreshObstructionIcons();
  routeHint.textContent = "No route options to display.";
  svg.setAttribute("aria-label", "Map of city locations and roads, pavements, and train lines");
  showError(message);
}

// Build schedule tables from API records instead of duplicating service data in the page.
function appendScheduleTable(title, records, columns) {
  const section = document.createElement("section");
  section.className = "schedule-group";
  const heading = document.createElement("h3");
  heading.textContent = title;
  section.append(heading);
  const scroll = document.createElement("div");
  scroll.className = "table-scroll";
  const table = document.createElement("table");
  table.className = "schedule-table";
  table.setAttribute("aria-label", title);
  const head = document.createElement("thead");
  const headerRow = document.createElement("tr");
  columns.forEach(([key, label]) => {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    headerRow.append(cell);
  });
  head.append(headerRow);
  const body = document.createElement("tbody");
  records.forEach((record) => {
    const row = document.createElement("tr");
    columns.forEach(([key]) => {
      const cell = document.createElement("td");
      cell.textContent = String(record[key] ?? "—");
      row.append(cell);
    });
    body.append(row);
  });
  table.append(head, body);
  scroll.append(table);
  section.append(scroll);
  scheduleContent.append(section);
}

// Keep the footer reference synchronized with the backend route and disruption rules.
async function loadSchedule() {
  try {
    const response = await fetch("/api/schedule");
    const schedule = await response.json();
    if (!response.ok) {
      throw new Error(schedule.detail || "The simulation schedule could not be loaded.");
    }
    scheduleContent.replaceChildren();
    appendScheduleTable("Weekly Public Transport Timetables", schedule.weekly_public_transport, [
      ["service", "Service"],
      ["operating_hours", "Operating hours"],
      ["peak_frequency", "Peak frequency"],
      ["off_peak_frequency", "Off-peak interval"],
    ]);
    appendScheduleTable("Recurring Weekly Traffic Patterns", schedule.weekly_traffic, [
      ["period", "Pattern"],
      ["days", "Days"],
      ["window", "Time window"],
      ["impact", "Routing impact"],
    ]);
    appendScheduleTable("Annual Scheduled Construction & Outages", schedule.annual_maintenance, [
      ["service", "Service type"],
      ["pathway", "Pathway"],
      ["start", "From"],
      ["end", "To"],
      ["starts_on", "Starts"],
      ["ends_on", "Ends"],
      ["window", "Daily window"],
      ["reason", "Disruption"],
    ]);
    const note = document.createElement("p");
    note.className = "schedule-note";
    note.textContent = "The bus timetable is reference-only; the current route graph models road, walking, and train pathways.";
    scheduleContent.append(note);
  } catch (error) {
    scheduleContent.textContent = "The simulation schedule could not be loaded.";
    showError(error instanceof Error ? error.message : "The simulation schedule could not be loaded.");
  }
}

// Keep the label synchronized with the selected departure/arrival constraint.
timeKind.addEventListener("change", () => {
  timeLabel.textContent = timeKind.value === "arrival"
    ? "Arrival date and time"
    : "Departure date and time";
});
form.elements.time.addEventListener("change", () => {
  refreshWeatherForecast();
  scheduleAutomaticRouteRefresh();
});
weatherOverrideSelect.addEventListener("change", () => {
  refreshWeatherForecast();
  scheduleAutomaticRouteRefresh();
});
form.querySelectorAll('input[name="consider_weather"]').forEach((input) => {
  input.addEventListener("change", () => scheduleAutomaticRouteRefresh());
});

// Run a user-requested search, clearing the old choice before displaying results.
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (routeRefreshTimer !== null) clearTimeout(routeRefreshTimer);
  routeRefreshTimer = null;
  routeRefreshGeneration += 1;
  routeRefreshPending = false;
  alertBox.hidden = true;
  resetSimulation();
  selectedRoute = null;
  startSimulationButton.disabled = true;
  closeRouteExplanation();
  routeList.replaceChildren();
  selectedRouteGroup.replaceChildren();
  obstructionsGroup.replaceChildren();
  svg.setAttribute("aria-label", "Map of city locations and roads, pavements, and train lines");
  routeHint.textContent = "Calculating routes…";
  submitButton.disabled = true;

  try {
    await obstructionSync;
    if (failedObstructionSyncs.size) {
      throw new Error("Wait for pathway changes to synchronize before calculating routes.");
    }
    const response = await fetch("/api/routes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(routeRequestPayload()),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(Array.isArray(result.detail)
        ? result.detail.map((item) => item.msg).join(" ")
        : result.detail || "The route request could not be completed.");
    }
    showRoutes(result.routes);
  } catch (error) {
    routeHint.textContent = "No route options to display.";
    showError(error instanceof Error ? error.message : "An unexpected error occurred.");
  } finally {
    submitButton.disabled = false;
  }
});

// Wire playback controls to the journey state machine.
startSimulationButton.addEventListener("click", startSimulation);
playPauseButton.addEventListener("click", togglePlayback);
resetButton.addEventListener("click", () => {
  resetSimulation();
  alertBox.hidden = true;
  if (selectedRoute) {
    highlightRoute(selectedRoute);
    refreshObstructionIcons(selectedRoute);
    simulationTime = new Date(selectedRoute.departure).getTime();
    clockReadout.textContent = "Not started";
    etaReadout.textContent = formatTime(selectedRoute.arrival);
  }
});
// Buttons and the selector provide keyboard-accessible alternatives to map clicks.
blockageButton.addEventListener("click", () => {
  const key = incidentPathwaySelect.value;
  setEdgeState(key, "block");
});
delayButton.addEventListener("click", () => {
  const key = incidentPathwaySelect.value;
  setEdgeState(key, "delay");
});
cyclePathwayButton.addEventListener("click", () => cycleEdgeState(incidentPathwaySelect.value));
incidentPathwaySelect.addEventListener("change", () => {
  updateEdgeStateView(incidentPathwaySelect.value, true);
});
// Wide transparent SVG strokes make map clicks forgiving; Enter/Space and the
// always-available selector use the same three-state pathway cycle.
pathwaysGroup.addEventListener("click", (event) => {
  const edge = event.target.closest("[data-edge-key]");
  if (edge) cycleEdgeState(edge.getAttribute("data-edge-key"));
});
pathwaysGroup.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const edge = event.target.closest(".pathway-hit-area");
  if (!edge) return;
  event.preventDefault();
  cycleEdgeState(edge.getAttribute("data-edge-key"));
});
randomIncidentButton.addEventListener("click", () => {
  const pathway = findIncidentPathway("", true);
  if (pathway) setEdgeState(pathwayKey(pathway.start, pathway.end, pathway.pathway), "block");
});

// Load the city graph once before making route and disruption controls available.
async function loadCity() {
  try {
    const response = await fetch("/api/city");
    if (!response.ok) throw new Error("The city map could not be loaded.");
    renderCity(await response.json());
    submitButton.disabled = false;
    setTestingControls(false);
    await refreshWeatherForecast();
  } catch (error) {
    showError(error instanceof Error ? error.message : "The city map could not be loaded.");
    submitButton.disabled = true;
  }
}

// Initialize the form with local time, then load the graph before enabling searches.
const defaultTime = new Date();
defaultTime.setMinutes(defaultTime.getMinutes() - defaultTime.getTimezoneOffset());
form.elements.time.value = defaultTime.toISOString().slice(0, 16);
loadCity();
loadSchedule();
