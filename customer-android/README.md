# Cooper Waters — Customer App (Android)

Native Android app for customers in Port Moresby to order water, pay (cash on delivery or cell money),
track the driver live and confirm / rate / dispute deliveries.

Kotlin · Jetpack Compose (Material 3) · minSdk 24 · target/compile SDK 35 · Java 17 bytecode
(Gradle runs fine on JDK 17 or 21) · Gradle 8.14.3 wrapper · version catalog in `gradle/libs.versions.toml`.

## Modules

| Module | Path | What |
| --- | --- | --- |
| `:app` | `app/` | Customer screens, ViewModels, navigation, push service |
| `:core` | `../shared/android-core` | Shared with the driver app: API client + models, auth/token store, idempotent request queue, Socket.IO client, cache, money/time formatting, map wrapper, common UI |

`settings.gradle.kts` includes core with `include(":core")` + `project(":core").projectDir = file("../shared/android-core")`.
Keep `gradle/libs.versions.toml` identical to `driver-android/gradle/libs.versions.toml` (core resolves its
dependencies from whichever app includes it).

## Build & run

Requirements: Android SDK with `platforms;android-35` and `build-tools;35.0.0`, and access to Google Maven + Maven Central.

```bash
cd customer-android
echo "sdk.dir=$ANDROID_HOME" > local.properties     # gitignored
./gradlew :app:assembleDebug                         # APK: app/build/outputs/apk/debug/app-debug.apk
./gradlew test                                       # core + app JVM unit tests
./gradlew :app:installDebug                          # emulator/device
```

## Configuration

| Setting | How |
| --- | --- |
| API base URL (debug) | Gradle property `cw.apiBaseUrl` (default `http://10.0.2.2:3100` = host machine from the emulator). Override: `./gradlew :app:assembleDebug -Pcw.apiBaseUrl=http://192.168.1.20:3100` or in `~/.gradle/gradle.properties`. Do not include `/api/v1`. |
| API base URL (release) | `cw.apiBaseUrlRelease` |
| Server address | Fixed at build time (`-Pcw.apiBaseUrl=...`); the sign-in screen has no server field. |
| Cleartext HTTP | Allowed in debug only (manifest placeholder `usesCleartextTraffic`). |
| Push (FCM) | **Optional.** Drop `google-services.json` into `app/` and the google-services plugin is applied automatically. Without it the app builds and runs; push is skipped and the Socket.IO channel is used. The FCM token is registered with `PUT /customer/me/push-token`. |
| Error tracking | `CrashReporter` interface (core) with a Logcat implementation; see the `TODO(sentry)` in `AppContainer` / `CrashReporter.kt` to plug in Sentry with a DSN from a Gradle property. |
| Maps | osmdroid / OpenStreetMap tiles (no API key; map provider is still an open decision, spec §16 #4). All screens use the `CwMap` wrapper in core, so switching to Google Maps means re-implementing one file. |

Seed accounts (local backend): customers `+67571000001` … `+67571000005`; the OTP appears in the API log (`mock sms`).

## Screens (spec §10)

Phone entry + OTP · profile (name, sign out) · saved delivery locations (map pin by dragging the map under a centre pin,
address, landmark notes, "use my location") · new order wizard: package & quantity → fixed price quote (`POST /customer/quote`)
→ delivery location → payment method (COD / cell money + number) → review & place order · cell money pending screen
(instructions, amount/reference, countdown to `expiresAt`, polling + `order.updated`, retry payment, cancel) ·
live tracking (status timeline from `order.timeline`, map with delivery pin + live driver marker from `order.driver.location`
and `order.driver_location`, call driver) · cancel (only while `customerMayCancel(status, config.cancelFreeUntil)`) ·
confirm receipt · rate driver · raise dispute (categories from config) · order history (cursor pagination).

## Unreliable network: how it behaves

- **No double submits.** "Place order" and "Try payment again" create ONE `PendingAction` per tap: a UUID
  `Idempotency-Key` plus the exact JSON body, written to `files/pending_actions.json` *before* sending. Retries (automatic
  exponential backoff, the "Send order again" button, or the background drain on reconnect/app start) always reuse that key
  and body, so the backend replays the first result instead of creating a second order. `409 request_in_progress`,
  5xx, 429, timeouts and unreadable bodies are retried; validation errors end the action. While an order is unconfirmed the
  draft is locked so the body can't change under the key. Buttons are disabled while in flight.
- **Offline rendering.** Config, packages, locations, the first history page and every viewed order are cached as JSON
  (`files/cache/`); screens show the last-known data with an offline banner.
- **Token refresh** is single-flight (refresh tokens rotate; reuse revokes the session).
- **Realtime** Socket.IO while the app is visible; FCM push as the backup; tracking also polls every 20–30 s.

## Tests

`app/src/test`: `NewOrderViewModelTest` (catalogue + quote, quantity clamp, cell money validation, same key across 503 /
lost-response / `request_in_progress` retries, unconfirmed order survives a "restart" and is resent with the same key,
permanent error → new key on next tap) and `TrackingViewModelTest` (cancel rule, socket status/location updates).
Core tests live in `../shared/android-core/src/test`.
