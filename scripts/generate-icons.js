'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const GREEN = [17, 107, 88, 255];
const WHITE = [255, 255, 255, 255];
const SUPERSAMPLE = 4;
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type);
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return chunk;
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    pixels.copy(raw, row + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function insideRoundedRect(x, y, left, top, width, height, radius) {
  const nearestX = Math.max(left + radius, Math.min(x, left + width - radius));
  const nearestY = Math.max(top + radius, Math.min(y, top + height - radius));
  const dx = x - nearestX;
  const dy = y - nearestY;
  return dx * dx + dy * dy <= radius * radius;
}

function renderIcon(size, rounded) {
  const hiSize = size * SUPERSAMPLE;
  const high = new Uint8Array(hiSize * hiSize * 4);
  for (let py = 0; py < hiSize; py++) {
    const y = (py + 0.5) / hiSize;
    for (let px = 0; px < hiSize; px++) {
      const x = (px + 0.5) / hiSize;
      let color = [0, 0, 0, 0];
      if (!rounded || insideRoundedRect(x, y, 0, 0, 1, 1, 0.22)) color = GREEN;
      if (insideRoundedRect(x, y, 0.28, 0.19, 0.44, 0.62, 0.055)) color = WHITE;
      if (insideRoundedRect(x, y, 0.335, 0.28, 0.018, 0.44, 0.009)) color = GREEN;
      if (insideRoundedRect(x, y, 0.39, 0.37, 0.24, 0.026, 0.013)) color = GREEN;
      if (insideRoundedRect(x, y, 0.39, 0.49, 0.24, 0.026, 0.013)) color = GREEN;
      if (insideRoundedRect(x, y, 0.39, 0.61, 0.24, 0.026, 0.013)) color = GREEN;
      const offset = (py * hiSize + px) * 4;
      high.set(color, offset);
    }
  }

  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0, 0];
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const source = ((y * SUPERSAMPLE + sy) * hiSize + x * SUPERSAMPLE + sx) * 4;
          for (let channel = 0; channel < 4; channel++) sum[channel] += high[source + channel];
        }
      }
      const target = (y * size + x) * 4;
      for (let channel = 0; channel < 4; channel++) {
        pixels[target + channel] = Math.round(sum[channel] / (SUPERSAMPLE * SUPERSAMPLE));
      }
    }
  }
  return encodePng(size, pixels);
}

const outputDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outputDir, { recursive: true });
const icons = [
  ['icon-192.png', 192, true],
  ['icon-512.png', 512, true],
  ['maskable-icon-512.png', 512, false],
  ['apple-icon-180.png', 180, false]
];
for (const [name, size, rounded] of icons) {
  const png = renderIcon(size, rounded);
  if (png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) {
    throw new Error(`Dimensioni PNG non valide per ${name}`);
  }
  fs.writeFileSync(path.join(outputDir, name), png);
  console.log(`${name}: ${size}x${size}`);
}
