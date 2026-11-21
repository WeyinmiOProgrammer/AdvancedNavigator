# Advanced Planning Navigation App
___
## Description:

This project is a prototype for a navigation application, intended to demonstrate ways the current functionality of navigation apps could be improved. The main goal is to allow users to plan journeys while accounting for potential obstructions or delays that may occur en route. The system currently allows users to simulate journeys between locations and determine alternate routes that could be taken if delays or obstructions occur in advance.
___
## Operating instructions:

To use the app, run `python -m pip install -r requirements.txt` in the terminal, followed by `python -m uvicorn app:app --reload` and then open http://localhost:8000/ in a browser.

Most of the app functions similar to other navigation apps such as Google Maps. The starting points and destination can be either directly typed or selected from a dropdown menu and other initial requirements and settings for routes can be selected in the top menu. 

At any point, delays or obstructions can be added between any two adjacent locations on the map where the route is displayed. These can be added either directly by clicking on the specific path on the map (1 click for a delay, 2 clicks for an obstruction, 3 clicks to remove) or in the simulation menu (below the map) by choosing from a list of location-pairs. Random delays and obstructions can also be triggered during a simulation, allowing the testing of dynamic rerouting.

To test that the app has been set up correctly, run `python -m unittest -v` in the terminal. 

___
## Version history:

0.1 - 