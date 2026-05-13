const SunCalc = require('suncalc');

// ============================================================
// POSITIE VAN HET BALKON
// ============================================================
// Westerdoksdijk 251b, 2e verdieping (~7m boven maaiveld)
// Balkon kijkt naar het westen — MEEST RECHTSE (= meest noordelijke)
// balkon van het gebouw. Dit is essentieel: de positie langs het
// gebouw bepaalt de hoek waaronder het zuidgebouw blokkeert.
//
// WGS84 exact berekend via Kadaster RD-transformatie van:
//   RDX=121327.3774665324  RDY=488669.9902657811
//
// Kalibratie hint: als de zon-aan/uit tijden structureel te vroeg
// of te laat zijn, pas dan BALCONY.lat aan (+ = meer noord = meer rechts).
const BALCONY = {
  lat: 52.38480883,  // exact via Leaflet kaart tool
  lng: 4.89250117,
  heightM: 7,        // 2e verdieping NL ≈ 7m boven maaiveld
};

// ============================================================
// GEBOUWMODEL — corner-based
// ============================================================
// Elk gebouw is gedefinieerd door twee hoekpunten van de gevel
// die het dichtst bij het balkon ligt. De code berekent:
//   1. De azimuth-range van die gevel (van welke hoek tot welke hoek)
//   2. De loodrechte afstand van het balkon tot de gevel
//   3. De kijkhoek (elevation) naar de bovenkant van het gebouw
//
// Oriëntatie vanuit balkon (kijkend naar het westen):
//   Links = Zuid, Rechts = Noord
//
// KALIBRATIE: als een gebouw te vroeg/laat blokkeert:
//   - Schuif cornerA/cornerB dichter bij of verder weg
//   - Of verschuif de hoekpunten links/rechts langs de gevel
//
const BUILDINGS = [
  {
    name: 'gebouw links',
    description: 'Gebouw links van balkon — 34.3m. Exact via kaart.',
    cornerA: { lat: 52.38461728, lng: 4.89243592 },
    cornerB: { lat: 52.38462874, lng: 4.89215955 },
    heightM: 34.3,
  },
  {
    name: 'gebouw voor ons',
    description: 'Gebouw linksvoor — 34.3m. Exact via kaart.',
    cornerA: { lat: 52.38468277, lng: 4.89197977 },
    cornerB: { lat: 52.38486449, lng: 4.89199855 },
    heightM: 34.3,
  },
  {
    name: 'overkoepeling',
    description: 'Laag deel tussen voor en rechtsschuin — 10m. Exact via kaart.',
    cornerA: { lat: 52.38485958, lng: 4.89178389 },
    cornerB: { lat: 52.38498727, lng: 4.89180804 },
    heightM: 10.0,
  },
  {
    name: 'gebouw rechtsschuin',
    description: 'Hoogste gebouw rechtsschuin — 37m. Exact via kaart.',
    cornerA: { lat: 52.38494974, lng: 4.89222586 }, // oostkant zuidgevel
    cornerB: { lat: 52.38498573, lng: 4.89168942 }, // westkant zuidgevel
    heightM: 37.0,
  },
];

// Balkon kijkt naar het westen (270°), met een horizontaal zichtveld
// van ±90°. Zon achter 90°-270° (de oostkant) valt achter het eigen gebouw.
const BALCONY_FACING   = 270;
const BALCONY_HALF_FOV = 90;

// Oversteek: onderkant van het balkon van de verdieping erboven.
// 2D schaduwmodel: schaduwvlek = max(0, D − |sin(az)|·L) × max(0, B − |cos(az)|·L)
// waarbij L = plafond / tan(elevatie). Verlicht aandeel < 0.5 → NEE.
const OVERHANG_CEILING_M = 2.70; // hoogte plafond (= kamerhoogte woonkamer)
const OVERHANG_DEPTH_M   = 2.80; // diepte balkon (oost–west)
const OVERHANG_WIDTH_M   = 3.00; // breedte balkon (noord–zuid)

// ============================================================
// HULPFUNCTIES
// ============================================================
function toRad(deg) { return deg * Math.PI / 180; }
function toDeg(rad) { return rad * 180 / Math.PI; }

// Vlakke-aarde benadering (nauwkeurig genoeg voor <200m)
function toLocalXY(refLat, refLng, lat, lng) {
  const cosLat = Math.cos(toRad(refLat));
  return {
    x: (lng - refLng) * 111000 * cosLat, // oost positief
    y: (lat - refLat) * 111000,           // noord positief
  };
}

// Kompasrichting (0=N, 90=E, 180=S, 270=W) van balkon naar punt
function bearingDeg(balcony, lat, lng) {
  const p = toLocalXY(balcony.lat, balcony.lng, lat, lng);
  return (toDeg(Math.atan2(p.x, p.y)) + 360) % 360;
}

// Afstand van balkon tot gevel langs de azimuth-richting van de zon.
// Geeft de afstand t langs de straal, of null als de straal de gevel niet raakt.
// Dit is de correcte afstand voor de elevatie-berekening — niet de loodrechte afstand.
function rayDistToFace(balcony, cornerA, cornerB, sunAzimuthDeg) {
  const a  = toLocalXY(balcony.lat, balcony.lng, cornerA.lat, cornerA.lng);
  const b  = toLocalXY(balcony.lat, balcony.lng, cornerB.lat, cornerB.lng);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const az = toRad(sunAzimuthDeg);
  const rx = Math.sin(az); // oost-component van de zonnestraal
  const ry = Math.cos(az); // noord-component van de zonnestraal
  // Snijtpunt: straal P(t)=(t·rx, t·ry) met segment Q(s)=A+s·(dx,dy)
  const denom = rx * dy - ry * dx;
  if (Math.abs(denom) < 1e-10) return null; // evenwijdig
  const t = (a.x * dy - a.y * dx) / denom;
  const s = (ry * a.x - rx * a.y) / denom;
  if (t <= 0 || s < 0 || s > 1) return null; // geen treffer op segment
  return t;
}

// Kijkhoek (elevation) omhoog naar de top van een gebouw op afstand distM
function elevationAngleDeg(distM, buildingTopM, observerM) {
  const h = buildingTopM - observerM;
  if (h <= 0) return -90;
  return toDeg(Math.atan2(h, distM));
}

// Converteer suncalc azimuth (0=south, richtsklok negatief) → kompas
function suncalcToCompass(azRad) {
  return (toDeg(azRad) + 180 + 360) % 360;
}

// Kortste hoekafstand tussen twee azimuths
function angularDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// ============================================================
// KERNBEREKENING
// ============================================================
function checkSun(date) {
  const pos        = SunCalc.getPosition(date, BALCONY.lat, BALCONY.lng);
  const sunElev    = toDeg(pos.altitude);
  const sunAzimuth = suncalcToCompass(pos.azimuth);

  if (sunElev < 0) {
    return result(false, 'Zon Onder', sunAzimuth, sunElev, null);
  }

  // Onder 5° is de zon te laag om het balkon nog nuttig te bereiken
  if (sunElev < 5) {
    return result(false, 'Zon bijna onder', sunAzimuth, sunElev, null);
  }

  if (angularDiff(sunAzimuth, BALCONY_FACING) > BALCONY_HALF_FOV) {
    return result(false, 'Ochtend — balkon kijkt west', sunAzimuth, sunElev, null);
  }

  for (const bld of BUILDINGS) {
    // Bereken de afstand langs de zon-straal tot het snijtpunt met de gevel.
    // Dit is de exacte blokkeringsafstand — nauwkeuriger dan de loodrechte afstand.
    const dist = rayDistToFace(BALCONY, bld.cornerA, bld.cornerB, sunAzimuth);
    if (dist === null) continue; // straal raakt gevel niet

    const maxElevAngle = elevationAngleDeg(dist, bld.heightM, BALCONY.heightM);

    if (sunElev < maxElevAngle) {
      const azA = bearingDeg(BALCONY, bld.cornerA.lat, bld.cornerA.lng);
      const azB = bearingDeg(BALCONY, bld.cornerB.lat, bld.cornerB.lng);
      return result(false, `Geblokkeerd door ${bld.name}`, sunAzimuth, sunElev, {
        name: bld.name,
        description: bld.description,
        distanceM: Math.round(dist),
        buildingElevation: Math.round(maxElevAngle * 10) / 10,
        cornerAzimuth: { A: Math.round(azA), B: Math.round(azB) },
      });
    }
  }

  // Oversteek: 2D schaduwmodel — schaduwvlek op balkondvloer (diepte × breedte).
  // L = hoeveel meter de schaduwrand reikt bij deze elevatie.
  // Verlicht aandeel < 50% → NEE (te weinig balkon in de zon).
  const L  = OVERHANG_CEILING_M / Math.tan(toRad(sunElev));
  const sx = Math.abs(Math.sin(toRad(sunAzimuth))) * L; // schaduwdiepte oost–west
  const sy = Math.abs(Math.cos(toRad(sunAzimuth))) * L; // schaduwdiepte noord–zuid
  const shadowArea       = Math.max(0, OVERHANG_DEPTH_M - sx) * Math.max(0, OVERHANG_WIDTH_M - sy);
  const illuminatedFraction = 1 - shadowArea / (OVERHANG_DEPTH_M * OVERHANG_WIDTH_M);

  if (illuminatedFraction < 0.65) {
    return result(false, 'Oversteek balkon', sunAzimuth, sunElev, null, illuminatedFraction);
  }

  return result(true, 'Zon schijnt op het balkon!', sunAzimuth, sunElev, null, illuminatedFraction);
}

function result(hasSun, reason, sunAzimuth, sunElevation, blockedBy, illuminatedFraction = null) {
  return { hasSun, reason, sunAzimuth, sunElevation, blockedBy, illuminatedFraction };
}

// ============================================================
// TIJDLIJN
// ============================================================
function getDayTimeline(date) {
  const times    = SunCalc.getTimes(date, BALCONY.lat, BALCONY.lng);
  const timeline = [];
  const current  = new Date(times.sunrise);
  const end      = new Date(times.sunset);

  while (current <= end) {
    const r = checkSun(new Date(current));
    timeline.push({
      time:         new Date(current).toISOString(),
      hasSun:       r.hasSun,
      reason:       r.reason,
      sunElevation: Math.round(r.sunElevation * 10) / 10,
      sunAzimuth:   Math.round(r.sunAzimuth * 10) / 10,
    });
    current.setMinutes(current.getMinutes() + 10);
  }

  return {
    sunrise:    times.sunrise.toISOString(),
    sunset:     times.sunset.toISOString(),
    solarNoon:  times.solarNoon.toISOString(),
    timeline,
  };
}

module.exports = { checkSun, getDayTimeline, BUILDINGS, BALCONY };
