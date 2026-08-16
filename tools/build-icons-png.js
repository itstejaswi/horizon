"use strict";
// Build-time only. Rasterises the brand mark into the PNG sizes Windows needs
// for a taskbar entry and Start tile.
//
//   node tools/build-icons-png.js
//
// Windows will not use an SVG for a taskbar icon, so a PWA install needs real
// PNGs. Rather than add an image library, the mark is drawn with the same
// geometry as the SVG using node-canvas-free primitives: a data URI is not an
// option here, so the shapes are drawn directly into a PNG by hand.
//
// The generated files are committed, so a normal clone needs no build step.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT = path.join(__dirname, "..", "public", "brand");

// Brand colours, matching public/brand/mark.svg.
const TILE = [0x0f, 0x6c, 0xbd];
const INK = [0xff, 0xff, 0xff];

// The mark in its 32-unit coordinate space: a solid world, and an orbital arc
// broken asymmetrically so it never reads as a loading spinner.
const CORE_R = 6;
const ORBIT_R = 10.4;
const STROKE = 2.6;

function draw(size, options = {}) {
  return encodePng(size, size, rasterise(size, options));
}

// Produces raw RGBA for the mark at a given size. Kept separate from the PNG
// encoder because the .ico writer needs the same pixels in a different wrapper.
function rasterise(size, { maskable = false } = {}) {
  // A maskable icon must survive being cropped to a circle, so the glyph is
  // drawn smaller inside a full-bleed tile.
  const scale = maskable ? 0.6 : 0.74;
  const radius = maskable ? 0 : size * 0.22;
  const pixels = Buffer.alloc(size * size * 4);

  const cx = size / 2;
  const cy = size / 2;
  const unit = (size * scale) / 32;

  const coreR = CORE_R * unit;
  const orbitR = ORBIT_R * unit;
  const half = (STROKE * unit) / 2;

  // Supersample so the curves do not look ragged at small sizes.
  const SS = 4;
  const inv = 1 / (SS * SS);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inTile = 0;
      let inGlyph = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;

          // Rounded tile.
          if (insideRoundedRect(px, py, size, radius)) inTile++;

          const dx = px - cx;
          const dy = py - cy;
          const dist = Math.hypot(dx, dy);

          if (dist <= coreR) { inGlyph++; continue; }

          // The orbit: an annulus, minus the gap. Angles are measured from the
          // top, clockwise, matching the SVG's arc directions.
          if (Math.abs(dist - orbitR) <= half) {
            const angle = (Math.atan2(dx, -dy) * 180) / Math.PI;
            const deg = angle < 0 ? angle + 360 : angle;
            // Solid from 0 to 180 (right side), and 180 to 245 on the left,
            // leaving an asymmetric break.
            if (deg <= 182 || deg >= 245) inGlyph++;
          }
        }
      }

      const offset = (y * size + x) * 4;
      const tileAlpha = inTile * inv;
      const glyphAlpha = Math.min(1, inGlyph * inv);

      // Composite the ink over the tile, then the tile over transparency.
      for (let c = 0; c < 3; c++) {
        pixels[offset + c] = Math.round(TILE[c] * (1 - glyphAlpha) + INK[c] * glyphAlpha);
      }
      pixels[offset + 3] = Math.round(255 * tileAlpha);
    }
  }

  return pixels;
}

function insideRoundedRect(x, y, size, radius) {
  if (radius <= 0) return x >= 0 && y >= 0 && x <= size && y <= size;
  const rx = Math.min(Math.max(x, radius), size - radius);
  const ry = Math.min(Math.max(y, radius), size - radius);
  return Math.hypot(x - rx, y - ry) <= radius;
}

// Minimal PNG writer: no dependencies, and the format is simple enough that a
// correct encoder is shorter than pulling in a library.
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc ^ -1;
}

fs.mkdirSync(OUT, { recursive: true });
for (const [file, size, options] of [
  ["icon-192.png", 192, {}],
  ["icon-512.png", 512, {}],
  ["icon-maskable-512.png", 512, { maskable: true }]
]) {
  fs.writeFileSync(path.join(OUT, file), draw(size, options));
  console.log(`Wrote public/brand/${file}`);
}

// Windows shortcuts need an .ico; a .lnk pointing at a .bat otherwise shows the
// generic command-prompt icon, which is not our brand and looks like a script
// rather than an application. Multiple sizes so the taskbar, Alt-Tab and the
// desktop each get a crisp one rather than a rescaled blur.
fs.writeFileSync(path.join(OUT, "horizon.ico"), encodeIco([16, 24, 32, 48, 64, 128, 256]));
console.log("Wrote public/brand/horizon.ico");

// An ICO is a small directory of images. PNG data inside the container is legal
// from Vista onwards and is far smaller, but GDI+ refuses to decode it at some
// sizes -- so the classic uncompressed DIB form is used instead, which every
// consumer of an icon understands. A few kilobytes is a fair price for that.
function encodeIco(sizes) {
  const images = sizes.map(size => ({ size, data: encodeDib(size) }));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // 1 = icon
  header.writeUInt16LE(images.length, 4);  // image count

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach((image, index) => {
    const entry = index * 16;
    // 0 means 256 in this field, which is why the byte is masked.
    directory[entry] = image.size & 0xff;
    directory[entry + 1] = image.size & 0xff;
    directory[entry + 2] = 0;                // palette size
    directory[entry + 3] = 0;                // reserved
    directory.writeUInt16LE(1, entry + 4);   // colour planes
    directory.writeUInt16LE(32, entry + 6);  // bits per pixel
    directory.writeUInt32LE(image.data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.data.length;
  });

  return Buffer.concat([header, directory, ...images.map(image => image.data)]);
}

// A 32-bit DIB as an icon expects: a header whose height is doubled to account
// for the mask, then bottom-up BGRA rows, then a 1-bit AND mask. The mask is
// legacy -- the alpha channel does the real work -- but it must still be there
// and padded to a 4-byte boundary per row.
function encodeDib(size) {
  const rgba = rasterise(size);

  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);          // header size
  header.writeInt32LE(size, 4);         // width
  header.writeInt32LE(size * 2, 8);     // height, doubled for the mask
  header.writeUInt16LE(1, 12);          // planes
  header.writeUInt16LE(32, 14);         // bits per pixel
  header.writeUInt32LE(0, 16);          // BI_RGB, no compression

  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    // Bottom-up.
    const source = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x++) {
      const from = source + x * 4;
      const to = (y * size + x) * 4;
      pixels[to] = rgba[from + 2];      // B
      pixels[to + 1] = rgba[from + 1];  // G
      pixels[to + 2] = rgba[from];      // R
      pixels[to + 3] = rgba[from + 3];  // A
    }
  }

  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size, 0);

  return Buffer.concat([header, pixels, mask]);
}
