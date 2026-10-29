# Test-APK signing key

`debug.keystore` signs the **debug / test APKs only** (both apps). It is a throwaway debug key with the
standard Android debug passwords (`android` / `androiddebugkey` / `android`) and must never sign a Play Store release.

It is committed so every CI build is signed with the same key: a newer test APK then installs over the old
one as an update, and the app keeps its data (including the signed-in session). With Android's default
per-machine debug key every CI run had a different signature, so testers had to uninstall first and sign in again.
