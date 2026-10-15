#!/usr/bin/env bash
# Applies Nudge's icons and microphone permission to the generated Android project.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
app="$here/../android/app/src/main"
cp -r "$here/res/." "$app/res/"
manifest="$app/AndroidManifest.xml"
if ! grep -q RECORD_AUDIO "$manifest"; then
  sed -i 's#</manifest>#    <uses-permission android:name="android.permission.RECORD_AUDIO" />\n    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />\n</manifest>#' "$manifest"
fi
grep -n "permission" "$manifest"

# Sign every build with the same key in this repo, so new versions install over old ones.
gradle="$here/../android/app/build.gradle"
if ! grep -q "nudge-signing" "$gradle"; then
  cat >> "$gradle" <<'GRADLE'

// nudge-signing: fixed debug key so updates install over the previous version
android {
    signingConfigs {
        debug {
            storeFile file("../../android-res/debug.keystore")
            storePassword "android"
            keyAlias "androiddebugkey"
            keyPassword "android"
        }
    }
    buildTypes {
        debug { signingConfig signingConfigs.debug }
    }
}
GRADLE
fi
# Each build gets a higher version number (GitHub run number), so Android always treats it as an update.
if [ -n "${GITHUB_RUN_NUMBER:-}" ]; then
  sed -i -E "s/versionCode [0-9]+/versionCode ${GITHUB_RUN_NUMBER}/; s/versionName \"[^\"]*\"/versionName \"1.${GITHUB_RUN_NUMBER}\"/" "$gradle"
fi
grep -nE "versionCode|versionName|storeFile" "$gradle"

# Lets the automatic backup reach Documents/Nudge on Android 10 and older (newer phones need no permission).
if ! grep -q WRITE_EXTERNAL_STORAGE "$manifest"; then
  sed -i 's#</manifest>#    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />\n    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />\n</manifest>#' "$manifest"
fi
