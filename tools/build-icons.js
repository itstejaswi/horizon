"use strict";
// Build-time only. Extracts official Fluent System Icon paths into an inline
// symbol sheet so the app ships with authentic glyphs and zero runtime deps.
//
//   node tools/build-icons.js <path-to-fluent-icons-svg-folder> <output-file>
//
// Source: @fluentui/svg-icons (MIT). Run only when the icon set changes; the
// generated sheet is committed, so a normal clone needs no build step.
const fs = require("fs");
const path = require("path");

const SRC = process.argv[2];
const OUT = process.argv[3];

const MAP = {
  "i-send": "send_20_filled",
  "i-stop": "record_stop_20_filled",
  "i-settings": "settings_20_regular",
  "i-settings-on": "settings_20_filled",
  "i-copy": "copy_20_regular",
  "i-check": "checkmark_20_filled",
  "i-plus": "add_20_filled",
  "i-trash": "delete_20_regular",
  "i-broom": "broom_20_regular",
  "i-sun": "weather_sunny_20_filled",
  "i-moon": "weather_moon_20_filled",
  "i-auto": "circle_half_fill_20_filled",
  "i-chat": "chat_20_regular",
  "i-chat-on": "chat_20_filled",
  "i-bookmark": "bookmark_20_regular",
  "i-bookmark-on": "bookmark_20_filled",
  "i-brain": "brain_circuit_20_regular",
  "i-brain-on": "brain_circuit_20_filled",
  "i-library": "library_20_regular",
  "i-library-on": "library_20_filled",
  "i-plug": "plug_connected_20_regular",
  "i-plug-on": "plug_connected_20_filled",
  "i-pulse": "pulse_20_regular",
  "i-pulse-on": "pulse_20_filled",
  "i-shield": "shield_checkmark_20_filled",
  "i-globe": "globe_20_regular",
  "i-globe-off": "globe_prohibited_20_filled",
  "i-dismiss": "dismiss_20_regular",
  "i-up": "arrow_up_20_filled",
  "i-down": "arrow_down_20_filled",
  "i-chevron": "chevron_down_20_filled",
  "i-warn": "warning_20_filled",
  "i-spark": "sparkle_20_filled",
  "i-book": "book_20_regular",
  "i-code": "code_20_regular",
  "i-scales": "scales_20_regular",
  "i-person": "person_20_filled",
  "i-model": "developer_board_20_regular",
  "i-model-on": "developer_board_20_filled",
  "i-refresh": "arrow_sync_20_regular",
  "i-power": "power_20_regular",
  "i-download": "arrow_download_20_regular",
  "i-panel": "panel_right_20_regular",
  "i-panel-on": "panel_right_20_filled"
};

const symbols = [];
const missing = [];

for (const [id, file] of Object.entries(MAP)) {
  const full = path.join(SRC, `${file}.svg`);
  if (!fs.existsSync(full)) { missing.push(file); continue; }

  const svg = fs.readFileSync(full, "utf8");
  const viewBox = (/viewBox="([^"]+)"/.exec(svg) || [])[1] || "0 0 20 20";

  // Keep only the drawing instructions. Hard-coded fills are stripped so the
  // glyph inherits currentColor from the surrounding UI.
  const inner = svg
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<svg[^>]*>/, "")
    .replace(/<\/svg>/, "")
    .replace(/\s*fill="[^"]*"/g, "")
    .replace(/\s*class="[^"]*"/g, "")
    .replace(/<title>[\s\S]*?<\/title>/g, "")
    .replace(/\s+/g, " ")
    .trim();

  symbols.push(`  <symbol id="${id}" viewBox="${viewBox}">${inner}</symbol>`);
}

if (missing.length) {
  console.error(`Missing source icons: ${missing.join(", ")}`);
  process.exit(1);
}

fs.writeFileSync(OUT, symbols.join("\n") + "\n", "utf8");
console.log(`Wrote ${symbols.length} symbols to ${OUT}`);
