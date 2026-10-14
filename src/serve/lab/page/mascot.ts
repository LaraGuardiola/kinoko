// The profile's mushroom in the Lab's corner: the terminal's pixel art (src/tui/mushroom-art.ts),
// one SVG square per pixel, so it stays crisp at any size.

import { MUSHROOM_RGB, mushroomGrid } from "../../../tui/mushroom-art.ts";

const SVG = "http://www.w3.org/2000/svg";

export function drawMascot(root: HTMLElement, profile: string | undefined): void {
  const grid = mushroomGrid(profile);
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 20 18");
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", profile ? `kinoko, ${profile}` : "kinoko");
  grid.forEach((row, y) =>
    row.forEach((c, x) => {
      const rgb = MUSHROOM_RGB[c];
      if (rgb === undefined) return;
      const px = document.createElementNS(SVG, "rect");
      for (const [k, v] of Object.entries({ x, y, width: 1.02, height: 1.02, fill: `rgb(${rgb.replaceAll(";", ",")})` })) px.setAttribute(k, String(v));
      svg.appendChild(px);
    }),
  );
  root.replaceChildren(svg);
}
