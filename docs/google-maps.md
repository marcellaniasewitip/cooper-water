# Google Maps Platform

The apps use Google Maps once these keys are set. Until then they keep working on OpenStreetMap (no key) and
address search is hidden, so nothing breaks while you set this up.

| Where | What it powers | Key (GitHub secret) | Google APIs to enable on that key |
|---|---|---|---|
| Android customer + driver apps | The maps in both apps | `GOOGLE_MAPS_ANDROID_KEY` | **Maps SDK for Android** |
| Admin dashboard | Fleet, depots and order maps | `GOOGLE_MAPS_WEB_KEY` | **Map Tiles API** |
| Server (API) | "Search address" and the address filled in when a customer moves the pin | `GOOGLE_MAPS_SERVER_KEY` | **Places API (New)**, **Geocoding API** |

The iPhone apps use Apple Maps (built in, no key).

## 1. Google Cloud project

1. Go to <https://console.cloud.google.com/>, create (or pick) a project, and **enable billing**
   (Google gives a monthly free allowance; set a budget alert under Billing → Budgets).
2. **APIs & Services → Library**: enable *Maps SDK for Android*, *Map Tiles API*, *Places API (New)* and
   *Geocoding API*.

## 2. Create three keys (APIs & Services → Credentials → Create credentials → API key)

Restrict each key so it can't be misused if someone copies it:

**Android key**
- Application restriction: **Android apps** → add both packages with your signing certificate SHA-1:
  `com.cooperwaters.customer` and `com.cooperwaters.driver`.
  (Debug/test APKs from GitHub are signed with the debug key; get its SHA-1 from the build log or run
  `keytool -list -v -keystore ~/.android/debug.keystore -storepass android` on the machine that builds them.
  Add the release SHA-1 too when you publish to Play.)
- API restriction: **Maps SDK for Android** only.

**Web key (admin dashboard)**
- Application restriction: **Websites** → your admin URL, e.g. `https://admin.example.com/*`
  (and the CloudFront URL if you use it).
- API restriction: **Map Tiles API** only.

**Server key**
- Application restriction: none (the API runs on AWS Fargate with changing IPs).
- API restriction: **Places API (New)** and **Geocoding API** only. This key never leaves the server.

## 3. Add them to GitHub

Repo → **Settings → Secrets and variables → Actions → New repository secret**:
`GOOGLE_MAPS_ANDROID_KEY`, `GOOGLE_MAPS_WEB_KEY`, `GOOGLE_MAPS_SERVER_KEY`.

## 4. Deploy

Run **Actions → Deploy to AWS → Run workflow** and **Actions → Android test APKs (live API) → Run workflow**
(or just merge any change to `main`). Then install the new APKs.

## Where it lives in the code

- Server search: `backend/src/geo/maps.service.ts` (endpoints `GET /api/v1/geo/status|search|reverse`).
- Android maps: `shared/android-core/src/main/java/com/cooperwaters/core/android/ui/MapView.kt` (`CwMap`).
- Android key: `-Pcw.googleMapsKey` → `com.google.android.geo.API_KEY` in each app's `AndroidManifest.xml`.
- Customer "Search address": `customer-android/.../ui/locations/LocationEditScreen.kt`.
- Admin maps: `admin/src/components/MapBase.tsx` (`VITE_GOOGLE_MAPS_KEY`).
- Default map centre (Port Moresby): `admin/src/config.ts`, `shared/android-core/.../util/Geo.kt`, `ios/CooperKit/Sources/CooperKit/Geo.swift`.
