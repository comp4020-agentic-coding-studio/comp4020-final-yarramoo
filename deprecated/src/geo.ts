import { db } from "./db/index.ts";

export type Place = { postcode: string; locality: string; state: string; lat: number; lon: number };

export function lookupPostcode(pc: string): Place | null {
  const row = db.prepare("SELECT postcode, locality, state, lat, lon FROM postcodes WHERE postcode = ?").get(pc.trim());
  return (row as Place | undefined) ?? null;
}

export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

/** Bounding box around a point, for a cheap SQL prefilter (lat BETWEEN minLat AND maxLat AND lon BETWEEN ...). */
export function bbox(lat: number, lon: number, km: number) {
  const dLat = km / 111.32;
  const dLon = km / (111.32 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLon: lon - dLon, maxLon: lon + dLon };
}
