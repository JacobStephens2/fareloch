# Fareloch

A self-hosted PWA for tracking daily macronutrients and calories. Meal logging, food search via Open Food Facts and USDA, barcode scanning, recipe management, weight tracking, and CSV export.

Your food. Your targets. Your data.

Live at **https://fareloch.app** (legacy alias: https://macros.stephens.page)

See [FARELOCH-NAME.md](./FARELOCH-NAME.md) for the rename decision record.

## Features

- **Daily macro dashboard** — calorie ring, carbs/protein/fat progress bars with remaining totals, per-meal targets with color coding
- **Meal logging** — breakfast, lunch, dinner, snacks with per-meal subtotals
- **Food search** — combo search across Open Food Facts and USDA FoodData Central APIs
- **Barcode scanner** — scan packaged foods using device camera
- **Custom foods** — create your own foods with manual macro entry, auto-calculated calories
- **Recipes** — build from ingredients or enter macros manually, custom serving units
- **Weight tracking** - log weight and optional navel waist circumference, with a trend chart and a personal Waist-Thermostat ceiling
- **Copy previous day** — one-tap meal duplication for repetitive diets
- **Tap to edit, swipe to delete** — touch-friendly meal management
- **CSV export** — download meal logs and weight data
- **Dark mode** — automatic via `prefers-color-scheme`
- **Email/password auth** — with email verification and password reset
- **PWA** — installable, service worker for fast loading, TWA-ready for Google Play

## Tech Stack

- **Frontend:** TypeScript, Vite, Chart.js, html5-qrcode, vite-plugin-pwa
- **Backend:** Node.js, Express, better-sqlite3, JWT (httpOnly cookies), bcrypt, nodemailer
- **Hosting:** Apache (reverse proxy), Let's Encrypt SSL, systemd

## Development

```bash
# Frontend
npm install
npm run dev          # Vite dev server on :5173, proxies /api to :3457

# Server
cd server
npm install
npx tsc              # Compile TypeScript
node dist/index.js   # Runs on :3457
```

### Launcher icons

`public/logo.svg` is the artwork source for `scripts/generate-icons.mjs`.
The mark is a bold Fareloch **F** inside an enclosed basin, with the three macro
colors beneath it. The monogram replaces the abstract water shape so the icon
has a clear identity at Android launcher sizes, while retaining the enclosed
loch motif and teal palette from [the naming record](./FARELOCH-NAME.md#8-visual-direction).
After `npm ci`, run `npm run generate:icons` to regenerate the checked-in web,
legacy Android, and adaptive Android icons with the locked Sharp dependency.
Keep the SVG's `background` ID on the background rectangle: the generator hides
it for the transparent adaptive foreground while retaining the existing Android
background layer (`android/app/src/main/res/drawable/ic_launcher_bg.xml`).

The adaptive foreground layers are 108dp (108/162/216/324/432px across the five
densities). The Fareloch monogram, enclosure and macro dots fit inside the
central 66dp safe circle. Run `npx vitest run src/launcher-icons.test.ts` to check transparent
padding, circle and squircle masks, and reproducible generation.

Environment variables for the server (set in systemd service or `.env`):

| Variable | Description |
|---|---|
| `JWT_SECRET` | Secret for signing JWTs |
| `PORT` | Server port (default: 3457) |
| `SMTP_HOST` | SMTP server hostname |
| `SMTP_PORT` | SMTP server port |
| `SMTP_USER` | SMTP username |
| `SMTP_PASS` | SMTP password |
| `SMTP_FROM` | From email address |
| `APP_URL` | Public URL (for email links) |
| `USDA_API_KEY` | USDA FoodData Central API key |
| `FATSECRET_CLIENT_ID` | FatSecret Platform API client ID |
| `FATSECRET_CLIENT_SECRET` | FatSecret Platform API client secret |

## Deploy

```bash
# Frontend (DocumentRoot is this repo's dist/)
npm run build

# Server
cd server
npx tsc
sudo systemctl restart macros-api
```

## License

Personal project. Not licensed for redistribution.
