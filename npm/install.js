#!/usr/bin/env node
"use strict";

const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const REPO = "DarkPhoenix2704/girlfriend";
const BIN_DIR = path.join(__dirname, "bin");
const BIN_PATH = path.join(BIN_DIR, "girlfriend");

const PLATFORM_MAP = {
  "linux-x64":   "girlfriend-linux-x64",
  "darwin-arm64": "girlfriend-darwin-arm64",
};

function getArtifact() {
  const platform = os.platform();
  const arch = os.arch();

  const key =
    platform === "linux"  && arch === "x64"   ? "linux-x64"    :
    platform === "darwin" && arch === "arm64"  ? "darwin-arm64" :
    null;

  if (!key) {
    throw new Error(`Unsupported platform: ${platform}-${arch}.\nPre-built binaries are available for linux-x64 and darwin-arm64.`);
  }

  return PLATFORM_MAP[key];
}

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "gf-uwu-installer" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function getLatestVersion() {
  const buf = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
  const data = JSON.parse(buf.toString());
  return data.tag_name;
}

async function main() {
  // Skip in CI environments that just need the package metadata
  if (process.env.SKIP_GF_INSTALL) return;

  const artifact = getArtifact();
  const version = process.env.GIRLFRIEND_VERSION || await getLatestVersion();
  const baseUrl = `https://github.com/${REPO}/releases/download/${version}`;

  console.log(`gf-uwu: downloading girlfriend ${version} (${artifact})...`);

  const binary = await fetch(`${baseUrl}/${artifact}`);

  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.writeFileSync(BIN_PATH, binary, { mode: 0o755 });

  console.log(`gf-uwu: installed to ${BIN_PATH}`);
  console.log(`gf-uwu: run with \`girlfriend\` or \`bunx gf-uwu\``);
}

main().catch((err) => {
  console.error(`gf-uwu install failed: ${err.message}`);
  process.exit(1);
});
