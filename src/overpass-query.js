// The Overpass query for one area ({{BBOX}} = south,west,north,east). Same feature set as pipeline/fetch.mjs,
// plus neighborhood names for labels.
export const QUERY_TEMPLATE = `[out:json][timeout:120][bbox:{{BBOX}}];
(
  way["building"]; relation["building"];
  way["building:part"]; relation["building:part"];
  way["highway"];
  way["leisure"~"^(park|garden|playground|pitch|dog_park)$"]; relation["leisure"~"^(park|garden)$"];
  way["landuse"~"^(grass|recreation_ground|village_green)$"];
  way["natural"~"^(water|coastline|wood|scrub|beach|sand)$"]; relation["natural"="water"];
  way["waterway"~"^(river|riverbank|canal)$"];
  way["railway"]; way["man_made"="bridge"];
  node["natural"="tree"];
  node["highway"~"^(street_lamp|bus_stop|crossing)$"];
  node["amenity"~"^(cafe|restaurant|fast_food|bench|bar|pub)$"];
  node["railway"~"^(station|stop|halt)$"]; node["public_transport"~"^(station|platform|stop_position)$"];
  node["entrance"];
  node["place"~"^(neighbourhood|suburb|quarter)$"];
);
out body geom qt;`;
