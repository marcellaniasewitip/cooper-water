# iPhone apps (TestFlight)

The iPhone apps live in `ios/` and are native SwiftUI:

| App | Bundle ID | Name on the phone |
|---|---|---|
| Customer | `com.cooperwaters.customer` | Cooper Waters |
| Driver | `com.cooperwaters.driver` | CW Driver |

They talk to the same live API as the Android apps (repo variable `API_PUBLIC_URL`).
GitHub builds them on a macOS runner (`.github/workflows/ios.yml`):

- every change under `ios/`: CooperKit unit tests + a simulator build of both apps;
- every merge to `main` (or **Actions → iOS apps → Run workflow**): signed App Store builds of both apps,
  uploaded to **TestFlight**. Build numbers are `1000 + run number`.

Apple does not allow installing iPhone apps from a download link, so testers install them with the
**TestFlight** app.

## One-time setup (about 30 minutes)

You need the Apple Developer Program account (Account Holder or Admin).

### 1. Create the two apps in App Store Connect

[App Store Connect](https://appstoreconnect.apple.com) → **Apps** → **+** → **New App**, twice:

| Platform | Name | Bundle ID | SKU |
|---|---|---|---|
| iOS | Cooper Waters | `com.cooperwaters.customer` | cooperwaters-customer |
| iOS | Cooper Waters Driver | `com.cooperwaters.driver` | cooperwaters-driver |

If the bundle ID isn't in the list, register it first at
[developer.apple.com → Identifiers](https://developer.apple.com/account/resources/identifiers/list) (**+** → App IDs → App;
no extra capabilities needed), then come back.

### 2. Create an App Store Connect API key

App Store Connect → **Users and Access** → **Integrations** → **App Store Connect API** → **Team Keys** → **+**:

- Name: `GitHub Actions`, Access: **Admin** (needed so the build can create signing certificates and profiles).
- Download the `.p8` file (you can only download it once) and note the **Key ID** and the **Issuer ID** shown above the table.

### 3. Add the secrets to GitHub

GitHub repo → **Settings** → **Secrets and variables** → **Actions**:

| Kind | Name | Value |
|---|---|---|
| Variable | `APPLE_TEAM_ID` | Your 10-character Team ID (developer.apple.com → Membership details) |
| Secret | `ASC_KEY_ID` | Key ID from step 2 |
| Secret | `ASC_ISSUER_ID` | Issuer ID from step 2 |
| Secret | `ASC_KEY_P8_BASE64` | The `.p8` file, base64-encoded (below) |

Base64 the key on a Mac: `base64 -i AuthKey_XXXXXXXXXX.p8 | pbcopy` (then paste).
On Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("AuthKey_XXXXXXXXXX.p8")) | Set-Clipboard`.

### 4. Run the build

GitHub → **Actions** → **iOS apps** → **Run workflow** (branch `main`). After ~15 minutes the
**testflight** job finishes; App Store Connect then processes the builds (10–30 minutes) and emails you.

### 5. Add testers

App Store Connect → each app → **TestFlight**:

- **Internal testing** (your team, up to 100 people with App Store Connect access): add a group, add testers — they can install straight away.
- **External testing** (anyone with an email or a public link): create a group, add the build, and submit it for
  **Beta App Review** (usually within a day). Then share the **public link**.

Testers install **TestFlight** from the App Store, open the invite or link, and tap **Install**.

## Notes

- **Push notifications** to closed apps need Firebase/APNs set up (same as Android). Until then, messages and
  job offers reach the apps while they're running (drivers while online), and everything is in the Inbox /
  Announcements.
- The driver app shares the driver's location in the background while online (iOS shows the blue location
  indicator) and rings for new offers — Apple asks about background location in App Review; the text
  shown to drivers is in `ios/Driver/Info.plist`.
- Releasing to the App Store later needs screenshots, a privacy policy URL and App Review; TestFlight does not.
