// Single source of truth for the pipeline. See DECISIONS.md for why each value was chosen.
export const BBOX = { south: 25.755, west: -80.197, north: 25.786, east: -80.182 };

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// Descriptive User-Agent per the Overpass usage policy. No personal data.
export const USER_AGENT = 'miami-3d-district-pipeline/0.1 (stylized 3D city demo; cached, single request)';

export const SIMPLIFY_TOLERANCE_M = 0.5;
export const MIN_BUILDING_AREA_M2 = 20;
export const LEVEL_HEIGHT_M = 3.5;
export const DEFAULT_HEIGHT_CORE_M = 45;   // used only when OSM has neither height nor levels
export const DEFAULT_HEIGHT_EDGE_M = 12;
// Core points (lat, lon) used for the distance-based default; buildings within CORE_RADIUS_M of either get the core default.
export const CORE_POINTS = [
  { name: 'Brickell core (Brickell Ave & SE 8th St)', lat: 25.7656, lon: -80.1918 },
  { name: 'Downtown core (Flagler St & SE 1st Ave)', lat: 25.7743, lon: -80.1903 },
];
export const CORE_RADIUS_M = 600;

// Fallback road widths (m) by highway type when OSM has no width or lanes tag.
export const ROAD_WIDTH_DEFAULTS = {
  motorway: 14, trunk: 12, primary: 12, secondary: 10, tertiary: 9, unclassified: 7,
  residential: 7, service: 5, living_street: 5, pedestrian: 6, motorway_link: 6, trunk_link: 6,
  primary_link: 6, secondary_link: 6, tertiary_link: 6,
  footway: 2, path: 2, cycleway: 2, steps: 2, track: 3, corridor: 2,
};
export const LANE_WIDTH_M = 3.3;
