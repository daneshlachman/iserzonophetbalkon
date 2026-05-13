# Zon op ons balkon? ☀️

**[iserzonophetbalkon.nl](https://iserzonophetbalkon.nl)** — een webapp die bijhoudt of er zon op het balkon van Westerdoksdijk 251b staat.

## Hoe werkt het?

De app combineert drie bronnen:

**1. Geometrisch zonmodel**
Op basis van de GPS-coördinaten van het balkon (2e verdieping, west-gericht) berekent de app elke minuut de positie van de zon. Vier omliggende gebouwen zijn nauwkeurig ingemeten via satellietkaarten, elk met twee hoekpunten en een hoogte. De app berekent via een ray-face intersection of de zonnestraal op dat moment door een van die gevels geblokkeerd wordt.

**2. Live weermeting (Buienradar)**
Het dichtstbijzijnde Buienradar-meetstation levert de actuele zonkracht in W/m². Die wordt vergeleken met het theoretisch maximum op die elevatie (1000 × sin(elevatie)) om een zonkwaliteit te berekenen. Onder 35% → NEE, ook als de geometrie vrij baan geeft.

**3. Weersverwachting (Open-Meteo)**
Voor de komende 7 dagen gebruikt de app uurlijkse bewolkingsvoorspellingen van Open-Meteo om een indicatief zonpercentage per tijdvak te tonen.

## Resultaat

De app toont:
- **JA** — zon op het balkon (> 65% zonkwaliteit)
- **HALF** — wisselend bewolkt (35–65%)
- **NEE** — geen zon (gebouw, bewolkt of nacht)

Plus een tijdlijn voor vandaag en de komende 7 dagen met zon/schaduw-vensters.

## Stack

- Node.js + Express
- [SunCalc](https://github.com/mourner/suncalc) voor zonpositie
- Buienradar JSON API + Open-Meteo API
- Gehost op Azure App Service
