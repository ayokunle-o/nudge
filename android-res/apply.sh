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
