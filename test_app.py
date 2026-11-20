"""Focused tests for the city navigator's routing and time calculations."""

import unittest
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from xml.etree import ElementTree

from fastapi import HTTPException

from app import (
    CityMap,
    IncidentRequest,
    ManualObstructionRequest,
    Pathway,
    Preferences,
    RerouteRequest,
    TravelMode,
    TripRequest,
    calculate_routes,
    calculate_reroute,
    evaluate_weather_risk,
    get_city,
    get_schedule,
    get_weather,
    manual_obstructions,
    render_svg,
    simulate_weather,
    update_manual_obstruction,
)


class CityMapTests(unittest.TestCase):
    """Verify graph construction, mode rules, and time-dependent travel."""

    def setUp(self) -> None:
        """Build a fresh synthetic city for each independent test."""
        self.city = CityMap()

    def test_map_has_named_fixed_locations_and_station_only_train_edges(self) -> None:
        """The map is stable and all rail segments join designated stations."""
        self.assertGreaterEqual(len(self.city.locations), 20)
        self.assertEqual(self.city.locations["Central Station"].x, 43)
        for edges in self.city.adjacency.values():
            for edge in edges:
                if edge.pathway is Pathway.TRAIN:
                    self.assertTrue(self.city.locations[edge.start].is_station)
                    self.assertTrue(self.city.locations[edge.end].is_station)

    def test_walking_and_driving_respect_pathway_restrictions(self) -> None:
        """Walkers avoid roads and rail while drivers stay on roads."""
        when = datetime(2026, 6, 15, 10, 0)
        walk_routes = self.city.find_routes(
            "Old Town", "Central Station", when, TravelMode.WALKING, limit=3
        )
        drive_routes = self.city.find_routes(
            "Old Town", "Central Station", when, TravelMode.DRIVING, limit=3
        )
        self.assertTrue(walk_routes)
        self.assertTrue(drive_routes)
        self.assertTrue(
            all(leg.edge.pathway is Pathway.PAVEMENT for leg in walk_routes[0].legs)
        )
        self.assertTrue(
            all(leg.edge.pathway is Pathway.ROAD for leg in drive_routes[0].legs)
        )
        self.assertTrue(
            all(
                not leg.edge.highway
                for leg in self.city.find_routes(
                    "Old Town",
                    "Airport Station",
                    when,
                    TravelMode.WALKING,
                    limit=3,
                )[0].legs
            )
        )

    def test_scaled_distances_make_local_walks_practical(self) -> None:
        """A short neighborhood walk is measured in minutes, not several hours."""
        routes = self.city.find_routes(
            "Old Town",
            "Central Station",
            datetime(2026, 6, 15, 10, 0),
            TravelMode.WALKING,
            limit=1,
        )
        self.assertAlmostEqual(routes[0].distance_km, 8.13, places=1)
        self.assertLess(routes[0].duration.total_seconds(), 2 * 60 * 60)

    def test_direct_peak_hour_train_corridor_competes_with_driving(self) -> None:
        """A through train ride avoids repeated stop waits and peak-road slowdown."""
        when = datetime(2026, 6, 15, 8, 0)
        transit = self.city.find_routes(
            "Central Station", "Airport Station", when, TravelMode.TRANSIT, limit=1
        )[0]
        driving = self.city.find_routes(
            "Central Station", "Airport Station", when, TravelMode.DRIVING, limit=1
        )[0]
        self.assertLess(transit.duration, driving.duration)
        self.assertTrue(all(leg.edge.pathway is Pathway.TRAIN for leg in transit.legs))
        self.assertTrue(
            all(
                previous.arrival == current.departure
                for previous, current in zip(transit.legs, transit.legs[1:])
            )
        )

    def test_transit_route_combines_walk_and_train_edges(self) -> None:
        """A transit trip can walk to a station, ride, and walk to its destination."""
        routes = self.city.find_routes(
            "Old Town",
            "Airport Village",
            datetime(2026, 6, 15, 8, 7),
            TravelMode.TRANSIT,
            limit=3,
        )
        self.assertTrue(routes)
        pathway_types = {leg.edge.pathway for leg in routes[0].legs}
        self.assertIn(Pathway.TRAIN, pathway_types)
        self.assertIn(Pathway.PAVEMENT, pathway_types)
        self.assertNotIn(Pathway.ROAD, pathway_types)

    def test_train_departures_and_weekday_rush_hour_change_timing(self) -> None:
        """Train times round up to service intervals and weekday traffic is slower."""
        self.assertEqual(
            self.city.next_train_departure(datetime(2026, 6, 15, 8, 7)),
            datetime(2026, 6, 15, 8, 15),
        )
        self.assertEqual(
            self.city.next_train_departure(datetime(2026, 6, 15, 8, 15, 1)),
            datetime(2026, 6, 15, 8, 30),
        )
        self.assertEqual(
            self.city.next_train_departure(datetime(2026, 6, 15, 23, 0)),
            datetime(2026, 6, 16, 6, 0),
        )
        road = next(
            edge
            for edge in self.city.adjacency["Old Town"]
            if edge.end == "Market Square" and edge.pathway is Pathway.ROAD
        )
        rush = self.city._leg_for(road, datetime(2026, 6, 15, 8, 0))
        midday = self.city._leg_for(road, datetime(2026, 6, 15, 12, 0))
        self.assertGreater(rush.arrival - rush.departure, midday.arrival - midday.departure)

    def test_weather_forecast_is_repeatable_and_risk_matches_pathway_vulnerability(self) -> None:
        """Date-driven forecasts are stable and each weather hazard has a pathway policy."""
        winter_evening = datetime(2026, 1, 15, 20, 0)
        self.assertEqual(
            simulate_weather(winter_evening),
            simulate_weather(winter_evening),
        )
        self.assertEqual(simulate_weather(winter_evening, "snow").condition, "snow")
        winter_conditions = {
            simulate_weather(datetime(2026, 1, day, 9)).condition
            for day in range(1, 29)
        }
        summer_conditions = {
            simulate_weather(datetime(2026, 7, day, 9)).condition
            for day in range(1, 29)
        }
        self.assertIn("snow", winter_conditions)
        self.assertNotIn("snow", summer_conditions)
        exposed_road = next(
            edge
            for edge in self.city.adjacency["Old Town"]
            if edge.end == "Southbank" and edge.pathway is Pathway.ROAD
        )
        train = next(
            edge
            for edge in self.city.adjacency["Central Station"]
            if edge.end == "Riverside Station" and edge.pathway is Pathway.TRAIN
        )
        vulnerable_path = next(
            edge
            for edge in self.city.adjacency["Botanical Gardens"]
            if edge.end == "Hilltop" and edge.pathway is Pathway.PAVEMENT
        )
        self.assertEqual(evaluate_weather_risk(exposed_road, "storm").level, "high")
        self.assertEqual(evaluate_weather_risk(train, "wind").level, "moderate")
        self.assertEqual(evaluate_weather_risk(vulnerable_path, "snow").level, "high")
        self.assertIsNone(evaluate_weather_risk(exposed_road, "sun"))

    def test_weather_routing_applies_delay_penalties_and_avoids_storm_hazards(self) -> None:
        """Weather-aware routing adds time for rain and avoids high-risk edges."""
        when = datetime(2026, 6, 15, 12, 0)
        clear_route = self.city.find_routes(
            "Old Town", "Southbank", when, TravelMode.DRIVING,
            weather_override="sun", limit=1,
        )[0]
        rainy_route = self.city.find_routes(
            "Old Town", "Southbank", when, TravelMode.DRIVING,
            limit=1, weather_override="rain", consider_weather=True,
        )[0]
        storm_route = self.city.find_routes(
            "Old Town", "Southbank", when, TravelMode.DRIVING,
            limit=1, weather_override="storm", consider_weather=True,
        )[0]
        self.assertGreater(rainy_route.duration, clear_route.duration)
        self.assertNotIn("Old Bridge", storm_route.summary())

    def test_scheduled_weekday_delay_changes_the_initial_route(self) -> None:
        """A scheduled rush-hour penalty makes a faster detour preferable."""
        rush_route = self.city.find_routes(
            "West End",
            "City Hospital",
            datetime(2026, 6, 15, 8, 0),
            TravelMode.DRIVING,
            limit=1,
        )[0]
        midday_route = self.city.find_routes(
            "West End",
            "City Hospital",
            datetime(2026, 6, 15, 12, 0),
            TravelMode.DRIVING,
            limit=1,
        )[0]
        self.assertNotEqual(rush_route.locations, midday_route.locations)
        self.assertIn("Medical Boulevard", midday_route.summary())
        self.assertNotIn("Medical Boulevard", rush_route.summary())

    def test_route_duration_includes_initial_train_wait(self) -> None:
        """A trip starting at a station counts the wait before its first train."""
        requested = datetime(2026, 6, 15, 8, 7)
        routes = self.city.find_routes(
            "Central Station",
            "Riverside Station",
            requested,
            TravelMode.TRANSIT,
            limit=1,
        )
        self.assertTrue(routes)
        route = routes[0]
        self.assertEqual(route.departure, requested)
        self.assertGreater(route.legs[0].departure, requested)
        self.assertEqual(route.duration, route.arrival - requested)

    def test_arrival_deadline_returns_routes_that_arrive_on_time(self) -> None:
        """Arrival-time planning finds a feasible departure before its deadline."""
        deadline = datetime(2026, 6, 15, 9, 0)
        routes = self.city.routes_arriving_by(
            "Old Town",
            "Central Station",
            deadline,
            TravelMode.TRANSIT,
            Preferences(),
        )
        self.assertTrue(routes)
        self.assertTrue(all(route.arrival <= deadline for route in routes))
        self.assertTrue(all(route.departure <= route.arrival for route in routes))

    def test_toll_preference_excludes_toll_edges(self) -> None:
        """An avoid-tolls preference is enforced during route expansion."""
        routes = self.city.find_routes(
            "Harbor Station",
            "Airport Station",
            datetime(2026, 6, 15, 12, 0),
            TravelMode.DRIVING,
            Preferences(avoid_tolls=True),
            limit=3,
        )
        self.assertTrue(routes)
        self.assertTrue(
            all(not leg.edge.toll for route in routes for leg in route.legs)
        )

    def test_selected_route_renders_as_valid_standalone_svg(self) -> None:
        """The map output is valid SVG and includes the route-highlight styling."""
        route = self.city.find_routes(
            "Old Town",
            "Central Station",
            datetime(2026, 6, 15, 10, 0),
            TravelMode.WALKING,
            limit=1,
        )[0]
        with TemporaryDirectory() as temporary_directory:
            output = render_svg(
                self.city, route, Path(temporary_directory) / "route.svg"
            )
            root = ElementTree.parse(output).getroot()
            self.assertTrue(root.tag.endswith("svg"))
            self.assertIn("#d62828", output.read_text(encoding="utf-8"))


class WebApiTests(unittest.TestCase):
    """Verify that the browser API adapts the existing simulator correctly."""

    def setUp(self) -> None:
        manual_obstructions.clear()

    def tearDown(self) -> None:
        manual_obstructions.clear()

    def test_city_response_contains_fixed_nodes_and_each_pathway_once(self) -> None:
        response = get_city()
        self.assertEqual(len(response.locations), 24)
        self.assertEqual(
            next(
                location.x
                for location in response.locations
                if location.name == "Central Station"
            ),
            43,
        )
        endpoint_types = [
            (path.start, path.end, path.pathway, path.name)
            for path in response.pathways
        ]
        self.assertEqual(len(endpoint_types), len(set(endpoint_types)))
        self.assertEqual(
            {path.pathway for path in response.pathways},
            {"road", "pavement", "train"},
        )
        self.assertTrue(response.obstructions)

    def test_mid_journey_blockage_uses_mode_specific_transition_rules(self) -> None:
        """Walking reverses at its exact point; transit and cars reach the next node."""
        cases = (
            ("walking", "Old Town", "Market Square", "pavement", "Central Station",
             "Old Town", 0.0),
            ("driving", "Old Town", "Market Square", "road", "Central Station",
             "Market Square", 3.0),
            ("transit", "Central Station", "Riverside Station", "train", "Airport Station",
             "Riverside Station", 0.0),
        )
        for mode, edge_start, edge_end, pathway, destination, switch_node, reaction in cases:
            with self.subTest(mode=mode):
                result = calculate_reroute(
                    RerouteRequest(
                        destination=destination,
                        time=datetime(2026, 6, 15, 10, 0),
                        mode=mode,
                        current_edge_start=edge_start,
                        current_edge_end=edge_end,
                        current_edge_pathway=pathway,
                        progress=0.4,
                        incident=IncidentRequest(
                            start=edge_start,
                            end=edge_end,
                            pathway=pathway,
                            kind="block",
                        ),
                    )
                )
                self.assertEqual(result.switch_node, switch_node)
                self.assertEqual(result.reaction_minutes, reaction)
                self.assertEqual(result.route.locations[0], switch_node)
                self.assertTrue(
                    all(
                        not (
                            leg.start == edge_start
                            and leg.end == edge_end
                            and leg.pathway == pathway
                        )
                        for leg in result.route.legs
                    )
                )
        walking = calculate_reroute(
            RerouteRequest(
                destination="Central Station",
                time=datetime(2026, 6, 15, 10, 0),
                mode="walking",
                current_edge_start="Old Town",
                current_edge_end="Market Square",
                current_edge_pathway="pavement",
                progress=0.4,
                incident=IncidentRequest(
                    start="Old Town",
                    end="Market Square",
                    pathway="pavement",
                    kind="block",
                ),
            )
        )
        self.assertAlmostEqual(
            walking.approach_start_x,
            20.0,
        )

    def test_reroute_keeps_previously_injected_blockages_active(self) -> None:
        """A later detour avoids both the new incident and earlier live incidents."""
        result = calculate_reroute(
            RerouteRequest(
                destination="Central Station",
                time=datetime(2026, 6, 15, 12, 0),
                mode="driving",
                current_edge_start="Old Town",
                current_edge_end="Market Square",
                current_edge_pathway="road",
                progress=0.4,
                incident=IncidentRequest(
                    start="Old Town",
                    end="Market Square",
                    pathway="road",
                    kind="block",
                ),
                additional_incidents=[
                    IncidentRequest(
                        start="Market Square",
                        end="Central Station",
                        pathway="road",
                        kind="block",
                    )
                ],
            )
        )
        self.assertTrue(
            all(
                not (
                    {leg.start, leg.end}
                    in (
                        {"Old Town", "Market Square"},
                        {"Market Square", "Central Station"},
                    )
                    and leg.pathway == "road"
                )
                for leg in result.route.legs
            )
        )
        self.assertIn("user-placed blockage", result.route.explanation)

    def test_route_response_includes_timing_and_map_segments(self) -> None:
        response = calculate_routes(
            TripRequest(
                start="old town",
                destination="Central Station",
                time_kind="departure",
                time=datetime(2026, 6, 15, 10, 0),
                mode="walking",
            )
        )
        self.assertTrue(response.routes)
        route = response.routes[0]
        self.assertEqual(route.locations[0], "Old Town")
        self.assertEqual(route.locations[-1], "Central Station")
        self.assertGreater(route.duration_minutes, 0)
        self.assertTrue(route.legs)
        self.assertTrue(all(leg.pathway == "pavement" for leg in route.legs))
        self.assertTrue(route.explanation)
        self.assertLessEqual(len(route.explanation.split(". ")), 3)

    def test_route_explanations_use_preferences_and_trip_conditions(self) -> None:
        toll_avoiding = calculate_routes(
            TripRequest(
                start="Harbor Station",
                destination="Airport Station",
                time=datetime(2026, 6, 15, 12, 0),
                mode="driving",
                avoid_tolls=True,
            )
        )
        self.assertTrue(
            all("avoid toll roads" in route.explanation for route in toll_avoiding.routes)
        )

        rush_hour = calculate_routes(
            TripRequest(
                start="West End",
                destination="City Hospital",
                time=datetime(2026, 6, 15, 8, 0),
                mode="driving",
            )
        )
        self.assertTrue(
            any("rush-hour traffic" in route.explanation for route in rush_hour.routes)
        )

        direct_train = calculate_routes(
            TripRequest(
                start="Central Station",
                destination="Airport Station",
                time=datetime(2026, 6, 15, 8, 0),
                mode="transit",
            )
        )
        self.assertIn("direct Central Line train corridor", direct_train.routes[0].explanation)

        limited = calculate_routes(
            TripRequest(
                start="Old Town",
                destination="Central Station",
                time=datetime(2026, 6, 15, 10, 0),
                mode="walking",
                limit=1,
            )
        )
        self.assertNotIn("only valid path", limited.routes[0].explanation)

    def test_weather_risks_and_route_explanations_follow_user_setting(self) -> None:
        forecast = get_weather(datetime(2026, 6, 15, 12, 0), "storm")
        self.assertEqual(forecast.condition, "storm")
        self.assertTrue(any(item.level == "high" for item in forecast.risk_edges))

        ignored = calculate_routes(
            TripRequest(
                start="Old Town",
                destination="Southbank",
                time=datetime(2026, 6, 15, 12, 0),
                mode="driving",
                weather_override="storm",
                consider_weather=False,
            )
        )
        aware = calculate_routes(
            TripRequest(
                start="Old Town",
                destination="Southbank",
                time=datetime(2026, 6, 15, 12, 0),
                mode="driving",
                weather_override="storm",
                consider_weather=True,
            )
        )
        self.assertIn("weather risks were ignored", ignored.routes[0].explanation)
        self.assertNotIn("Old Bridge", aware.routes[0].summary)
        self.assertIn("predicted weather obstruction", aware.routes[0].explanation)

    def test_schedule_reference_is_derived_from_service_rules(self) -> None:
        schedule = get_schedule()
        self.assertEqual(len(schedule["weekly_public_transport"]), 2)
        self.assertEqual(len(schedule["weekly_traffic"]), 2)
        self.assertEqual(len(schedule["annual_maintenance"]), len(CityMap.ANNUAL_MAINTENANCE))
        annual = schedule["annual_maintenance"][0]
        self.assertEqual(annual["starts_on"], "2026-07-06")
        self.assertTrue(any(item.starts_on and item.ends_on for item in get_city().obstructions))
        maintenance = CityMap.ANNUAL_MAINTENANCE[0]
        campus_road = next(
            edge
            for edge in CityMap().adjacency["University"]
            if edge.end == "City Hospital" and edge.pathway is Pathway.ROAD
        )
        self.assertTrue(
            maintenance.is_active(
                campus_road, datetime(2026, 7, 6, 10, 0), TravelMode.DRIVING
            )
        )
        self.assertFalse(
            maintenance.is_active(
                campus_road, datetime(2026, 7, 11, 10, 0), TravelMode.DRIVING
            )
        )

    def test_manual_pathway_state_cycles_and_changes_route_calculation(self) -> None:
        """Map state is returned by the API and a blocked edge is avoided."""
        request = ManualObstructionRequest(
            start="Old Town",
            end="Market Square",
            pathway="road",
            kind="delay",
        )
        update_manual_obstruction(request)
        self.assertEqual(get_city().manual_obstructions[0].kind, "delay")

        update_manual_obstruction(
            ManualObstructionRequest(
                start=request.start,
                end=request.end,
                pathway=request.pathway,
                kind="block",
            )
        )
        route = calculate_routes(
            TripRequest(
                start="Old Town",
                destination="Market Square",
                time=datetime(2026, 6, 15, 12, 0),
                mode="driving",
            )
        ).routes[0]
        self.assertFalse(
            any(leg.start == "Old Town" and leg.end == "Market Square" for leg in route.legs)
        )
        self.assertIn("user-placed blockage", route.explanation)

        update_manual_obstruction(
            ManualObstructionRequest(
                start=request.start,
                end=request.end,
                pathway=request.pathway,
                kind="normal",
            )
        )
        self.assertFalse(get_city().manual_obstructions)

    def test_transit_request_uses_the_simulator_public_transit_mode(self) -> None:
        response = calculate_routes(
            TripRequest(
                start="Old Town",
                destination="Airport Village",
                time=datetime(2026, 6, 15, 8, 7),
                mode="transit",
            )
        )
        self.assertTrue(response.routes)
        self.assertIn("train", {leg.pathway for leg in response.routes[0].legs})

    def test_unknown_location_returns_a_clear_api_validation_error(self) -> None:
        with self.assertRaises(HTTPException) as error:
            calculate_routes(
                TripRequest(
                    start="Not a city location",
                    destination="Central Station",
                    time=datetime(2026, 6, 15, 10, 0),
                )
            )
        self.assertEqual(error.exception.status_code, 422)
        self.assertIn("Unknown location", error.exception.detail)


if __name__ == "__main__":
    unittest.main()
