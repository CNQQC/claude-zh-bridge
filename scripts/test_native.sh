#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p .build
swiftc -swift-version 5 -parse-as-library -O -module-cache-path .build/module-cache \
  desktop/patcher/Sources/Core.swift desktop/patcher/Sources/Installer.swift \
  desktop/patcher/Tests/CoreTests.swift -o .build/PatcherTests
.build/PatcherTests
