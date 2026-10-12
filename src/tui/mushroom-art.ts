// Kinoko in the terminal: the app's mushroom as pixel art, two pixels per character (▀ ▄ with
// 24-bit colours), with the face of the profile in use, as the phone draws it. Amanita goes super
// saiyan, Psilocybe is past the wardrobe, Shiitake wears glasses, Morchella round gold ones, Cordyceps
// conducts the orchestra, Mycena is already leaving. Any other profile, or none: the plain smile.

const RGB: Record<string, string> = {
  R: "232;36;36", // cap
  W: "238;222;186", // cream: spots, stem
  K: "21;22;30", // ink: eyes, mouth
  P: "242;139;139", // cheeks
  w: "255;255;255",
  Y: "255;241;118", // aura, light
  O: "255;196;0", // aura, deep
  D: "106;0;0", // the vein
  M: "255;122;217", // Psilocybe's colours
  C: "110;231;249",
  V: "183;148;246",
  L: "134;239;172",
  U: "253;224;71",
  g: "107;113;148", // the glasses
  A: "229;185;74", // the gold glasses
  S: "138;130;112", // speed lines
};

// 20 × 18 pixels: the mushroom, with room around it for an aura, stars, a headset.
const BASE = [
  "....................",
  "....................",
  ".......RRRRRR.......",
  ".....RRRRWWRRRR.....",
  "....RRWWRRRRRRRR....",
  "...RRRWWRRRRRWWRR...",
  "...RRRRRRRRWRRWWR...",
  "..RRWRRRRRRRRRRRRR..",
  "..RRRRRRRRRRRRRRRR..",
  "...RRRRRRRRRRRRRR...",
  "......WWWWWWWW......",
  "......WKWWWWKW......",
  "......PWWWWWWP......",
  "......WWKWWKWW......",
  "......WWWKKWWW......",
  ".....WWWWWWWWWW.....",
  "....................",
  "....................",
];

type Grid = string[][];
type Pixel = [x: number, y: number, c: string];

const put = (grid: Grid, pixels: Pixel[]): void => {
  for (const [x, y, c] of pixels) if (grid[y]?.[x] !== undefined) (grid[y] as string[])[x] = c;
};

/** The mushroom's own pixels: what an aura goes around. */
const solid = (c: string | undefined): boolean => c !== undefined && c !== "." && c !== "Y" && c !== "O";

/** Super saiyan: a deep gold rim around it, a light one beyond, flames rising from the top. */
function aura(grid: Grid): void {
  const near = (x: number, y: number, d: number): boolean => {
    for (let dy = -d; dy <= d; dy++) for (let dx = -d; dx <= d; dx++) if (solid(grid[y + dy]?.[x + dx])) return true;
    return false;
  };
  const rim: Pixel[] = [];
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < 20; x++) {
      if (grid[y]?.[x] !== "." || y > 15) continue;
      if (near(x, y, 1)) rim.push([x, y, y < 3 ? "Y" : "O"]);
      else if (near(x, y, 2) && y >= 4 && y < 13) rim.push([x, y, "Y"]);
    }
  }
  put(grid, rim);
  // The flames: tongues above the cap, the middle ones tallest.
  put(grid, [[5, 0, "Y"], [8, 0, "Y"], [9, 0, "O"], [10, 0, "O"], [11, 0, "Y"], [14, 0, "Y"], [6, 1, "O"], [9, 1, "O"], [10, 1, "O"], [13, 1, "O"], [3, 2, "Y"], [16, 2, "Y"], [2, 3, "Y"], [17, 3, "Y"], [1, 5, "Y"], [18, 5, "Y"]]);
}

const FACES: Record<string, (grid: Grid) => void> = {
  amanita: (g) => {
    aura(g);
    // Brows down over narrowed eyes, teeth clenched, a vein on the cap.
    put(g, [[7, 10, "K"], [8, 10, "K"], [11, 10, "K"], [12, 10, "K"], [6, 12, "W"], [13, 12, "W"]]);
    put(g, [[8, 13, "w"], [9, 13, "w"], [10, 13, "w"], [11, 13, "w"], [8, 14, "K"], [9, 14, "K"], [10, 14, "K"], [11, 14, "K"]]);
    put(g, [[14, 4, "D"], [15, 5, "D"], [13, 5, "D"]]);
  },
  psilocybe: (g) => {
    // Every colour it sees: on its spots and around it. Heavy lids, a huge grin, a tongue.
    put(g, [[9, 3, "C"], [10, 3, "C"], [6, 4, "M"], [7, 4, "M"], [6, 5, "M"], [7, 5, "M"], [13, 5, "U"], [14, 5, "U"], [11, 6, "V"], [14, 6, "U"], [15, 6, "U"], [4, 7, "L"]]);
    put(g, [[1, 2, "M"], [17, 1, "C"], [18, 11, "V"], [1, 13, "U"], [14, 0, "L"], [4, 0, "C"]]);
    put(g, [[6, 11, "K"], [7, 11, "K"], [12, 11, "K"], [13, 11, "K"], [8, 13, "K"], [9, 13, "K"], [10, 13, "K"], [11, 13, "K"], [8, 14, "K"], [9, 14, "P"], [10, 14, "P"], [11, 14, "K"]]);
  },
  shiitake: (g) => put(g, [[6, 11, "g"], [8, 11, "g"], [11, 11, "g"], [13, 11, "g"], [9, 10, "g"], [10, 10, "g"]]),
  morchella: (g) => {
    // Round gold glasses on both eyes; a flat, unconvinced mouth.
    put(g, [[7, 10, "A"], [6, 11, "A"], [8, 11, "A"], [7, 12, "A"], [12, 10, "A"], [11, 11, "A"], [13, 11, "A"], [12, 12, "A"], [9, 10, "A"], [10, 10, "A"], [6, 12, "P"], [13, 12, "P"]]);
    put(g, [[8, 13, "K"], [9, 13, "K"], [10, 13, "K"], [11, 13, "K"], [9, 14, "W"], [10, 14, "W"]]);
  },
  cordyceps: (g) => {
    // The conductor: a baton up in the air, the music around it.
    put(g, [[15, 14, "g"], [16, 13, "w"], [17, 12, "w"], [18, 11, "w"]]);
    put(g, [[17, 0, "C"], [18, 0, "C"], [17, 1, "C"], [17, 2, "C"], [16, 3, "C"], [17, 3, "C"], [2, 1, "V"], [3, 1, "V"], [2, 2, "V"], [1, 3, "V"], [2, 3, "V"]]);
  },
  mycena: (g) => {
    // Eyes shut with joy, already off: speed lines behind.
    put(g, [[7, 11, "W"], [12, 11, "W"], [6, 11, "K"], [7, 10, "K"], [8, 11, "K"], [11, 11, "K"], [12, 10, "K"], [13, 11, "K"]]);
    put(g, [[0, 5, "S"], [1, 5, "S"], [0, 8, "S"], [1, 8, "S"], [2, 12, "S"], [3, 12, "S"], [4, 12, "S"], [3, 15, "S"], [4, 15, "S"]]);
  },
};

/** A row with only spaces left once its colours are out. */
// oxlint-disable-next-line no-control-regex -- the colours are exactly what is cut
const empty = (row: string): boolean => row.replace(/\x1b\[[0-9;]*m/g, "").trim() === "";

const fg = (c: string): string => `\x1b[38;2;${RGB[c]}m`;
const bg = (c: string): string => `\x1b[48;2;${RGB[c]}m`;

/** The mushroom for `profile` as terminal rows, its empty rows above and below left out. */
export function mushroomArt(profile?: string): string[] {
  const grid: Grid = BASE.map((row) => row.split(""));
  FACES[profile ?? ""]?.(grid);
  const rows: string[] = [];
  for (let y = 0; y < grid.length; y += 2) {
    const top = grid[y] ?? [];
    const bottom = grid[y + 1] ?? [];
    let line = "";
    for (let x = 0; x < 20; x++) {
      const t = top[x] ?? ".";
      const b = bottom[x] ?? ".";
      if (t === "." && b === ".") line += " ";
      else if (b === ".") line += `${fg(t)}▀\x1b[0m`;
      else if (t === ".") line += `${fg(b)}▄\x1b[0m`;
      else line += `${fg(t)}${bg(b)}▀\x1b[0m`;
    }
    rows.push(line);
  }
  while (rows.length > 0 && empty(rows[0] ?? "")) rows.shift();
  while (rows.length > 0 && empty(rows.at(-1) ?? "")) rows.pop();
  return rows;
}
