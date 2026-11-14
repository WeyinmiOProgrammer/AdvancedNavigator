"""A small, self-contained, multimodal city-navigation simulator.

Run ``python -m uvicorn app:app --reload`` for the web application, or
``python app.py`` for the interactive console application. Install the web
dependencies first with ``python -m pip install -r requirements.txt``.
Run ``python -m unittest -v`` to run the automated tests in ``test_app.py``.
"""

from __future__ import annotations

import difflib
import heapq
import html
import itertools
import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import Enum
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Map data and transport rules
# ---------------------------------------------------------------------------


class Pathway(Enum):
    """The physical type of a connection between two map locations."""

    ROAD = "road"
    PAVEMENT = "pavement"
    TRAIN = "train"


class TravelMode(Enum):
    """Travel modes available to a user in the console interface."""

    DRIVING = "driving"
    WALKING = "walking"
    TRANSIT = "public transit"


@dataclass(frozen=True)
class Location:
    """A named map node at fixed city coordinates."""

    name: str
    x: float
    y: float
    is_station: bool = False


@dataclass(frozen=True)
class Edge:
    """A directed traversal record; the graph adds a matching reverse edge."""

    start: str
    end: str
    pathway: Pathway
    distance_km: float
    speed_limit_kmh: float
    name: str
    highway: bool = False
    toll: bool = False
    train_line: Optional[str] = None


@dataclass(frozen=True)
class Preferences:
    """Optional restrictions and the metric used to rank candidate routes."""

    avoid_tolls: bool = False
    avoid_highways: bool = False
    priority: str = "fastest"


@dataclass(frozen=True)
class Leg:
    """One edge traversal with its scheduled departure and arrival times."""

    edge: Edge
    departure: datetime
    arrival: datetime


@dataclass(frozen=True)
class Obstruction:
    """A scheduled or injected condition affecting selected graph pathways."""

    start: str
    end: str
    pathway: Pathway
    name: str
    reason: str
    modes: tuple[TravelMode, ...]
    blocked: bool
    speed_factor: float
    weekdays: tuple[int, ...] = ()
    start_minute: int = 0
    end_minute: int = 24 * 60

    def is_active(self, edge: Edge, at: datetime, mode: TravelMode) -> bool:
        """Match an edge in either direction and its scheduled local-time window."""
        if (
            edge.pathway is not self.pathway
            or {edge.start, edge.end} != {self.start, self.end}
            or mode not in self.modes
        ):
            return False
        minute = at.hour * 60 + at.minute
        return (
            (not self.weekdays or at.weekday() in self.weekdays)
            and self.start_minute <= minute < self.end_minute
        )


@dataclass(frozen=True)
class Route:
    """A complete path and its timed traversals."""

    locations: tuple[str, ...]
    legs: tuple[Leg, ...]
    requested_departure: datetime

    @property
    def distance_km(self) -> float:
        """Return the sum of the distances of all route segments."""
        return sum(leg.edge.distance_km for leg in self.legs)

    @property
    def departure(self) -> datetime:
        """Return the user's requested departure, before any scheduled wait."""
        return self.requested_departure

    @property
    def arrival(self) -> datetime:
        """Return the final arrival time."""
        return self.legs[-1].arrival if self.legs else self.departure

    @property
    def duration(self) -> timedelta:
        """Return elapsed time, including any waits for scheduled trains."""
        return self.arrival - self.departure

    def summary(self) -> str:
        """Describe the route using street names and train line names."""
        labels: list[str] = []
        for leg in self.legs:
            label = leg.edge.train_line or leg.edge.name
            if not labels or labels[-1] != label:
                labels.append(label)
        return " and ".join(labels) if labels else "Already at destination"


class CityMap:
    """A fixed-coordinate city graph with mode-aware pathfinding."""

    # Train departures are every 15 minutes from 06:00 through 22:45 daily.
    TRAIN_FIRST_MINUTE = 6 * 60
    TRAIN_LAST_MINUTE = 22 * 60 + 45
    TRAIN_INTERVAL_MINUTES = 15
    SCHEDULED_OBSTRUCTIONS = (
        Obstruction(
            "Central Station",
            "University",
            Pathway.ROAD,
            "College Road",
            "Planned roadworks",
            (TravelMode.DRIVING,),
            True,
            1.0,
            (0, 1, 2, 3, 4),
            9 * 60,
            16 * 60,
        ),
        Obstruction(
            "West End",
            "City Hospital",
            Pathway.ROAD,
            "Medical Boulevard",
            "Weekday rush-hour traffic",
            (TravelMode.DRIVING,),
            False,
            2.2,
            (0, 1, 2, 3, 4),
            7 * 60,
            9 * 60,
        ),
        Obstruction(
            "Botanical Gardens",
            "Hilltop",
            Pathway.PAVEMENT,
            "Botanical Trail",
            "Severe-weather trail closure",
            (TravelMode.WALKING, TravelMode.TRANSIT),
            True,
            1.0,
            (5, 6),
            9 * 60,
            18 * 60,
        ),
    )

    def __init__(self) -> None:
        """Create the locations, pathways, and bidirectional adjacency list."""
        self.locations: dict[str, Location] = {}
        self.adjacency: dict[str, list[Edge]] = {}
        self._create_city()

    def _add_location(self, name: str, x: float, y: float, station: bool = False) -> None:
        """Register one uniquely named location and its map coordinates."""
        location = Location(name, x, y, station)
        self.locations[name] = location
        self.adjacency[name] = []

    def _add_edge(
        self,
        start: str,
        end: str,
        pathway: Pathway,
        name: str,
        speed_kmh: float,
        *,
        highway: bool = False,
        toll: bool = False,
        train_line: Optional[str] = None,
        distance_km: Optional[float] = None,
    ) -> None:
        """Add a two-way connection with a measured or coordinate-based length."""
        if start not in self.locations or end not in self.locations:
            raise ValueError(f"Unknown endpoint for pathway {start!r} - {end!r}")
        if pathway is Pathway.TRAIN:
            if not self.locations[start].is_station or not self.locations[end].is_station:
                raise ValueError("Train lines may only connect designated stations.")
            if not train_line:
                raise ValueError("Train pathways must specify a line name.")
        if distance_km is None:
            first, second = self.locations[start], self.locations[end]
            # Coordinates are city-grid kilometres; the factor models non-straight streets.
            distance_km = math.hypot(first.x - second.x, first.y - second.y) * 1.12
        for origin, destination in ((start, end), (end, start)):
            self.adjacency[origin].append(
                Edge(
                    origin,
                    destination,
                    pathway,
                    distance_km,
                    speed_kmh,
                    name,
                    highway,
                    toll,
                    train_line,
                )
            )

    def _create_city(self) -> None:
        """Populate the synthetic city with fixed locations and realistic links."""
        coordinates = [
            ("Old Town", 14, 43, False),
            ("Market Square", 29, 43, False),
            ("Central Station", 43, 42, True),
            ("Riverside Station", 57, 32, True),
            ("Museum Quarter", 42, 60, False),
            ("University", 57, 56, True),
            ("Tech Park", 75, 58, False),
            ("Harbor Station", 76, 25, True),
            ("Stadium", 75, 44, True),
            ("City Hospital", 59, 70, False),
            ("West End", 25, 67, False),
            ("North Park", 40, 78, False),
            ("Airport Station", 94, 70, True),
            ("Southbank", 33, 22, False),
            ("Hilltop", 49, 88, False),
            ("Library", 18, 19, False),
            ("Arts District", 28, 57, False),
            ("Eastgate", 90, 45, True),
            ("Greenfield", 74, 84, False),
            ("Docklands", 89, 19, False),
            ("Botanical Gardens", 61, 91, False),
            ("Old Bridge", 21, 31, False),
            ("Convention Centre", 49, 18, False),
            ("Airport Village", 97, 88, False),
        ]
        for name, x, y, station in coordinates:
            self._add_location(name, x, y, station)

        # Local roads also have pavements. Highway-only links deliberately do not.
        roads = [
            ("Old Town", "Market Square", "High Street", 40, False, False),
            ("Market Square", "Central Station", "Station Road", 40, False, False),
            ("Central Station", "Riverside Station", "Riverside Avenue", 50, False, False),
            ("Riverside Station", "Harbor Station", "Dock Road", 80, True, False),
            ("Central Station", "University", "College Road", 40, False, False),
            ("University", "Museum Quarter", "Arts Way", 35, False, False),
            ("Museum Quarter", "West End", "West End Road", 40, False, False),
            ("West End", "North Park", "Park Lane", 35, False, False),
            ("North Park", "Hilltop", "Hill Road", 70, True, False),
            ("West End", "City Hospital", "Medical Boulevard", 40, False, False),
            ("City Hospital", "Stadium", "Stadium Road", 40, False, False),
            ("Stadium", "Eastgate", "Eastgate Parkway", 80, True, False),
            ("Eastgate", "Tech Park", "Tech Corridor", 80, True, False),
            ("Tech Park", "Airport Station", "Airport Link", 100, True, True),
            ("Greenfield", "Airport Station", "Airport Approach", 50, False, False),
            ("Harbor Station", "Docklands", "Quay Street", 35, False, False),
            ("Docklands", "Eastgate", "Port Road", 70, True, False),
            ("Southbank", "Market Square", "Bridge Street", 40, False, False),
            ("Southbank", "Library", "Library Road", 30, False, False),
            ("Library", "Arts District", "Culture Avenue", 30, False, False),
            ("Arts District", "Museum Quarter", "Gallery Road", 35, False, False),
            ("Greenfield", "Airport Village", "Country Road", 50, False, False),
            ("Greenfield", "Hilltop", "Ridge Road", 40, False, False),
            ("Old Town", "Southbank", "Old Bridge", 35, False, False),
            ("Harbor Station", "Airport Station", "Outer Ring Road", 100, True, True),
            ("Central Station", "Old Bridge", "Foundry Street", 30, False, False),
            ("Convention Centre", "Southbank", "Convention Road", 30, False, False),
            ("Convention Centre", "Riverside Station", "River Road", 35, False, False),
            ("University", "City Hospital", "Campus Road", 30, False, False),
        ]
        for start, end, street, speed, highway, toll in roads:
            self._add_edge(start, end, Pathway.ROAD, street, speed, highway=highway, toll=toll)
            if not highway:
                self._add_edge(start, end, Pathway.PAVEMENT, f"{street} pavement", 5)

        # Pedestrian-only shortcuts connect parks, neighbourhoods, and local paths.
        footpaths = [
            ("Old Town", "Library", "Old Town Steps"),
            ("Market Square", "Library", "Market Walk"),
            ("University", "Tech Park", "Campus Path"),
            ("Harbor Station", "Stadium", "Waterfront Walk"),
            ("Greenfield", "Eastgate", "Greenway"),
            ("Hilltop", "North Park", "Hilltop Trail"),
            ("Botanical Gardens", "Greenfield", "Garden Path"),
            ("Botanical Gardens", "Hilltop", "Botanical Trail"),
            ("Airport Village", "Airport Station", "Terminal Walk"),
            ("Old Bridge", "Southbank", "Riverside Promenade"),
        ]
        for start, end, path_name in footpaths:
            self._add_edge(start, end, Pathway.PAVEMENT, path_name, 5)

        # Every rail segment joins stations and belongs to the named Central Line.
        rail_stops = [
            "Central Station",
            "Riverside Station",
            "Harbor Station",
            "University",
            "Stadium",
            "Eastgate",
            "Airport Station",
        ]
        for start, end in zip(rail_stops, rail_stops[1:]):
            self._add_edge(
                start,
                end,
                Pathway.TRAIN,
                "Central Line",
                60,
                train_line="Central Line",
            )

    @staticmethod
    def next_train_departure(at: datetime) -> datetime:
        """Return the next 15-minute train departure, including overnight service."""
        seconds_of_day = (
            at.hour * 3600
            + at.minute * 60
            + at.second
            + at.microsecond / 1_000_000
        )
        first_service_second = CityMap.TRAIN_FIRST_MINUTE * 60
        last_service_second = CityMap.TRAIN_LAST_MINUTE * 60
        if seconds_of_day < first_service_second:
            return at.replace(
                hour=6, minute=0, second=0, microsecond=0
            )
        if seconds_of_day > last_service_second:
            tomorrow = at + timedelta(days=1)
            return tomorrow.replace(hour=6, minute=0, second=0, microsecond=0)

        interval_seconds = CityMap.TRAIN_INTERVAL_MINUTES * 60
        elapsed_seconds = seconds_of_day - first_service_second
        next_train_offset = (
            math.ceil(elapsed_seconds / interval_seconds) * interval_seconds
        )
        today = at.replace(hour=0, minute=0, second=0, microsecond=0)
        return today + timedelta(seconds=first_service_second + next_train_offset)

    @staticmethod
    def _is_rush_hour(at: datetime) -> bool:
        """Identify weekday morning and evening peak periods for road traffic."""
        return at.weekday() < 5 and (
            7 <= at.hour < 9 or 16 <= at.hour < 18
        )

    def _leg_for(
        self,
        edge: Edge,
        at: datetime,
        mode: Optional[TravelMode] = None,
        obstructions: tuple[Obstruction, ...] = (),
    ) -> Leg:
        """Calculate an edge's travel and waiting time at the supplied instant."""
        speed_factor = 1.0
        if mode is not None:
            for obstruction in (*self.SCHEDULED_OBSTRUCTIONS, *obstructions):
                if obstruction.is_active(edge, at, mode) and not obstruction.blocked:
                    speed_factor *= obstruction.speed_factor
        if edge.pathway is Pathway.TRAIN:
            departure = self.next_train_departure(at)
            duration = timedelta(
                hours=edge.distance_km / edge.speed_limit_kmh * speed_factor
            )
            return Leg(edge, departure, departure + duration)

        departure = at
        hours = edge.distance_km / edge.speed_limit_kmh
        if edge.pathway is Pathway.ROAD and self._is_rush_hour(at):
            hours *= 1.6
        hours *= speed_factor
        duration = timedelta(hours=hours)
        return Leg(edge, departure, departure + duration)

    @staticmethod
    def _mode_allows(edge: Edge, mode: TravelMode) -> bool:
        """Enforce which pathway types each selected mode is permitted to use."""
        if mode is TravelMode.DRIVING:
            return edge.pathway is Pathway.ROAD
        if mode is TravelMode.WALKING:
            return edge.pathway is Pathway.PAVEMENT
        return edge.pathway in (Pathway.PAVEMENT, Pathway.TRAIN)

    @staticmethod
    def _preference_allows(edge: Edge, preferences: Preferences) -> bool:
        """Exclude toll roads or highways when the user has asked to avoid them."""
        if preferences.avoid_tolls and edge.toll:
            return False
        if preferences.avoid_highways and edge.highway:
            return False
        return True

    def find_routes(
        self,
        start: str,
        destination: str,
        departure: datetime,
        mode: TravelMode = TravelMode.TRANSIT,
        preferences: Preferences = Preferences(),
        limit: int = 3,
        obstructions: tuple[Obstruction, ...] = (),
    ) -> list[Route]:
        """Find up to ``limit`` distinct, simple routes ordered by user priority."""
        if start not in self.locations or destination not in self.locations:
            raise ValueError("Start and destination must be known map locations.")
        if limit < 1:
            raise ValueError("Route limit must be at least one.")
        if preferences.priority not in ("fastest", "shortest"):
            raise ValueError("Priority must be 'fastest' or 'shortest'.")
        if start == destination:
            return [Route((start,), (), departure)]

        # The heap explores the currently best partial path first. A monotonic,
        # time-dependent train schedule is handled by evaluating each edge on arrival.
        counter = itertools.count()
        queue: list[tuple[float, float, int, str, tuple[str, ...], tuple[Leg, ...]]] = [
            (0.0, 0.0, next(counter), start, (start,), ())
        ]
        results: list[Route] = []
        signatures: set[tuple[tuple[str, str, str], ...]] = set()
        expansions = 0

        while queue and len(results) < limit and expansions < 100_000:
            score, elapsed_minutes, _, current, path, legs = heapq.heappop(queue)
            expansions += 1
            if current == destination:
                signature = tuple(
                    (leg.edge.start, leg.edge.end, leg.edge.name) for leg in legs
                )
                if signature not in signatures:
                    signatures.add(signature)
                    results.append(Route(path, legs, departure))
                continue

            current_time = departure + timedelta(minutes=elapsed_minutes)
            for edge in self.adjacency[current]:
                if edge.end in path:
                    continue
                if not self._mode_allows(edge, mode):
                    continue
                if not self._preference_allows(edge, preferences):
                    continue
                if any(
                    obstruction.is_active(edge, current_time, mode)
                    and obstruction.blocked
                    for obstruction in (*self.SCHEDULED_OBSTRUCTIONS, *obstructions)
                ):
                    continue
                leg = self._leg_for(edge, current_time, mode, obstructions)
                updated_legs = legs + (leg,)
                updated_path = path + (edge.end,)
                updated_elapsed = (leg.arrival - departure).total_seconds() / 60
                updated_distance = sum(item.edge.distance_km for item in updated_legs)
                updated_score = (
                    updated_distance
                    if preferences.priority == "shortest"
                    else updated_elapsed
                )
                heapq.heappush(
                    queue,
                    (
                        updated_score,
                        updated_elapsed,
                        next(counter),
                        edge.end,
                        updated_path,
                        updated_legs,
                    ),
                )
        return results

    def routes_arriving_by(
        self,
        start: str,
        destination: str,
        deadline: datetime,
        mode: TravelMode,
        preferences: Preferences,
        limit: int = 3,
        obstructions: tuple[Obstruction, ...] = (),
    ) -> list[Route]:
        """Find route templates and estimate each one's latest feasible departure.

        The city trips fit comfortably within the preceding day. Candidate paths
        are identified at the start of that window, then a minute-resolution
        binary search finds the latest departure that meets the requested arrival.
        """
        window_start = deadline - timedelta(days=1)
        candidates = self.find_routes(
            start,
            destination,
            window_start,
            mode,
            preferences,
            limit=max(limit * 4, limit),
            obstructions=obstructions,
        )
        feasible: list[Route] = []
        for candidate in candidates:
            low, high = 0, 24 * 60
            best: Optional[Route] = None
            while low <= high:
                minutes = (low + high) // 2
                candidate_departure = window_start + timedelta(minutes=minutes)
                route = self._time_fixed_path(
                    candidate.locations,
                    candidate.legs,
                    candidate_departure,
                    mode,
                    preferences,
                    obstructions,
                )
                if route is not None and route.arrival <= deadline:
                    best = route
                    low = minutes + 1
                else:
                    high = minutes - 1
            if best is not None:
                feasible.append(best)
        if preferences.priority == "shortest":
            feasible.sort(key=lambda route: (route.distance_km, route.duration))
        else:
            feasible.sort(key=lambda route: (route.duration, route.distance_km))
        return feasible[:limit]

    def _time_fixed_path(
        self,
        locations: tuple[str, ...],
        template_legs: tuple[Leg, ...],
        departure: datetime,
        mode: TravelMode,
        preferences: Preferences,
        obstructions: tuple[Obstruction, ...] = (),
    ) -> Optional[Route]:
        """Re-time a known sequence of locations and reject now-invalid links."""
        timed_legs: list[Leg] = []
        current_time = departure
        for start, end, template in zip(locations, locations[1:], template_legs):
            edge = next(
                (
                    item
                    for item in self.adjacency[start]
                    if item.end == end and item.name == template.edge.name
                ),
                None,
            )
            if (
                edge is None
                or not self._mode_allows(edge, mode)
                or not self._preference_allows(edge, preferences)
                or any(
                    obstruction.is_active(edge, current_time, mode)
                    and obstruction.blocked
                    for obstruction in (*self.SCHEDULED_OBSTRUCTIONS, *obstructions)
                )
            ):
                return None
            leg = self._leg_for(edge, current_time, mode, obstructions)
            timed_legs.append(leg)
            current_time = leg.arrival
        return Route(locations, tuple(timed_legs), departure)


# ---------------------------------------------------------------------------
# Console input, route presentation, and SVG map rendering
# ---------------------------------------------------------------------------


def parse_datetime(value: str) -> datetime:
    """Parse an ISO date/time string and raise a helpful error if malformed."""
    try:
        return datetime.fromisoformat(value.strip())
    except ValueError as error:
        raise ValueError("Use YYYY-MM-DD HH:MM (for example 2026-06-15 08:30).") from error


def match_location(value: str, city: CityMap) -> str:
    """Match a case-insensitive exact location name or suggest close spellings."""
    names = list(city.locations)
    for name in names:
        if name.casefold() == value.strip().casefold():
            return name
    suggestions = difflib.get_close_matches(value.strip(), names, n=3, cutoff=0.45)
    if suggestions:
        raise ValueError(f"Unknown location {value!r}. Did you mean: {', '.join(suggestions)}?")
    raise ValueError(f"Unknown location {value!r}. Choose a name from the map.")


def _format_duration(duration: timedelta) -> str:
    """Format an elapsed duration as user-friendly whole minutes."""
    minutes = max(0, math.ceil(duration.total_seconds() / 60))
    hours, remainder = divmod(minutes, 60)
    return f"{hours} hr {remainder} min" if hours else f"{minutes} min"


def _format_route(route: Route, number: int) -> str:
    """Build one numbered route option with exact times and a concise summary."""
    return (
        f"{number}. Via {route.summary()} - {_format_duration(route.duration)} "
        f"({route.departure:%Y-%m-%d %H:%M} to {route.arrival:%Y-%m-%d %H:%M}; "
        f"{route.distance_km:.1f} km)"
    )


def render_svg(city: CityMap, route: Route, output: Path = Path("city_route_map.svg")) -> Path:
    """Write a standalone SVG map showing all pathways and the selected route."""
    width, height = 1000, 860
    margin = 55
    scale_x = (width - 2 * margin) / 100
    scale_y = (height - 2 * margin) / 100

    def point(name: str) -> tuple[float, float]:
        """Transform city coordinates to the SVG canvas coordinate system."""
        location = city.locations[name]
        return margin + location.x * scale_x, height - margin - location.y * scale_y

    colors = {
        Pathway.ROAD: "#8993a4",
        Pathway.PAVEMENT: "#a9b5c5",
        Pathway.TRAIN: "#d18b21",
    }
    lines: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}">',
        "<rect width=\"100%\" height=\"100%\" fill=\"#f7f9fc\"/>",
        '<text x="28" y="32" font-family="sans-serif" font-size="21" '
        'font-weight="bold" fill="#172033">Simulated City - Selected Route</text>',
    ]

    # Draw each undirected pathway once; SVG styling distinguishes its type.
    seen: set[tuple[str, str, str]] = set()
    for edges in city.adjacency.values():
        for edge in edges:
            key = tuple(sorted((edge.start, edge.end))) + (edge.pathway.value + edge.name,)
            if key in seen:
                continue
            seen.add(key)
            x1, y1 = point(edge.start)
            x2, y2 = point(edge.end)
            if edge.pathway is Pathway.PAVEMENT:
                style = 'stroke-dasharray="2 5"'
                stroke_width = 2
            elif edge.pathway is Pathway.TRAIN:
                style = 'stroke-dasharray="8 5"'
                stroke_width = 4
            else:
                style = ""
                stroke_width = 3 if edge.highway else 2
            lines.append(
                f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
                f'stroke="{colors[edge.pathway]}" stroke-width="{stroke_width}" '
                f'{style} stroke-linecap="round"/>'
            )

    # Re-draw the selected path above the base network for clear visibility.
    for leg in route.legs:
        x1, y1 = point(leg.edge.start)
        x2, y2 = point(leg.edge.end)
        color = "#d62828"
        lines.append(
            f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
            f'stroke="{color}" stroke-width="6" stroke-linecap="round"/>'
        )

    # Mark and label all 24 fixed locations; station markers are square.
    for name, location in city.locations.items():
        x, y = point(name)
        fill = "#174ea6" if location.is_station else "#334155"
        if location.is_station:
            lines.append(
                f'<rect x="{x - 5:.1f}" y="{y - 5:.1f}" width="10" height="10" '
                f'fill="{fill}" stroke="white" stroke-width="1.5"/>'
            )
        else:
            lines.append(
                f'<circle cx="{x:.1f}" cy="{y:.1f}" r="5" fill="{fill}" '
                'stroke="white" stroke-width="1.5"/>'
            )
        label = html.escape(name)
        lines.append(
            f'<text x="{x + 7:.1f}" y="{y - 7:.1f}" font-family="sans-serif" '
            f'font-size="10" fill="#172033">{label}</text>'
        )

    # Include a compact pathway legend and trip summary in the map itself.
    legend_y = height - 19
    legend_items = [
        (30, "#8993a4", "Roads"),
        (130, "#a9b5c5", "Pavements"),
        (260, "#d18b21", "Train lines"),
        (390, "#d62828", "Chosen route"),
    ]
    for x, color, label in legend_items:
        lines.append(
            f'<line x1="{x}" y1="{legend_y}" x2="{x + 24}" y2="{legend_y}" '
            f'stroke="{color}" stroke-width="4"/>'
            f'<text x="{x + 30}" y="{legend_y + 4}" font-family="sans-serif" '
            f'font-size="12" fill="#172033">{label}</text>'
        )
    lines.append("</svg>")
    output.write_text("\n".join(lines), encoding="utf-8")
    return output


# ---------------------------------------------------------------------------
# Web API
# ---------------------------------------------------------------------------


class TripRequest(BaseModel):
    """Validated JSON contract accepted by the browser's route form."""

    start: str = Field(min_length=1, max_length=100)
    destination: str = Field(min_length=1, max_length=100)
    time_kind: Literal["departure", "arrival"] = "departure"
    time: datetime
    mode: Literal["driving", "walking", "transit"] = "transit"
    avoid_tolls: bool = False
    avoid_highways: bool = False
    priority: Literal["fastest", "shortest"] = "fastest"
    limit: int = Field(default=3, ge=1, le=3)


class IncidentRequest(BaseModel):
    """One user-injected disruption on a pathway in the city graph."""

    start: str = Field(min_length=1, max_length=100)
    end: str = Field(min_length=1, max_length=100)
    pathway: Literal["road", "pavement", "train"]
    kind: Literal["block", "delay"]


class RerouteRequest(BaseModel):
    """Current journey position and the incident that requires a new route."""

    destination: str = Field(min_length=1, max_length=100)
    time: datetime
    mode: Literal["driving", "walking", "transit"]
    current_edge_start: str
    current_edge_end: str
    current_edge_pathway: Literal["road", "pavement", "train"]
    progress: float = Field(ge=0, le=1)
    incident: IncidentRequest
    additional_incidents: list[IncidentRequest] = Field(default_factory=list)
    avoid_tolls: bool = False
    avoid_highways: bool = False
    priority: Literal["fastest", "shortest"] = "fastest"


class LocationResponse(BaseModel):
    """A fixed graph node returned for dynamic browser map rendering."""

    name: str
    x: float
    y: float
    is_station: bool


class PathwayResponse(BaseModel):
    """One undirected pathway, with the information used by the map legend."""

    start: str
    end: str
    pathway: str
    name: str
    highway: bool
    toll: bool
    train_line: Optional[str]


class CityResponse(BaseModel):
    """Graph payload consumed by the frontend to draw the city map."""

    locations: list[LocationResponse]
    pathways: list[PathwayResponse]
    obstructions: list["ScheduledObstructionResponse"]


class ScheduledObstructionResponse(BaseModel):
    """A scheduled condition and the local-time window used by the map."""

    start: str
    end: str
    pathway: str
    name: str
    reason: str
    modes: list[str]
    blocked: bool
    speed_factor: float
    weekdays: list[int]
    start_minute: int
    end_minute: int


class RouteLegResponse(BaseModel):
    """One timed segment; its endpoints let the browser highlight the route."""

    start: str
    end: str
    pathway: str
    name: str
    train_line: Optional[str]
    departure: datetime
    arrival: datetime


class RouteResponse(BaseModel):
    """A browser-ready route option with summary, timing, and map segments."""

    id: int
    locations: list[str]
    legs: list[RouteLegResponse]
    departure: datetime
    arrival: datetime
    duration_minutes: int
    distance_km: float
    summary: str


class RoutesResponse(BaseModel):
    """Response envelope shared by all successful route requests."""

    routes: list[RouteResponse]


class RerouteResponse(BaseModel):
    """The new path and the mode-specific movement needed to reach it."""

    switch_node: str
    approach_minutes: float
    reaction_minutes: float
    approach_start_x: float
    approach_start_y: float
    approach_end_x: float
    approach_end_y: float
    reason: str
    route: RouteResponse


app = FastAPI(title="City Navigator", version="1.0.0")
city = CityMap()
static_directory = Path(__file__).resolve().parent / "static"
app.mount("/static", StaticFiles(directory=static_directory), name="static")


@app.get("/", include_in_schema=False)
def home() -> FileResponse:
    """Serve the browser entry point from the same process as the API."""
    return FileResponse(static_directory / "index.html")


@app.get("/api/city", response_model=CityResponse)
def get_city() -> CityResponse:
    """Expose coordinates and a de-duplicated network for the SVG map."""
    locations = [
        LocationResponse(
            name=location.name,
            x=location.x,
            y=location.y,
            is_station=location.is_station,
        )
        for location in city.locations.values()
    ]
    pathways: list[PathwayResponse] = []
    seen: set[tuple[str, str, str, str]] = set()
    for edges in city.adjacency.values():
        for edge in edges:
            endpoints = tuple(sorted((edge.start, edge.end)))
            key = (endpoints[0], endpoints[1], edge.pathway.value, edge.name)
            if key in seen:
                continue
            seen.add(key)
            pathways.append(
                PathwayResponse(
                    start=edge.start,
                    end=edge.end,
                    pathway=edge.pathway.value,
                    name=edge.name,
                    highway=edge.highway,
                    toll=edge.toll,
                    train_line=edge.train_line,
                )
            )
    obstructions = [
        ScheduledObstructionResponse(
            start=obstruction.start,
            end=obstruction.end,
            pathway=obstruction.pathway.value,
            name=obstruction.name,
            reason=obstruction.reason,
            modes=[mode.name.lower() for mode in obstruction.modes],
            blocked=obstruction.blocked,
            speed_factor=obstruction.speed_factor,
            weekdays=list(obstruction.weekdays),
            start_minute=obstruction.start_minute,
            end_minute=obstruction.end_minute,
        )
        for obstruction in city.SCHEDULED_OBSTRUCTIONS
    ]
    return CityResponse(locations=locations, pathways=pathways, obstructions=obstructions)


def _route_response(route: Route, route_id: int) -> RouteResponse:
    """Adapt one simulator route to its stable browser representation."""
    return RouteResponse(
        id=route_id,
        locations=list(route.locations),
        legs=[
            RouteLegResponse(
                start=leg.edge.start,
                end=leg.edge.end,
                pathway=leg.edge.pathway.value,
                name=leg.edge.name,
                train_line=leg.edge.train_line,
                departure=leg.departure,
                arrival=leg.arrival,
            )
            for leg in route.legs
        ],
        departure=route.departure,
        arrival=route.arrival,
        duration_minutes=math.ceil(route.duration.total_seconds() / 60),
        distance_km=route.distance_km,
        summary=route.summary(),
    )


@app.post("/api/routes", response_model=RoutesResponse)
def calculate_routes(request: TripRequest) -> RoutesResponse:
    """Validate form locations and adapt simulator routes to the JSON contract."""
    try:
        start = match_location(request.start, city)
        destination = match_location(request.destination, city)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    mode = {
        "driving": TravelMode.DRIVING,
        "walking": TravelMode.WALKING,
        "transit": TravelMode.TRANSIT,
    }[request.mode]
    preferences = Preferences(
        avoid_tolls=request.avoid_tolls,
        avoid_highways=request.avoid_highways,
        priority=request.priority,
    )
    if request.time_kind == "arrival":
        routes = city.routes_arriving_by(
            start, destination, request.time, mode, preferences, limit=request.limit
        )
    else:
        routes = city.find_routes(
            start, destination, request.time, mode, preferences, limit=request.limit
        )
    if not routes:
        raise HTTPException(
            status_code=422,
            detail="No route is available for those locations and trip settings.",
        )

    # Each response leg preserves its graph endpoints, so the selected card can
    # identify and highlight the matching lines without another server request.
    return RoutesResponse(
        routes=[
            _route_response(route, index)
            for index, route in enumerate(routes, start=1)
        ]
    )


@app.post("/api/reroute", response_model=RerouteResponse)
def calculate_reroute(request: RerouteRequest) -> RerouteResponse:
    """Replan around a live incident, honoring each mode's transition policy."""
    try:
        destination = match_location(request.destination, city)
        edge = next(
            item
            for item in city.adjacency[request.current_edge_start]
            if item.end == request.current_edge_end
            and item.pathway.value == request.current_edge_pathway
        )
    except (KeyError, StopIteration, ValueError) as error:
        raise HTTPException(
            status_code=422, detail="The current or obstructed pathway is unknown."
        ) from error

    mode = {
        "driving": TravelMode.DRIVING,
        "walking": TravelMode.WALKING,
        "transit": TravelMode.TRANSIT,
    }[request.mode]
    if not city._mode_allows(edge, mode):
        raise HTTPException(
            status_code=422,
            detail="The current pathway is not valid for this travel mode.",
        )
    obstructions: list[Obstruction] = []
    try:
        for item in (request.incident, *request.additional_incidents):
            incident_edge = next(
                edge_item
                for edge_item in city.adjacency[item.start]
                if edge_item.end == item.end
                and edge_item.pathway.value == item.pathway
            )
            obstruction_key = (
                incident_edge.start,
                incident_edge.end,
                incident_edge.pathway,
            )
            if any(
                (existing.start, existing.end, existing.pathway) == obstruction_key
                or (existing.end, existing.start, existing.pathway) == obstruction_key
                for existing in obstructions
            ):
                continue
            obstructions.append(
                Obstruction(
                    incident_edge.start,
                    incident_edge.end,
                    incident_edge.pathway,
                    incident_edge.name,
                    "Injected blockage" if item.kind == "block" else "Injected delay",
                    (mode,),
                    item.kind == "block",
                    3.0,
                )
            )
    except (KeyError, StopIteration) as error:
        raise HTTPException(
            status_code=422, detail="The obstructed pathway is unknown."
        ) from error
    incident = obstructions[0]
    preferences = Preferences(
        avoid_tolls=request.avoid_tolls,
        avoid_highways=request.avoid_highways,
        priority=request.priority,
    )
    current_location = city.locations[edge.start]
    next_location = city.locations[edge.end]
    progress = request.progress
    current_x = current_location.x + (next_location.x - current_location.x) * progress
    current_y = current_location.y + (next_location.y - current_location.y) * progress

    if mode is TravelMode.WALKING:
        # Walkers can reverse from their exact position. If the current edge is
        # blocked ahead, only the already-traversed side is a valid escape.
        endpoints = (
            [(edge.start, progress)]
            if any(
                obstruction.blocked
                and obstruction.is_active(edge, request.time, mode)
                for obstruction in obstructions
            )
            else [(edge.start, progress), (edge.end, 1 - progress)]
        )
        reaction_minutes = 0.0
    elif progress <= 0:
        # If playback is waiting at a node, no partial edge traversal is needed.
        endpoints = [(edge.start, 0.0)]
        reaction_minutes = 3.0 if mode is TravelMode.DRIVING else 0.0
    else:
        # Vehicles and transit remain on their fixed edge and only switch at its
        # next node; drivers additionally spend three simulated minutes reacting.
        endpoints = [(edge.end, 1 - progress)]
        reaction_minutes = 3.0 if mode is TravelMode.DRIVING else 0.0

    candidates: list[tuple[Route, str, float]] = []
    for switch_node, distance_fraction in endpoints:
        if mode is TravelMode.WALKING:
            access_seconds = (
                edge.distance_km
                * distance_fraction
                / edge.speed_limit_kmh
                * 3600
            )
            for obstruction in obstructions:
                if obstruction.is_active(edge, request.time, mode) and not obstruction.blocked:
                    access_seconds *= obstruction.speed_factor
            approach_minutes = access_seconds / 60
        else:
            # Transit follows its current fixed edge; cars also account for the
            # live road-speed conditions before their fixed-node transition.
            if mode is TravelMode.DRIVING:
                current_leg = city._leg_for(edge, request.time, mode, tuple(obstructions))
                edge_minutes = (
                    current_leg.arrival - current_leg.departure
                ).total_seconds() / 60
            else:
                incident_speed_factor = (
                    math.prod(
                        obstruction.speed_factor
                        for obstruction in obstructions
                        if obstruction.is_active(edge, request.time, mode)
                        and not obstruction.blocked
                    )
                )
                edge_minutes = (
                    edge.distance_km / edge.speed_limit_kmh * 60
                    * incident_speed_factor
                )
            approach_minutes = edge_minutes * distance_fraction
        switch_time = request.time + timedelta(
            minutes=approach_minutes + reaction_minutes
        )
        routes = city.find_routes(
            switch_node,
            destination,
            switch_time,
            mode,
            preferences,
            limit=1,
            obstructions=tuple(obstructions),
        )
        if routes:
            candidates.append((routes[0], switch_node, approach_minutes))
    if not candidates:
        raise HTTPException(
            status_code=422,
            detail="No route is available around that obstruction.",
        )
    route, switch_node, approach_minutes = min(
        candidates, key=lambda candidate: candidate[0].arrival
    )
    switch_location = city.locations[switch_node]
    return RerouteResponse(
        switch_node=switch_node,
        approach_minutes=approach_minutes,
        reaction_minutes=reaction_minutes,
        approach_start_x=current_x,
        approach_start_y=current_y,
        approach_end_x=switch_location.x,
        approach_end_y=switch_location.y,
        reason=incident.reason,
        route=_route_response(route, 1),
    )


def _ask_location(prompt: str, city: CityMap) -> str:
    """Prompt until the user supplies a valid city location."""
    while True:
        try:
            return match_location(input(prompt), city)
        except ValueError as error:
            print(error)


def _ask_yes_no(prompt: str, default: bool = False) -> bool:
    """Read an optional yes/no setting without accepting ambiguous values."""
    while True:
        value = input(prompt).strip().casefold()
        if not value:
            return default
        if value in ("y", "yes"):
            return True
        if value in ("n", "no"):
            return False
        print("Please enter y or n.")


def run_console() -> None:
    """Collect trip settings, offer routes, and render the chosen route's map."""
    city = CityMap()
    print("City Navigator - available locations:")
    print(", ".join(city.locations))
    start = _ask_location("Starting location: ", city)
    destination = _ask_location("Destination: ", city)

    while True:
        mode_value = input("Mode [transit/driving/walking] (default transit): ").strip().casefold()
        if not mode_value:
            mode = TravelMode.TRANSIT
            break
        mode_aliases = {
            "transit": TravelMode.TRANSIT,
            "public transit": TravelMode.TRANSIT,
            "driving": TravelMode.DRIVING,
            "drive": TravelMode.DRIVING,
            "walking": TravelMode.WALKING,
            "walk": TravelMode.WALKING,
        }
        if mode_value in mode_aliases:
            mode = mode_aliases[mode_value]
            break
        print("Choose transit, driving, or walking.")

    while True:
        time_kind = input(
            "Time constraint [departure/arrival/now] (default now): "
        ).strip().casefold()
        if not time_kind:
            time_kind = "now"
        if time_kind in ("departure", "arrival", "now"):
            break
        print("Choose departure, arrival, or now.")
    if time_kind == "now":
        time_value = datetime.now()
    else:
        while True:
            try:
                time_value = parse_datetime(
                    input(f"{time_kind.title()} date and time (YYYY-MM-DD HH:MM): ")
                )
                break
            except ValueError as error:
                print(error)

    preferences = Preferences(
        avoid_tolls=_ask_yes_no("Avoid toll roads? [y/N]: "),
        avoid_highways=_ask_yes_no("Avoid highways? [y/N]: "),
    )
    while True:
        priority = input("Route priority [fastest/shortest] (default fastest): ").strip().casefold()
        if not priority:
            priority = "fastest"
        if priority in ("fastest", "shortest"):
            preferences = Preferences(
                preferences.avoid_tolls, preferences.avoid_highways, priority
            )
            break
        print("Choose fastest or shortest.")

    try:
        if time_kind in ("departure", "now"):
            routes = city.find_routes(
                start, destination, time_value, mode, preferences, limit=3
            )
        else:
            routes = city.routes_arriving_by(
                start, destination, time_value, mode, preferences, limit=3
            )
    except ValueError as error:
        print(f"Could not calculate routes: {error}")
        return

    if not routes:
        print("No valid route exists for these locations, mode, and preferences.")
        return

    print("\nRoute options:")
    for index, route in enumerate(routes, start=1):
        print(_format_route(route, index))
    while True:
        choice = input(f"Select a route (1-{len(routes)}): ").strip()
        if choice.isdigit() and 1 <= int(choice) <= len(routes):
            selected = routes[int(choice) - 1]
            break
        print(f"Enter a number from 1 to {len(routes)}.")

    output = render_svg(city, selected)
    print(f"\nMap saved to: {output.resolve()}")
    print(f"Estimated arrival: {selected.arrival:%Y-%m-%d %H:%M}")


if __name__ == "__main__":
    run_console()