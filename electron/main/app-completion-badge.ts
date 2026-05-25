import { deflateSync } from 'node:zlib';

export interface SessionCompletionBadgeTracker {
  recordCompletedSession: (sessionId: string) => number;
  clear: () => number;
  getCount: () => number;
}

interface SessionCompletionBadgeTrackerOptions {
  onCountChanged: (count: number) => void;
}

const BADGE_SIZE = 64;
const GLYPHS: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000']
};

let crcTable: Uint32Array | null = null;

export function formatCompletionBadgeLabel(count: number): string {
  if (!Number.isFinite(count)) {
    return '';
  }

  const normalizedCount = Math.floor(count);
  if (normalizedCount <= 0) {
    return '';
  }

  return normalizedCount > 99 ? '99+' : String(normalizedCount);
}

export function createWindowsCompletionBadgeDataUrl(count: number): string {
  const label = formatCompletionBadgeLabel(count);
  if (!label) {
    return '';
  }

  const rgba = new Uint8Array(BADGE_SIZE * BADGE_SIZE * 4);
  drawBadgeCircle(rgba);
  drawBadgeLabel(rgba, label);
  return encodeRgbaPngDataUrl(BADGE_SIZE, BADGE_SIZE, rgba);
}

function drawBadgeCircle(rgba: Uint8Array): void {
  const center = (BADGE_SIZE - 1) / 2;
  for (let y = 0; y < BADGE_SIZE; y += 1) {
    for (let x = 0; x < BADGE_SIZE; x += 1) {
      const distance = Math.hypot(x - center, y - center);
      if (distance <= 30) {
        setPixel(rgba, x, y, [255, 255, 255, 255]);
      }
      if (distance <= 27) {
        setPixel(rgba, x, y, [239, 68, 68, 255]);
      }
    }
  }
}

function drawBadgeLabel(rgba: Uint8Array, label: string): void {
  const scale = label.length >= 3 ? 5 : label.length === 2 ? 7 : 9;
  const spacing = scale;
  const totalWidth = label.length * 3 * scale + (label.length - 1) * spacing;
  const totalHeight = 5 * scale;
  let cursorX = Math.floor((BADGE_SIZE - totalWidth) / 2);
  const startY = Math.floor((BADGE_SIZE - totalHeight) / 2);

  for (const character of label) {
    drawGlyph(rgba, character, cursorX, startY, scale);
    cursorX += 3 * scale + spacing;
  }
}

function drawGlyph(rgba: Uint8Array, character: string, startX: number, startY: number, scale: number): void {
  const glyph = GLYPHS[character];
  if (!glyph) {
    return;
  }

  for (let row = 0; row < glyph.length; row += 1) {
    for (let column = 0; column < glyph[row].length; column += 1) {
      if (glyph[row][column] !== '1') {
        continue;
      }
      drawRect(rgba, startX + column * scale, startY + row * scale, scale, scale, [255, 255, 255, 255]);
    }
  }
}

function drawRect(rgba: Uint8Array, startX: number, startY: number, width: number, height: number, color: [number, number, number, number]): void {
  for (let y = startY; y < startY + height; y += 1) {
    for (let x = startX; x < startX + width; x += 1) {
      setPixel(rgba, x, y, color);
    }
  }
}

function setPixel(rgba: Uint8Array, x: number, y: number, color: [number, number, number, number]): void {
  if (x < 0 || y < 0 || x >= BADGE_SIZE || y >= BADGE_SIZE) {
    return;
  }

  const offset = (y * BADGE_SIZE + x) * 4;
  rgba[offset] = color[0];
  rgba[offset + 1] = color[1];
  rgba[offset + 2] = color[2];
  rgba[offset + 3] = color[3];
}

function encodeRgbaPngDataUrl(width: number, height: number, rgba: Uint8Array): string {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rawOffset = y * (stride + 1);
    raw[rawOffset] = 0;
    for (let x = 0; x < stride; x += 1) {
      raw[rawOffset + 1 + x] = rgba[y * stride + x];
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    createPngChunk('IHDR', header),
    createPngChunk('IDAT', deflateSync(raw)),
    createPngChunk('IEND', Buffer.alloc(0))
  ]);

  return `data:image/png;base64,${png.toString('base64')}`;
}

function createPngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(computeCrc32(typeBuffer, data), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function computeCrc32(...buffers: Buffer[]): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const buffer of buffers) {
    for (const byte of buffer) {
      crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function getCrcTable(): Uint32Array {
  if (crcTable) {
    return crcTable;
  }

  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  crcTable = table;
  return table;
}

export function createSessionCompletionBadgeTracker(
  options: SessionCompletionBadgeTrackerOptions
): SessionCompletionBadgeTracker {
  const completedSessionIds = new Set<string>();

  const emit = (): number => {
    const count = completedSessionIds.size;
    options.onCountChanged(count);
    return count;
  };

  return {
    recordCompletedSession: (sessionId: string): number => {
      const normalizedSessionId = sessionId.trim();
      if (!normalizedSessionId) {
        return completedSessionIds.size;
      }

      const previousCount = completedSessionIds.size;
      completedSessionIds.add(normalizedSessionId);
      if (completedSessionIds.size === previousCount) {
        return completedSessionIds.size;
      }

      return emit();
    },
    clear: (): number => {
      if (completedSessionIds.size === 0) {
        return 0;
      }

      completedSessionIds.clear();
      return emit();
    },
    getCount: (): number => completedSessionIds.size
  };
}
