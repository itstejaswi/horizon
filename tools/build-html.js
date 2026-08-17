"use strict";
// Build-time only. Assembles index.html from its template plus the generated
// Fluent icon sheet, so the shipped page needs no runtime icon loading.
//
//   node tools/build-html.js
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const template = fs.readFileSync(path.join(__dirname, "index.template.html"), "utf8");
const icons = fs.readFileSync(path.join(__dirname, "icons.generated.svg"), "utf8");

const brand = `  <!-- The Horizon mark: a solid world with an open orbital arc sweeping
       around it. Two shapes only, so it survives 16px where the previous
       mark closed up into a blob. The arc break is deliberately asymmetric
       so it does not read as a loading spinner. -->
  <symbol id="i-mark" viewBox="0 0 32 32">
    <circle cx="16" cy="16" r="6" fill="currentColor"/>
    <g fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round">
      <path d="M16 5.6a10.4 10.4 0 0 1 0 20.8"/>
      <path d="M16 26.4a10.4 10.4 0 0 1-8.6-4.5"/>
    </g>
  </symbol>
  <!-- Same geometry, marginally heavier, for 24px and below. -->
  <symbol id="i-mark-sm" viewBox="0 0 32 32">
    <circle cx="16" cy="16" r="6.4" fill="currentColor"/>
    <g fill="none" stroke="currentColor" stroke-width="2.9" stroke-linecap="round">
      <path d="M16 5.4a10.6 10.6 0 0 1 0 21.2"/>
      <path d="M16 26.6a10.6 10.6 0 0 1-8.8-4.6"/>
    </g>
  </symbol>
  <!-- Drawn rather than taken from the icon set: a circled question mark is
       simple enough that it needs no dependency, and this keeps the build
       working even without the Fluent package present. Geometry follows the
       same 20px grid and 1.6 stroke weight as the generated icons. -->
  <symbol id="i-help" viewBox="0 0 20 20">
    <circle cx="10" cy="10" r="7.6" fill="none" stroke="currentColor" stroke-width="1.6"/>
    <path d="M7.9 7.9a2.1 2.1 0 1 1 2.6 2.2c-.5.2-.8.6-.8 1.1v.4"
          fill="none" stroke="currentColor" stroke-width="1.6"
          stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="9.7" cy="14.1" r="1" fill="currentColor"/>
  </symbol>
  <!-- Thumbs for the feedback prompt on the About page. Drawn here so the
       build works without the Fluent package, same 20px grid and 1.6 stroke
       as the rest. -->
  <symbol id="i-thumb-up" viewBox="0 0 20 20">
    <path d="M6.6 17.1V8.4l3.3-5a1.5 1.5 0 0 1 2.7 1.1l-.6 3.1h3.6a1.6 1.6 0 0 1 1.6 2l-1.3 5.3a2 2 0 0 1-1.9 1.5H6.6z"
          fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
    <rect x="2.4" y="8.4" width="4.2" height="8.7" rx="1.2"
          fill="none" stroke="currentColor" stroke-width="1.6"/>
  </symbol>
  <symbol id="i-thumb-down" viewBox="0 0 20 20">
    <path d="M6.6 2.9v8.7l3.3 5a1.5 1.5 0 0 0 2.7-1.1l-.6-3.1h3.6a1.6 1.6 0 0 0 1.6-2l-1.3-5.3a2 2 0 0 0-1.9-1.5H6.6z"
          fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
    <rect x="2.4" y="2.9" width="4.2" height="8.7" rx="1.2"
          fill="none" stroke="currentColor" stroke-width="1.6"/>
  </symbol>
  <!-- A fallback glyph for the Foundry section, used only when Microsoft's own
       icon cannot be read from the local install (Foundry not installed, or the
       package directory unreadable). Where the real mark is available it is
       shown instead: naming Microsoft's product while drawing our own symbol
       for it reads as approximating the brand rather than crediting it. A
       tilted vessel pouring into a pool is the stand-in. Attribution and the
       trademark notice sit on the About page. -->
  <symbol id="i-foundry" viewBox="0 0 20 20">
    <path d="M3.6 4.3h7.9l-1.5 4.4a2.4 2.4 0 0 1-2.3 1.6H6.9a2.4 2.4 0 0 1-2.3-1.6z"
          fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M11.5 6.5c1.9.5 3 1.9 3.3 4.2" fill="none" stroke="currentColor"
          stroke-width="1.6" stroke-linecap="round"/>
    <circle cx="14.8" cy="12.4" r="1.15" fill="currentColor"/>
    <path d="M3.4 16.1h13.2" fill="none" stroke="currentColor"
          stroke-width="1.6" stroke-linecap="round"/>
  </symbol>
  <symbol id="i-foundry-on" viewBox="0 0 20 20">
    <path d="M3.6 4.3h7.9l-1.5 4.4a2.4 2.4 0 0 1-2.3 1.6H6.9a2.4 2.4 0 0 1-2.3-1.6z"
          fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M11.5 6.5c1.9.5 3 1.9 3.3 4.2" fill="none" stroke="currentColor"
          stroke-width="1.6" stroke-linecap="round"/>
    <circle cx="14.8" cy="12.4" r="1.15" fill="currentColor"/>
    <path d="M3.4 16.1h13.2" fill="none" stroke="currentColor"
          stroke-width="1.6" stroke-linecap="round"/>
  </symbol>
  <!-- The model glyph. The Fluent developer_board icon has a circular core
       with radiating pins, which at small sizes reads as an eyeball with
       lashes -- a poor look for a privacy tool. Redrawn as an unambiguous
       chip: square body, square die, short heavy pins. Fewer, thicker pins
       survive 16px far better than eight thin ones. -->
  <symbol id="i-model" viewBox="0 0 20 20">
    <rect x="4.8" y="4.8" width="10.4" height="10.4" rx="1.8"
          fill="none" stroke="currentColor" stroke-width="1.7"/>
    <rect x="8.3" y="8.3" width="3.4" height="3.4" rx=".7" fill="currentColor"/>
    <g stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
      <path d="M7.6 4.8V2.9M12.4 4.8V2.9M7.6 17.1v-1.9M12.4 17.1v-1.9"/>
      <path d="M4.8 7.6H2.9M4.8 12.4H2.9M17.1 7.6h-1.9M17.1 12.4h-1.9"/>
    </g>
  </symbol>
  <symbol id="i-model-on" viewBox="0 0 20 20">
    <g stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
      <path d="M7.6 4.8V2.9M12.4 4.8V2.9M7.6 17.1v-1.9M12.4 17.1v-1.9"/>
      <path d="M4.8 7.6H2.9M4.8 12.4H2.9M17.1 7.6h-1.9M17.1 12.4h-1.9"/>
    </g>
    <rect x="4.8" y="4.8" width="10.4" height="10.4" rx="1.8" fill="currentColor"/>
    <rect x="8.3" y="8.3" width="3.4" height="3.4" rx=".7" fill="var(--tile, #ffffff)"/>
  </symbol>
`;

// Symbols defined here take precedence over the generated Fluent sheet, since
// a document uses the first element with a given id. Rather than rely on that,
// any id defined above is removed from the generated sheet, so the built file
// never contains a duplicate.
const overridden = [...brand.matchAll(/id="([\w-]+)"/g)].map(match => match[1]);
const cleanedIcons = overridden.reduce((sheet, id) =>
  sheet.replace(new RegExp(`\\s*<symbol id="${id}"[\\s\\S]*?</symbol>`, "g"), ""), icons);

const output = template.replace("<!--ICONS-->", brand + cleanedIcons.trimEnd());
fs.writeFileSync(path.join(root, "public", "index.html"), output, "utf8");
console.log("Wrote public/index.html");
