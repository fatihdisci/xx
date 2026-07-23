#!/bin/bash
# Rebuild the Safari extension after editing anything in ../x-verim/.
#
# Safari has no "reload extension" button: the built .appex holds copies of the
# extension files made at build time, so source edits only land after a rebuild.
set -euo pipefail

cd "$(dirname "$0")"
TEAM="${DEVELOPMENT_TEAM:-8XPP7Z37GF}"

echo "==> Building…"
xcodebuild -project "X Verim/X Verim.xcodeproj" -scheme "X Verim" \
  -configuration Debug -derivedDataPath "X Verim/build" \
  -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic \
  build > /tmp/xverim-build.log 2>&1 || { tail -30 /tmp/xverim-build.log; exit 1; }

echo "==> Installing…"
rm -rf "X Verim.app"
cp -R "X Verim/build/Build/Products/Debug/X Verim.app" .
open "X Verim.app"

echo
echo "Built and registered. In Safari:"
echo "  • quit and reopen Safari (or toggle X Verim off/on in Settings > Extensions)"
echo "  • Develop > Allow Unsigned Extensions — resets on every Safari restart"
echo "  • reload the x.com tab"
