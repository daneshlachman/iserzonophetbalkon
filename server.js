const express = require('express');
const path = require('path');
const { checkSun, getDayTimeline, BALCONY } = require('./solar');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.static(path.join(__dirname, 'public')));

// Weer-cache: maximaal 5 minuten oud
let weatherCache = null;
let weatherCacheTime = 0;

// UV-cache: maximaal 30 minuten (OpenUV gratis tier = 50 req/dag)
let uvCache = null;
let uvCacheTime = 0;
const OPENUV_KEY = process.env.OPENUV_KEY || 'openuv-3deyurmp462q89-io';

async function getUV() {
  if (!OPENUV_KEY) return null;
  if (uvCache !== null && Date.now() - uvCacheTime < 5 * 60 * 1000) return uvCache;
  try {
    const res  = await fetch(
      `https://api.openuv.io/api/v1/uv?lat=${BALCONY.lat}&lng=${BALCONY.lng}&alt=${BALCONY.heightM}`,
      { headers: { 'x-access-token': OPENUV_KEY } }
    );
    const data = await res.json();
    uvCache     = data?.result?.uv ?? null;
    uvCacheTime = Date.now();
    return uvCache;
  } catch { return null; }
}

async function getWeather() {
  if (weatherCache && Date.now() - weatherCacheTime < 5 * 60 * 1000) {
    return weatherCache;
  }
  try {
    // Open-Meteo: temperatuur, neerslag + uurlijkse bewolkingsprognose
    const omUrl = `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${BALCONY.lat}&longitude=${BALCONY.lng}` +
      `&current=precipitation,weather_code,temperature_2m,uv_index` +
      `&hourly=cloud_cover,temperature_2m,uv_index&forecast_days=7` +
      `&timezone=Europe%2FAmsterdam`;
    const omJson = await (await fetch(omUrl)).json();
    const omData = omJson.current;

    // Bouw uurlijkse maps: bewolking, temperatuur, UV
    const hourlyCloud = {}, hourlyTemp = {}, hourlyUV = {};
    (omJson.hourly?.time ?? []).forEach((t, i) => {
      hourlyCloud[t] = omJson.hourly.cloud_cover[i];
      hourlyTemp[t]  = omJson.hourly.temperature_2m[i];
      hourlyUV[t]    = omJson.hourly.uv_index[i];
    });

    // Buienradar: dichtsbijzijnde meetstation → werkelijk gemeten zonkracht (W/m²)
    let sunpower = null, stationName = null, brTemp = null, brFeelTemp = null, brPrecip = null;
    try {
      const brRes  = await fetch('https://data.buienradar.nl/2.0/feed/json');
      const brData = await brRes.json();
      const stations = brData.actual.stationmeasurements;
      let minDist = Infinity;
      for (const s of stations) {
        if (s.lat == null || s.lon == null) continue;
        const d = Math.hypot(s.lat - BALCONY.lat, s.lon - BALCONY.lng);
        if (d < minDist) {
          minDist = d;
          sunpower   = s.sunpower      ?? null;
          stationName = s.stationname;
          brTemp     = s.temperature   ?? null;
          brFeelTemp = s.feeltemperature ?? null;
          brPrecip   = s.precipitation ?? null;
        }
      }
    } catch { /* Buienradar niet beschikbaar */ }

    weatherCache = { ...omData, sunpower, stationName, brTemp, brFeelTemp, brPrecip, hourlyCloud, hourlyTemp, hourlyUV };
    weatherCacheTime = Date.now();
    return weatherCache;
  } catch {
    return null;
  }
}

function weatherStatus(solar, weather, openUV = null) {
  // Temperatuur: Buienradar (echte meting) heeft voorkeur boven Open-Meteo (model)
  const rawTemp = weather?.brTemp ?? weather?.temperature_2m ?? null;
  const temp    = rawTemp != null ? Math.round(rawTemp) + '°C' : null;
  const feelTemp = weather?.brFeelTemp != null ? Math.round(weather.brFeelTemp) + '°C' : null;
  // UV: Open-Meteo gecorrigeerd met gemeten zonkwaliteit
  const rawUV   = weather?.uv_index ?? null;
  const rain    = weather?.brPrecip ?? weather?.precipitation ?? 0;
  const sunpower    = weather?.sunpower ?? null;
  const hourlyCloud = weather?.hourlyCloud ?? {};
  const hourlyTemp  = weather?.hourlyTemp  ?? {};
  const hourlyUV    = weather?.hourlyUV    ?? {};

  // Zonkwaliteit op basis van gemeten zonkracht vs theoretisch maximum op deze elevatie
  // Theor. max bij heldere lucht: ~1000 * sin(elevatie) W/m²
  let sunQuality = null;
  if (sunpower !== null && solar.sunElevation > 3) {
    const maxIrr = 1000 * Math.sin(solar.sunElevation * Math.PI / 180);
    sunQuality = Math.min(100, Math.max(0, Math.round(sunpower / maxIrr * 100)));
  } else if (sunpower !== null && solar.sunElevation <= 3) {
    sunQuality = 0; // nacht of zon te laag
  }

  // UV: OpenUV heeft voorkeur (nauwkeurig), anders Open-Meteo gecorrigeerd met zonkwaliteit
  const uvIndex = openUV != null
    ? Math.round(openUV * 10) / 10
    : (rawUV != null && sunQuality != null
        ? Math.round(rawUV * (sunQuality / 100) * 10) / 10
        : (rawUV != null ? Math.round(rawUV * 10) / 10 : null));

  // Bewolking bepalen op basis van zonkwaliteit (reëel gemeten via Buienradar)
  // < 35%: te bewolkt voor zinvolle zon op het balkon → NEE
  const isHeavilyOvercast = sunQuality !== null && sunQuality < 35 && solar.sunElevation > 5;

  // Nacht
  if (solar.sunElevation < 0) {
    return { ...solar, weatherIcon: '🌙', weatherLabel: 'Zon Onder', temp, feelTemp, rain, sunQuality, hourlyCloud, hourlyTemp, hourlyUV };
  }

  // Regen — zon sowieso weg
  if (rain > 0.2) {
    return { ...solar, hasSun: false, weatherIcon: '🌧', weatherLabel: 'Regen', temp, feelTemp, uvIndex, rain, sunQuality, hourlyCloud, hourlyTemp, hourlyUV };
  }

  // Zwaar bewolkt — gaat voor gebouwschaduw (gemeten, niet voorspeld)
  if (isHeavilyOvercast) {
    return { ...solar, hasSun: false, weatherIcon: '☁️', weatherLabel: 'Bewolkt', temp, feelTemp, uvIndex, rain, sunQuality, hourlyCloud, hourlyTemp, hourlyUV };
  }


  // Geen zon door oversteek of gebouw
  if (!solar.hasSun) {
    const isOverhang = solar.reason === 'Oversteek balkon';
    const icon = isOverhang ? '🏗' : '🏢';
    return { ...solar, weatherIcon: icon, weatherLabel: solar.reason, temp, feelTemp, uvIndex, rain, sunQuality, hourlyCloud, hourlyTemp, hourlyUV };
  }

  // Oversteek: percentage van balkondvloer in direct zonlicht
  const overhangPct = solar.illuminatedFraction !== null
    ? Math.round(solar.illuminatedFraction * 100)
    : 100;

  // Geometrisch zon — nuanceer op gemeten zonkwaliteit
  if (sunQuality !== null && sunQuality < 65) {
    return { ...solar, hasSun: true, partial: true, weatherIcon: '⛅', weatherLabel: 'Wisselend bewolkt', temp, feelTemp, uvIndex, rain, sunQuality, overhangPct, hourlyCloud, hourlyTemp, hourlyUV };
  }
  if (sunQuality !== null && sunQuality < 85) {
    return { ...solar, hasSun: true, partial: true, weatherIcon: '🌤', weatherLabel: 'Zon op balkon!', temp, feelTemp, uvIndex, rain, sunQuality, overhangPct, hourlyCloud, hourlyTemp, hourlyUV };
  }
  return { ...solar, hasSun: true, weatherIcon: '☀️', weatherLabel: 'Zon op balkon!', temp, feelTemp, uvIndex, rain, sunQuality, overhangPct, hourlyCloud, hourlyTemp, hourlyUV };
}

function weatherIcon(code, isDay) {
  if (code === undefined || code === null) return isDay ? '☀️' : '🌙';
  if (code === 0) return isDay ? '☀️' : '🌙';
  if (code <= 3) return '⛅';
  if (code <= 48) return '🌫️';
  if (code <= 67) return '🌧';
  if (code <= 77) return '🌨';
  if (code <= 82) return '🌦';
  return '⛈';
}

app.get('/api/now', async (req, res) => {
  const solar   = checkSun(new Date());
  const [weather, openUV] = await Promise.all([getWeather(), getUV()]);
  res.json(weatherStatus(solar, weather, openUV));
});

app.get('/api/today', (req, res) => {
  const date = req.query.date ? new Date(req.query.date) : new Date();
  res.json(getDayTimeline(date));
});

app.listen(PORT, () => console.log(`Zon-app op http://localhost:${PORT}`));
