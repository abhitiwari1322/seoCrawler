import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const outDir = join("src-tauri", "icons");
mkdirSync(outDir, { recursive: true });

writeFileSync(join(outDir, "icon.png"), createPng(512));
writeFileSync(join(outDir, "32x32.png"), createPng(32));
writeFileSync(join(outDir, "128x128.png"), createPng(128));
writeFileSync(join(outDir, "128x128@2x.png"), createPng(256));

function createPng(size) {
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  const radius = Math.round(size * 0.18);

  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    pixels[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const i = row + 1 + x * 4;
      const inCorner =
        (x < radius && y < radius && distance(x, y, radius, radius) > radius) ||
        (x >= size - radius && y < radius && distance(x, y, size - radius - 1, radius) > radius) ||
        (x < radius && y >= size - radius && distance(x, y, radius, size - radius - 1) > radius) ||
        (x >= size - radius && y >= size - radius && distance(x, y, size - radius - 1, size - radius - 1) > radius);

      if (inCorner) {
        pixels[i + 3] = 0;
        continue;
      }

      pixels[i] = 28;
      pixels[i + 1] = 116;
      pixels[i + 2] = 90;
      pixels[i + 3] = 255;
    }
  }

  drawLine(pixels, size, 0.18, 0.58, 0.32, 0.58);
  drawLine(pixels, size, 0.32, 0.58, 0.4, 0.35);
  drawLine(pixels, size, 0.4, 0.35, 0.5, 0.76);
  drawLine(pixels, size, 0.5, 0.76, 0.61, 0.45);
  drawLine(pixels, size, 0.61, 0.45, 0.8, 0.45);

  const chunks = [
    chunk("IHDR", Buffer.concat([u32(size), u32(size), Buffer.from([8, 6, 0, 0, 0])])),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0))
  ];

  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]);
}

function drawLine(pixels, size, x1, y1, x2, y2) {
  const ax = Math.round(x1 * size);
  const ay = Math.round(y1 * size);
  const bx = Math.round(x2 * size);
  const by = Math.round(y2 * size);
  const steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
  const width = Math.max(2, Math.round(size * 0.035));

  for (let s = 0; s <= steps; s += 1) {
    const x = Math.round(ax + ((bx - ax) * s) / steps);
    const y = Math.round(ay + ((by - ay) * s) / steps);
    drawDot(pixels, size, x, y, width);
  }
}

function drawDot(pixels, size, cx, cy, radius) {
  for (let y = cy - radius; y <= cy + radius; y += 1) {
    for (let x = cx - radius; x <= cx + radius; x += 1) {
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      if (distance(x, y, cx, cy) > radius) continue;
      const i = y * (size * 4 + 1) + 1 + x * 4;
      pixels[i] = 255;
      pixels[i + 1] = 255;
      pixels[i + 2] = 255;
      pixels[i + 3] = 255;
    }
  }
}

function distance(x1, y1, x2, y2) {
  return Math.hypot(x1 - x2, y1 - y2);
}

function chunk(type, data) {
  const name = Buffer.from(type);
  return Buffer.concat([u32(data.length), name, data, u32(crc32(Buffer.concat([name, data])))]); 
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
