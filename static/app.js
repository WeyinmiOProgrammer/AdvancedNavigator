const form = document.querySelector("#trip-form");
const alertBox = document.querySelector("#alert");
const routeList = document.querySelector("#route-list");
const routeHint = document.querySelector("#route-hint");
const datalist = document.querySelector("#location-options");
const svg = document.querySelector("#city-map");
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
submitButton.disabled = true;
startSimulationButton.disabled = true;

function mapPoint(location) {
  return { x: 45 + location.x * 9.1, y: 805 - location.y * 7.5 };
}

function mapCoordinate(x, y) {
  return { x: 45 + x * 9.1, y: 805 - y * 7.5 };
}

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

function svgElement(name, attributes = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

function pathwayKey(start, end, pathway) {
  return [start, end].sort().concat(pathway).join("|");
}

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

function stateLabel(kind) {
  return ({ delay: "Delay", block: "Blocked" })[kind] || "Normal";
}

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

async function setEdgeState(key, kind, reroute = true) {
  const pathway = pathwayByKey.get(key);
  if (!pathway) return;
  if (kind === "normal") edgeStates.delete(key);
  else edgeStates.set(key, kind);
  updateEdgeStateView(key, true);
  refreshObstructionIcons(journey ? journey.route : null);
  const sync = queueObstructionSync(pathway, kind);
  if (reroute && journey) await triggerIncident(kind, false, pathway, sync);
}

function cycleEdgeState(key) {
  const current = edgeStates.get(key) || "normal";
  const next = ({ normal: "delay", delay: "block", block: "normal" })[current];
  setEdgeState(key, next);
}

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
    card.setAttribute("aria-pressed", String(Number(card.dataset.routeId) === route.id));
  });
  svg.setAttribute("aria-label", `City map with selected route: ${route.locations.join(" to ")}`);
}

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium", timeStyle: "short",
  }).format(new Date(value));
}

function routeDuration(route) {
  return Math.max(0, Math.ceil(
    (new Date(route.arrival).getTime() - simulationTime) / 60000,
  ));
}

function showRoutes(routes) {
  routeList.replaceChildren();
  routes.forEach((route) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "route-card";
    card.dataset.routeId = String(route.id);
    card.setAttribute("aria-pressed", "false");
    card.setAttribute("aria-label",
      `Route ${route.id}: ${route.summary}, ${route.duration_minutes} minutes`);

    const title = document.createElement("strong");
    title.textContent = `Option ${route.id} · ${route.duration_minutes} min`;
    const summary = document.createElement("span");
    summary.textContent = `Via ${route.summary} · ${route.distance_km.toFixed(1)} km`;
    const times = document.createElement("span");
    times.textContent = `${formatTime(route.departure)} – ${formatTime(route.arrival)}`;
    card.append(title, summary, times);
    card.addEventListener("click", () => selectRoute(route));
    routeList.append(card);
  });
  routeHint.textContent = `${routes.length} route option${routes.length === 1 ? "" : "s"} found.`;
  selectRoute(routes[0]);
}

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
      return (!item.weekdays.length || item.weekdays.includes(weekday))
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

function drawObstruction(obstruction, injected = false) {
  const start = cityGraph.locations.find((item) => item.name === obstruction.start);
  const end = cityGraph.locations.find((item) => item.name === obstruction.end);
  if (!start || !end) return null;
  const first = mapPoint(start);
  const second = mapPoint(end);
  const x = (first.x + second.x) / 2;
  const y = (first.y + second.y) / 2;
  const marker = svgElement("g", { "aria-label": obstruction.reason });
  marker.append(svgElement("circle", {
    cx: x, cy: y, r: 11,
    class: `obstruction-marker${injected ? " obstruction-injected" : ""}`,
  }));
  const label = svgElement("text", {
    x, y: y + 5, class: "obstruction-label",
  });
  label.textContent = injected && obstruction.blocked ? "×" : "!";
  const title = svgElement("title");
  title.textContent = `${obstruction.reason}: ${obstruction.start} to ${obstruction.end}`;
  marker.append(label, title);
  return marker;
}

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

function showError(message) {
  alertBox.textContent = message;
  alertBox.hidden = false;
}

function localDateTime(milliseconds) {
  const date = new Date(milliseconds - new Date(milliseconds).getTimezoneOffset() * 60000);
  return date.toISOString().slice(0, 19);
}

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

function createJourneyMarker() {
  const marker = svgElement("g", { "aria-label": "Current journey position" });
  marker.append(
    svgElement("circle", { r: 12, class: "journey-marker" }),
    svgElement("circle", { r: 4, class: "journey-marker-core" }),
  );
  movingMarkerGroup.replaceChildren(marker);
  return marker;
}

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

function updateReadouts() {
  clockReadout.textContent = formatTime(simulationTime);
  const remaining = routeDuration(journey.route);
  etaReadout.textContent = remaining <= 0
    ? `Arrived · ${formatTime(journey.route.arrival)}`
    : `${formatTime(journey.route.arrival)} · ${remaining} min remaining`;
}

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

function togglePlayback() {
  if (!journey) return;
  isPlaying = !isPlaying;
  lastFrameTime = null;
  playPauseButton.textContent = isPlaying ? "Pause" : "Play";
  setTestingControls(isPlaying);
  if (isPlaying) animationFrame = requestAnimationFrame(updateSimulationFrame);
}

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

timeKind.addEventListener("change", () => {
  timeLabel.textContent = timeKind.value === "arrival"
    ? "Arrival date and time"
    : "Departure date and time";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  alertBox.hidden = true;
  resetSimulation();
  selectedRoute = null;
  startSimulationButton.disabled = true;
  routeList.replaceChildren();
  selectedRouteGroup.replaceChildren();
  obstructionsGroup.replaceChildren();
  svg.setAttribute("aria-label", "Map of city locations and roads, pavements, and train lines");
  routeHint.textContent = "Calculating routes…";
  submitButton.disabled = true;

  const data = new FormData(form);
  const payload = {
    start: data.get("start"),
    destination: data.get("destination"),
    time_kind: data.get("time_kind"),
    time: data.get("time"),
    mode: data.get("mode"),
    priority: data.get("priority"),
    avoid_tolls: data.has("avoid_tolls"),
    avoid_highways: data.has("avoid_highways"),
  };
  try {
    await obstructionSync;
    if (failedObstructionSyncs.size) {
      throw new Error("Wait for pathway changes to synchronize before calculating routes.");
    }
    const response = await fetch("/api/routes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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

async function loadCity() {
  try {
    const response = await fetch("/api/city");
    if (!response.ok) throw new Error("The city map could not be loaded.");
    renderCity(await response.json());
    submitButton.disabled = false;
    setTestingControls(false);
  } catch (error) {
    showError(error instanceof Error ? error.message : "The city map could not be loaded.");
    submitButton.disabled = true;
  }
}

// Keep datetime-local values in the simulator's local wall-clock timezone.
const defaultTime = new Date();
defaultTime.setMinutes(defaultTime.getMinutes() - defaultTime.getTimezoneOffset());
form.elements.time.value = defaultTime.toISOString().slice(0, 16);
loadCity();
