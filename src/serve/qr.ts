// QR codes for pairing, drawn in the terminal: byte mode, error correction M, versions 1 to 40.
// The algorithm follows the standard (and Nayuki's reference implementation): data and Reed-Solomon
// blocks interleaved, function patterns, zigzag placement, the mask with the lowest penalty.

/** Error-correction codewords per block, and blocks, for level M, by version (index 0 unused). */
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
const FORMAT_M = 0; // level M's two format bits

function rawModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

const dataCodewords = (ver: number): number => Math.floor(rawModules(ver) / 8) - (ECC_PER_BLOCK[ver] ?? 0) * (BLOCKS[ver] ?? 0);

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function divisor(degree: number): number[] {
  const result: number[] = Array.from({ length: degree }, (_, i) => (i === degree - 1 ? 1 : 0));
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j] ?? 0, root);
      if (j + 1 < result.length) result[j] = (result[j] ?? 0) ^ (result[j + 1] ?? 0);
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function remainder(data: number[], div: number[]): number[] {
  const result = div.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() ?? 0);
    result.push(0);
    div.forEach((coef, i) => (result[i] = (result[i] ?? 0) ^ gfMul(coef, factor)));
  }
  return result;
}

/** The data codewords, then error correction, interleaved block by block. */
function codewords(bytes: Uint8Array, ver: number): number[] {
  const capacity = dataCodewords(ver);
  const bits: number[] = [];
  const push = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity * 8 - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);

  const blocks = BLOCKS[ver] ?? 1;
  const eccLen = ECC_PER_BLOCK[ver] ?? 0;
  const raw = Math.floor(rawModules(ver) / 8);
  const short = blocks - (raw % blocks);
  const shortLen = Math.floor(raw / blocks);
  const div = divisor(eccLen);
  const all: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < short ? 0 : 1));
    k += dat.length;
    const ecc = remainder(dat, div);
    if (i < short) dat.push(0);
    all.push([...dat, ...ecc]);
  }
  const out: number[] = [];
  for (let i = 0; i < (all[0]?.length ?? 0); i++) {
    all.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= short) out.push(block[i] ?? 0);
    });
  }
  return out;
}

function alignment(ver: number): number[] {
  if (ver === 1) return [];
  const count = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = ver * 4 + 17 - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

const MASKS: Array<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** The QR code for `text`: rows of modules, true for dark. */
export function qr(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  let ver = 1;
  while (ver < 40 && 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8 > dataCodewords(ver) * 8) ver++;
  if (4 + 16 + bytes.length * 8 > dataCodewords(ver) * 8) throw new Error("too long for a QR code");
  const size = ver * 4 + 17;
  const grid = Array.from({ length: size }, () => Array.from({ length: size }, () => false));
  const fixed = Array.from({ length: size }, () => Array.from({ length: size }, () => false));
  const set = (x: number, y: number, dark: boolean): void => {
    const row = grid[y];
    const frow = fixed[y];
    if (row === undefined || frow === undefined || x < 0 || x >= size) return;
    row[x] = dark;
    frow[x] = true;
  };

  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        if (cx + dx >= 0 && cx + dx < size && cy + dy >= 0 && cy + dy < size) set(cx + dx, cy + dy, dist !== 2 && dist !== 4);
      }
    }
  }
  const align = alignment(ver);
  const last = align.length - 1;
  align.forEach((ax, i) =>
    align.forEach((ay, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }),
  );
  const format = (mask: number): void => {
    const data = (FORMAT_M << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  format(0); // reserves the format area; drawn for real once the mask is chosen
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }

  const data = codewords(bytes, ver);
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        const row = grid[y];
        if (row !== undefined && !fixed[y]?.[x] && i < data.length * 8) {
          row[x] = (((data[i >>> 3] ?? 0) >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }

  const apply = (mask: number): void => {
    for (let y = 0; y < size; y++) {
      const row = grid[y];
      if (row === undefined) continue;
      for (let x = 0; x < size; x++) if (!fixed[y]?.[x] && MASKS[mask]?.(x, y)) row[x] = !row[x];
    }
  };
  let best = 0;
  let lowest = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    apply(mask);
    format(mask);
    const score = penalty(grid);
    if (score < lowest) {
      lowest = score;
      best = mask;
    }
    apply(mask); // undo: a mask is its own inverse
  }
  apply(best);
  format(best);
  return grid;
}

/** Rules 1, 2 and 4 of the standard's penalty (runs, 2×2 blocks, balance): enough to avoid a mask
 *  that draws stripes or a mostly dark code. */
function penalty(grid: boolean[][]): number {
  const size = grid.length;
  let score = 0;
  let dark = 0;
  for (let a = 0; a < size; a++) {
    let runRow = 1;
    let runCol = 1;
    for (let b = 1; b < size; b++) {
      runRow = grid[a]?.[b] === grid[a]?.[b - 1] ? runRow + 1 : 1;
      runCol = grid[b]?.[a] === grid[b - 1]?.[a] ? runCol + 1 : 1;
      if (runRow === 5) score += 3;
      else if (runRow > 5) score++;
      if (runCol === 5) score += 3;
      else if (runCol > 5) score++;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = grid[y]?.[x];
      if (v) dark++;
      if (x < size - 1 && y < size - 1 && v === grid[y]?.[x + 1] && v === grid[y + 1]?.[x] && v === grid[y + 1]?.[x + 1]) score += 3;
    }
  }
  return score + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
}

/** The code for a terminal: two rows of modules per line in half blocks, black on white with a
 *  quiet zone, so a phone's camera reads it on a dark theme too. */
export function qrText(text: string): string {
  const grid = qr(text);
  const quiet = 2;
  const size = grid.length + quiet * 2;
  const at = (x: number, y: number): boolean => grid[y - quiet]?.[x - quiet] ?? false;
  const lines: string[] = [];
  for (let y = 0; y < size; y += 2) {
    let line = "\x1b[30;47m";
    for (let x = 0; x < size; x++) {
      const top = at(x, y);
      const bottom = y + 1 < size && at(x, y + 1);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines.join("\n");
}
