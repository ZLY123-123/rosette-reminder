#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ios_dir="$(pwd)"
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/reminder-ios.XXXXXXXX")"
trap 'rm -rf -- "$build_dir"' EXIT

swift test --scratch-path "$build_dir/swift"
xcodegen generate
xcodebuild -project ReminderDesk.xcodeproj -scheme ReminderDesk -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath "$build_dir/xcode" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build

app="$build_dir/xcode/Build/Products/Release-iphoneos/ReminderDesk.app"
test -x "$app/ReminderDesk"
test "$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$app/Info.plist")" = com.reminderdesk.ios
test "$(/usr/libexec/PlistBuddy -c 'Print CFBundleDisplayName' "$app/Info.plist")" = ROSETTE
test "$(/usr/libexec/PlistBuddy -c 'Print UIAppFonts:0' "$app/Info.plist")" = CabinSketch-Regular.ttf
test "$(/usr/libexec/PlistBuddy -c 'Print UIAppFonts:1' "$app/Info.plist")" = Italianno-Regular.ttf
for resource in CabinSketch-Regular.ttf Italianno-Regular.ttf CabinSketch-OFL.txt Italianno-OFL.txt; do
  cmp "$ios_dir/Resources/Fonts/$resource" "$app/$resource"
done
test "$(/usr/bin/lipo -archs "$app/ReminderDesk")" = arm64
mkdir -p "$build_dir/package/Payload" "$ios_dir/output"
/usr/bin/ditto "$app" "$build_dir/package/Payload/ReminderDesk.app"
(
  cd "$build_dir/package"
  /usr/bin/zip -qry "$build_dir/ROSETTE-unsigned.ipa" Payload
)
/usr/bin/unzip -tq "$build_dir/ROSETTE-unsigned.ipa"
mv -f "$build_dir/ROSETTE-unsigned.ipa" "$ios_dir/output/ROSETTE-unsigned.ipa"
