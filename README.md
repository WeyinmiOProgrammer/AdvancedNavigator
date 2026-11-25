# AdNav - Advanced Navigation App

## Project status:

The project currently demonstrates: optimal route selection, route journey simulation including simulating dynamic rerouting, basic weather simulation

The project does not use real world locations.

## Technology stack:

#### Frontend

HTML5
CCS3
JavaScript 
Fetch API

#### Backend

Python
FastAPI
Uvicorn
Pydantic


## Operating instructions:

To use the app, run `python -m pip install -r requirements.txt` in the terminal, followed by `python -m uvicorn app:app --reload` and then open http://localhost:8000/ in a browser.

Most of the app functions similar to other navigation apps such as Google Maps. The starting points and destination can be either directly typed or selected from a dropdown menu and other initial requirements and settings for routes can be selected in the top menu. 

At any point, delays or obstructions can be added between any two adjacent locations on the map where the route is displayed. These can be added either directly by clicking on the specific path on the map (1 click for a delay, 2 clicks for an obstruction, 3 clicks to remove) or in the simulation menu (below the map) by choosing from a list of location-pairs. Random delays and obstructions can also be triggered during a simulation, allowing the testing of dynamic rerouting.

To test that the app has been set up correctly, run `python -m unittest -v` in the terminal. 


## Version history:

2.2.0 - Added weather simulation. 

2.1.2 - Added map zoom. Added simple route explanations.

2.1.1 - Made different map elements more distinct to reduce confusion between different parts of map. 

2.1.0 - Greatly improved journey simulation

2.0.0 - Added Journey simulation, including testing randomly occuring delays and obstructions.

1.0.0 - Added GUI. 

0.1.0 - Python code with no UI. Determines optimal routes between two locations and generates an SVG image of the route.

## AI usage: 

A lot of the programming was done using Github Copilot. Gemini was used to rephrase and develop programming prompts before they were given to Github Copilot. 

#### e.g. 1 

##### Instruction to Gemini

Rephrase the following prompt for clarity:
"Make the following changes to the application:
- reduce the times taken for public transit and walking to travel. currently, both take significantly longer than driving does, whereas in real life they would be at most a few hours slower and sometimes faster depending on the start and end locations.
- allow users to manually add and remove blockage and delay points by clicking on the edges between the nodes - click once for a delay, a second time turns it into a blockage, a third time removes it again
- allow the users to alter the simulation settings and set blockage and delay points before the simulation starts
"

##### Response

Here is a clearer, more structured version of your prompt, followed by a few helpful technical additions you might want to consider so the interactive map controls and speed balancing work seamlessly.

Rephrased Prompt

Objective:
Update the FastAPI navigation simulation and web frontend to balance travel speeds across transport modes, allow interactive map-based obstacle placement, and support pre-simulation setup. Add clear inline comments explaining the updated speed calculations and edge-clicking interactions.
1. Realistic Travel Speed Balancing
• Adjust the base speeds and transfer penalties for walking and public transit so they are more realistic compared to driving.
• Ensure that public transit (especially trains on direct corridors) can match or beat driving during peak traffic or on cross-city routes, and that short-to-medium walking trips do not produce exaggerated multi-hour durations.
2. Interactive Map Edge Toggling (Delays & Blockages)
• Allow users to manually add, modify, and remove obstructions directly on the map by clicking any pathway (edge) between two nodes.
• Implement a three-click cycle on each edge:
	• 1st click: Applies a delay (speed penalty) to the edge and displays a warning indicator.
	• 2nd click: Upgrades the edge to a full blockage (impassable) and updates the visual indicator.
	• 3rd click: Clears the obstruction and restores the edge to normal.
• Ensure these manual changes immediately sync with the FastAPI backend so route calculations reflect the updated network state.
3. Pre-Simulation Configuration & Setup
• Allow users to configure simulation parameters (such as simulation playback speed) and place manual delays or blockages on the map before calculating routes or starting a journey simulation.
• Keep edge-clicking active both before and during a live simulation so testers can set up scenarios in advance or trigger new disruptions mid-journey.

Suggested Additions to Consider

Adding a few small guardrails will prevent UI confusion when users start clicking directly on the map:
• Wider Click Targets for Edges: Thin SVG or Canvas lines can be hard to click accurately. Specify adding an invisible, wider hit-area around each edge so users can click pathways easily with a mouse or trackpad.
• Accessible Keyboard Alternative: Keep or sync the edge state with your testing dropdown so keyboard-only and screen-reader users can still cycle an edge between Normal → Delay → Blocked without needing a mouse.
• Clear Map Legend & Cursor Hints: Update the map legend to show the exact visual styling for normal, delayed, and blocked edges, and change the cursor to a pointer when hovering over clickable pathways.
Would you like me to merge these suggested additions into the prompt above, or generate the updated Python and HTML code with these changes applied?

#### e.g. 2

##### Instruction to Github Copilot

Objective:
Extend the existing FastAPI and web-based navigation application to include live journey simulation, scheduled disruptions, and realistic dynamic rerouting. Include clear inline comments explaining how time progression, obstacle scheduling, and mode-specific rerouting work.
1. Interactive Journey Simulation & Playback Controls
• Once a user selects a route, display a "Start Journey Simulation" button on the frontend.
• Animate a moving marker (representing the user or vehicle) travelling along the selected route on the map, accompanied by a live simulated clock and dynamically updated ETA.
• Include accessible playback controls (Play/Pause, Reset, and a Simulation Speed selector such as 1x, 5x, or 10x) so long journeys can be tested quickly.
2. Scheduled Obstructions & Hindrances
• Implement a scheduling system for predictable network disruptions—such as weekday rush-hour traffic, planned roadworks, or weather hazards—defined by specific days of the week and time windows.
• Each obstruction must either block a pathway completely or apply a speed penalty (slowing down travel) for specific modes of transport.
• Update the FastAPI pathfinding engine so initial route calculations automatically account for scheduled obstructions based on the trip's date and time, rendering warning icons on affected pathways on the map.
3. Custom Testing Panel & Unscheduled Obstructions
• Add an accessible "Simulation Testing Panel" to the frontend interface that allows a tester to inject unscheduled obstructions (e.g., sudden accidents, flash flooding, or signal failures) during a live journey.
• Provide controls to either trigger a random incident ahead or select a specific pathway from a dropdown and click "Trigger Blockage" or "Trigger Delay" on demand.
4. Mode-Specific Dynamic Rerouting Logic
When an unscheduled obstruction affects the active route ahead of the moving marker, the frontend must query the FastAPI backend to recalculate a new optimal route using mode-specific transition rules:
• Walking: The marker reroutes immediately from its exact current position (turning around mid-edge if necessary).
• Public Transport: Because trains and buses follow fixed stops, the marker must continue along its current edge until it reaches the next station/node, and then transition onto the newly calculated route.
• Driving (Cars): To realistically represent reaction time and finding a safe place to turn or take an exit, the marker must continue moving forward along its current road edge for a few simulated minutes (potentially reaching the next node) before switching onto the new route.
5. Visual Updates, Alerts & Automated Tests
• Map & Accessible Notifications: Visually display new obstacles on the map, smoothly highlight the updated route, and announce the reroute reason and new ETA inside an aria-live="polite" alert banner.
• Automated Unit Tests: Extend the Python unittest suite to automatically verify that scheduled delays alter initial route recommendations and that mid-journey blockages trigger valid detours according to the mode-specific rules.

##### Response

Implemented live journey simulation with an animated marker, simulated clock, ETA, and accessible play/pause, reset, and speed controls in app.js and index.html.

Added weekday/time-based obstructions to route planning, map warnings, and a testing panel for injected blockages and delays. The reroute API preserves active incidents and applies walking, transit, and driving transition rules in app.py. Inline comments explain the scheduling, clock progression, and rerouting behavior.

Validation: all 15 unit tests pass; browser checks covered rerouting and playback controls, and the HTTP reroute endpoint was verified.