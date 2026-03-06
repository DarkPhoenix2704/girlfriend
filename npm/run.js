#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");
const path = require("path");
const os = require("os");

const PLATFORM_PACKAGES = {
  "linux-x64":    "gf-uwu-linux-x64",
  "darwin-arm64": "gf-uwu-darwin-arm64",
};

const key =
  os.platform() === "linux"  && os.arch() === "x64"   ? "linux-x64"    :
  os.platform() === "darwin" && os.arch() === "arm64"  ? "darwin-arm64" :
  null;

if (!key) {
  console.error(`gf-uwu: unsupported platform ${os.platform()}-${os.arch()}`);
  process.exit(1);
}

const pkg = PLATFORM_PACKAGES[key];

let binPath;
try {
  binPath = require.resolve(`${pkg}/bin/girlfriend`);
} catch {
  console.error(`gf-uwu: platform package "${pkg}" is not installed.`);
  console.error(`Try: npm install ${pkg}`);
  process.exit(1);
}

try {
  execFileSync(binPath, process.argv.slice(2), { stdio: "inherit" });
} catch (err) {
  process.exit(err.status ?? 1);
}
