// Shared by the Node pipeline and the browser generator (no Node APIs here).
// Keeps only what the pipeline uses, and turns OSM API /map responses into Overpass "out body geom" shape.
const WANT_WAY = (t) => t.building || t['building:part'] || t.highway || t.leisure || t.landuse || t.natural || t.waterway || t.railway || t.man_made === 'bridge' || t.water;
const WANT_NODE = (t) => t.natural === 'tree' || /^(street_lamp|bus_stop|crossing)$/.test(t.highway || '') ||
  /^(cafe|restaurant|fast_food|bench|bar|pub)$/.test(t.amenity || '') || /^(station|stop|halt)$/.test(t.railway || '') ||
  /^(station|platform|stop_position)$/.test(t.public_transport || '') || t.entrance || /^(neighbourhood|suburb|quarter)$/.test(t.place || '');
const WANT_REL = (t) => t.building || t['building:part'] || t.leisure || t.natural === 'water' || t.waterway || t.water;

export function filterElements(elements) {
  return elements.filter((e) => {
    const t = e.tags || {};
    if (e.type === 'node') return WANT_NODE(t);
    if (e.type === 'way') return WANT_WAY(t);
    return WANT_REL(t);
  });
}

// elementsLists: arrays of raw OSM API elements (from several tiles / relation fetches).
export function normalizeOsmApi(elementsLists) {
  const nodes = new Map(), ways = new Map(), rels = new Map();
  for (const els of elementsLists) for (const e of els) (e.type === 'node' ? nodes : e.type === 'way' ? ways : rels).set(e.id, e);
  const geomOf = (w) => w.nodes.map((id) => nodes.get(id)).filter(Boolean).map((n) => ({ lat: n.lat, lon: n.lon }));
  const out = [];
  for (const n of nodes.values()) if (n.tags) out.push({ type: 'node', id: n.id, lat: n.lat, lon: n.lon, tags: n.tags });
  for (const w of ways.values()) out.push({ type: 'way', id: w.id, nodes: w.nodes, tags: w.tags || {}, geometry: geomOf(w) });
  for (const r of rels.values()) out.push({
    type: 'relation', id: r.id, tags: r.tags || {},
    members: r.members.map((m) => ({ ...m, geometry: m.type === 'way' && ways.get(m.ref) ? geomOf(ways.get(m.ref)) : undefined })),
  });
  return filterElements(out);
}
export const wantedRelation = (r) => r.tags && r.tags.type === 'multipolygon' && (r.tags.building || r.tags['building:part'] || r.tags.leisure || r.tags.natural === 'water' || r.tags.waterway || r.tags.water);
