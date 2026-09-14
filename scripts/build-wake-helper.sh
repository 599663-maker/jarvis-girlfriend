#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
project_dir=${script_dir:h}
helper_dir="$project_dir/src-tauri/wake-helper"
signing_identity=${APPLE_SIGNING_IDENTITY:--}
swiftc_bin=${JARVIS_SWIFTC:-}
sdk_path=${JARVIS_SDK_PATH:-$(xcrun --show-sdk-path)}

# Recent CommandLineTools ship two module maps that both declare SwiftBridging,
# which makes every compile fail before it starts. When the stock toolchain is
# broken, use a user-owned copy with the older map removed so helper builds keep
# working without sudo.
if [[ -z $swiftc_bin ]]; then
  stock_swiftc=/usr/bin/swiftc
  if echo 'import Foundation' | "$stock_swiftc" - -o /dev/null >/dev/null 2>&1; then
    swiftc_bin=$stock_swiftc
  else
    patched_root="$HOME/.cache/jarvis/swift-toolchain/usr"
    if [[ ! -x "$patched_root/bin/swift-frontend" ]]; then
      mkdir -p "$patched_root/bin" "$patched_root/include/swift"
      cp -a /Library/Developer/CommandLineTools/usr/bin/swift-frontend \
        /Library/Developer/CommandLineTools/usr/bin/swift-driver \
        /Library/Developer/CommandLineTools/usr/bin/clang "$patched_root/bin/"
      ln -sfn swift-frontend "$patched_root/bin/swiftc"
      ln -sfn /Library/Developer/CommandLineTools/usr/lib "$patched_root/lib"
      cp -a /Library/Developer/CommandLineTools/usr/include/swift/bridging \
        /Library/Developer/CommandLineTools/usr/include/swift/bridging.modulemap \
        "$patched_root/include/swift/"
    fi
    swiftc_bin="$patched_root/bin/swiftc"
  fi
fi

# The wake listener owns the microphone; the vision helper owns the camera.
# Both are launched through LaunchServices so macOS attributes the privacy
# prompts to their own bundle identifier.
build_app() {
  local name=$1
  local frameworks=("${@:2}")
  local app_dir="$helper_dir/$name.app"
  local binary_dir="$app_dir/Contents/MacOS"

  mkdir -p "$binary_dir"
  cp "$helper_dir/$name.Info.plist" "$app_dir/Contents/Info.plist"
  local framework_flags=()
  for framework in "${frameworks[@]}"; do
    framework_flags+=(-framework "$framework")
  done
  "$swiftc_bin" \
    -O \
    -sdk "$sdk_path" \
    "${framework_flags[@]}" \
    "$helper_dir/$name.swift" \
    -o "$binary_dir/$name"
  /usr/bin/codesign \
    --force \
    --options runtime \
    --entitlements "$helper_dir/$name.entitlements" \
    --sign "$signing_identity" \
    "$app_dir"
}

build_app JarvisWakeListener AppKit AVFoundation Speech
build_app JarvisVision AVFoundation CoreImage CoreMedia CoreVideo Vision

# Subject extraction runs headless: no privacy prompt, so a plain binary inside
# the bundle is enough.
"$swiftc_bin" \
  -O \
  -sdk "$sdk_path" \
  -framework Vision \
  -framework CoreImage \
  -framework ImageIO \
  -framework UniformTypeIdentifiers \
  "$helper_dir/jarvis-matte.swift" \
  -o "$helper_dir/JarvisMatte"
/usr/bin/codesign --force --options runtime --sign "$signing_identity" "$helper_dir/JarvisMatte"
