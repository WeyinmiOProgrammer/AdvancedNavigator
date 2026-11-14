// The frontend loads the graph once, then sends validated trip settings to
// POST /api/routes; route legs in the response map directly to SVG segments.
const form = document.querySelector("#trip-form");
const alertBox = document.querySelector("#alert");
const routeList = document.querySelector("#route-list");
const routeHint = document.querySelector("#route-hint");
const datalist = document.querySelector("#location-options");
const svg = document.querySelector("#city-map");
const pathwaysGroup = document.querySelector("#pathways");
const selectedRouteGroup = document.querySelector("#selected-route");
const locationsGroup = document.querySelector("#map-locations");
const timeKind = document.querySelector("#time-kind");
const timeLabel = document.querySelector("#time-label");
const submitButton = form.querySelector('button[type="submit"]');

let cityGraph;
submitButton.disabled = true;

function mapPoint(location) {
  return { x: 45 + location.x * 9.1, y: 805 - location.y * 7.5 };
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

function renderCity(graph) {
  cityGraph = graph;
  const locationByName = new Map(graph.locations.map((location) => [location.name, location]));
  const options = graph.locations.map((location) => {
    const option = document.createElement("option");
    option.value = location.name;
    return option;
  });
  datalist.replaceChildren(...options);

  const lines = graph.pathways.map((pathway) => {
    const start = mapPoint(locationByName.get(pathway.start));
    const end = mapPoint(locationByName.get(pathway.end));
    const line = svgElement("line", {
      x1: start.x, y1: start.y, x2: end.x, y2: end.y,
      class: `pathway pathway-${pathway.pathway}`,
    });
    const title = svgElement("title");
    title.textContent = `${pathway.name}: ${pathway.start} to ${pathway.end}`;
    line.append(title);
    return line;
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
}

function highlightRoute(route) {
  const locationByName = new Map(cityGraph.locations.map((location) => [location.name, location]));
  const segments = route.legs.map((leg) => {
    const start = mapPoint(locationByName.get(leg.start));
    const end = mapPoint(locationByName.get(leg.end));
    return svgElement("line", {
      x1: start.x, y1: start.y, x2: end.x, y2: end.y, class: "route-segment",
    });
  });
  const markers = [route.locations[0], route.locations[route.locations.length - 1]]
    .filter((name, index, names) => names.indexOf(name) === index)
    .map((name) => {
      const point = mapPoint(locationByName.get(name));
      const marker = svgElement("circle", {
        cx: point.x, cy: point.y, r: 9, class: "map-marker",
      });
      const title = svgElement("title");
      title.textContent = name;
      marker.append(title);
      return marker;
    });
  selectedRouteGroup.replaceChildren(...segments, ...markers);
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
    card.addEventListener("click", () => highlightRoute(route));
    routeList.append(card);
  });
  routeHint.textContent = `${routes.length} route option${routes.length === 1 ? "" : "s"} found.`;
  highlightRoute(routes[0]);
}

function showError(message) {
  alertBox.textContent = message;
  alertBox.hidden = false;
}

timeKind.addEventListener("change", () => {
  timeLabel.textContent = timeKind.value === "arrival"
    ? "Arrival date and time"
    : "Departure date and time";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  alertBox.hidden = true;
  routeList.replaceChildren();
  selectedRouteGroup.replaceChildren();
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

async function loadCity() {
  try {
    const response = await fetch("/api/city");
    if (!response.ok) throw new Error("The city map could not be loaded.");
    renderCity(await response.json());
    submitButton.disabled = false;
  } catch (error) {
    showError(error instanceof Error ? error.message : "The city map could not be loaded.");
    submitButton.disabled = true;
  }
}

// The simulator treats trip times as local wall-clock values, so send the
// datetime-local string unchanged rather than shifting it through UTC.
const defaultTime = new Date();
defaultTime.setMinutes(defaultTime.getMinutes() - defaultTime.getTimezoneOffset());
form.elements.time.value = defaultTime.toISOString().slice(0, 16);
loadCity();
