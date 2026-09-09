const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');
const size = 256, rows = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const dx = Math.max(38 - x, 0, x - (size - 39)), dy = Math.max(38 - y, 0, y - (size - 39));
  const inside = dx * dx + dy * dy <= 38 * 38;
  let rgba = inside ? [208, 247, 139, 255] : [0, 0, 0, 0];
  const heights = [70, 114, 152, 94, 62];
  for (let bar = 0; bar < 5; bar++) if (x >= 56 + bar * 30 && x < 73 + bar * 30 && y >= (256 - heights[bar]) / 2 && y < (256 + heights[bar]) / 2) rgba = [36, 51, 27, 255];
  const offset = y * (size * 4 + 1) + 1 + x * 4; rgba.forEach((value, i) => rows[offset + i] = value);
}
function crc(buffer) { let c = 0xffffffff; for (const b of buffer) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xffffffff) >>> 0; }
function chunk(type, bytes) { const body = Buffer.concat([Buffer.from(type), bytes]), length = Buffer.alloc(4), sum = Buffer.alloc(4); length.writeUInt32BE(bytes.length); sum.writeUInt32BE(crc(body)); return Buffer.concat([length, body, sum]); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
const header = Buffer.alloc(22); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4); header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12); header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
fs.writeFileSync(path.join(__dirname, 'icon.ico'), Buffer.concat([header, png]));
