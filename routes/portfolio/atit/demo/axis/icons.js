// The icons the face shows while an agent works: what kind of thing it has picked up. Each is a few
// strokes on a 24 by 24 grid, drawn with a round pen, the way docs/face.md section 8 says. This file
// is the one definition: scripts/gen-icons.mjs writes the board's copy (firmware/.../icons.h) from it.

/** A closed ring of straight pieces, near enough a circle or an ellipse at this size. */
const ring = (cx, cy, rx, ry = rx, from = 0, to = 2 * Math.PI, pieces = 16) => {
  const points = [];
  const count = Math.max(2, Math.round((pieces * Math.abs(to - from)) / (2 * Math.PI)));
  for (let i = 0; i <= count; i++) {
    const angle = from + ((to - from) * i) / count;
    points.push(Math.round((cx + rx * Math.cos(angle)) * 10) / 10, Math.round((cy + ry * Math.sin(angle)) * 10) / 10);
  }
  return points;
};
const dot = (x, y) => [x, y, x + 0.1, y];

/** Name to strokes; a stroke is x, y, x, y, ... along one line. */
export const ICONS = {
  // A lens and its handle.
  search: [ring(10.5, 10.5, 6), [15, 15, 20, 20]],
  // A globe: the outline, one meridian and the equator.
  web: [ring(12, 12, 8), ring(12, 12, 3.4, 8), [4, 12, 20, 12]],
  // A house: the roof and the walls.
  home: [[3.5, 11.5, 12, 4, 20.5, 11.5], [6, 10, 6, 20, 18, 20, 18, 10]],
  // A calendar leaf with its two rings.
  calendar: [[4, 6, 20, 6, 20, 20, 4, 20, 4, 6], [4, 10.5, 20, 10.5], [8, 3.5, 8, 7], [16, 3.5, 16, 7]],
  // Three lines, each with its mark.
  list: [dot(5, 7), [9, 7, 20, 7], dot(5, 12), [9, 12, 20, 12], dot(5, 17), [9, 17, 20, 17]],
  // A sheet with a folded corner.
  files: [[7, 3, 14, 3, 19, 8, 19, 21, 7, 21, 7, 3], [14, 3, 14, 8, 19, 8]],
  // Angle brackets.
  code: [[9, 7, 4, 12, 9, 17], [15, 7, 20, 12, 15, 17]],
  // A stopwatch: the button, the case and the hand.
  timer: [[10, 3, 14, 3], ring(12, 13.5, 7.5), [12, 13.5, 12, 9], [12, 13.5, 15, 15.5]],
  // A speech bubble.
  message: [[4, 5, 20, 5, 20, 16, 11, 16, 7, 20, 7, 16, 4, 16, 4, 5]],
  // A store of things kept: a drum with a band round it.
  memory: [ring(12, 6.5, 7, 3), [5, 6.5, 5, 17.5], [19, 6.5, 19, 17.5], ring(12, 17.5, 7, 3, 0, Math.PI), ring(12, 12, 7, 3, 0, Math.PI)],
  // A picture: the frame, a hill line and the sun.
  image: [[3.5, 5, 20.5, 5, 20.5, 19, 3.5, 19, 3.5, 5], [3.5, 16, 9, 11, 13, 15, 16, 12.5, 20.5, 16.5], ring(15.5, 9, 1.3, 1.3, 0, 2 * Math.PI, 8)],
  // A computer: the screen, its stand and foot. An agent looking at or using one (the desktop tool).
  computer: [[3.5, 4.5, 20.5, 4.5, 20.5, 15.5, 3.5, 15.5, 3.5, 4.5], [12, 15.5, 12, 19.5], [7.5, 19.5, 16.5, 19.5]],
  // Any other tool: a hub with rays, like a small cog.
  tool: [ring(12, 12, 3.5), ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
    const a = (i * Math.PI) / 4, c = Math.cos(a), s = Math.sin(a);
    return [Math.round((12 + 6 * c) * 10) / 10, Math.round((12 + 6 * s) * 10) / 10, Math.round((12 + 8.5 * c) * 10) / 10, Math.round((12 + 8.5 * s) * 10) / 10];
  })],
};

/** Side of the square an icon is drawn in, in the face's 240 grid, and the width of the pen. */
export const ICON_SIZE = 52;
export const ICON_PEN = 3.4;
/** How far the arms stand back from the centre to make room for an icon, in the 240 grid. */
export const ICON_HOLE = 36;

// --- the same icons, made of the face's own dots ----------------------------------------

/** How many dots the face has: three arms of twenty-six. An icon made of dots uses every one. */
export const ICON_DOTS = 78;
/** Side of the square a dot shape fills, in the face's 240 grid, and the radius of each dot in it. */
export const SHAPE_SIZE = 150;
export const SHAPE_DOT = 2.9;
/** With fewer dots than all in the shape, the rest turn in a ring this far out, clear of it. */
export const SHAPE_HALO = 80;
/** How long an icon takes to form unless a setting says otherwise, in milliseconds, and the fewest dots a shape may have. */
export const ICON_MS = 700;
export const SHAPE_DOTS_MIN = 12;

/**
 * A colour each kind leans towards when it is drawn in dots, so something changes even at a
 * glance from across the room. Red, green, blue, 0 to 1.
 */
export const ICON_TINTS = {
  search: [0.35, 0.85, 1.0],
  web: [0.4, 0.6, 1.0],
  home: [1.0, 0.72, 0.3],
  calendar: [1.0, 0.5, 0.6],
  list: [0.5, 1.0, 0.6],
  files: [0.9, 0.9, 1.0],
  code: [0.65, 1.0, 0.35],
  timer: [1.0, 0.6, 0.25],
  message: [0.3, 1.0, 0.85],
  memory: [0.75, 0.5, 1.0],
  image: [1.0, 0.45, 0.9],
  computer: [1.0, 0.32, 0.62],
  tool: [0.8, 0.82, 0.9],
};

/**
 * Where each of the face's dots goes to draw an icon: `count` points set evenly along its strokes,
 * as x, y, x, y, ... on the 24 grid, to one decimal. Every stroke gets at least one dot and
 * otherwise its share by length, so a short stroke is not lost and a long one is not thin.
 */
export function iconDots(name, count = ICON_DOTS) {
  const strokes = ICONS[name];
  if (!strokes) return undefined;
  const lengthOf = (stroke) => {
    let length = 0;
    for (let i = 2; i < stroke.length; i += 2) length += Math.hypot(stroke[i] - stroke[i - 2], stroke[i + 1] - stroke[i - 1]);
    return length;
  };
  const lengths = strokes.map(lengthOf);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const share = lengths.map((length) => Math.max(1, Math.round((count * length) / total)));
  // Rounding leaves a dot or two over or short: the longest stroke takes the difference.
  const longest = lengths.indexOf(Math.max(...lengths));
  share[longest] += count - share.reduce((sum, n) => sum + n, 0);

  const points = [];
  strokes.forEach((stroke, index) => {
    const n = share[index], step = lengths[index] / n;
    let piece = 0, before = 0;
    for (let k = 0; k < n; k++) {
      const at = (k + 0.5) * step;
      // Walk to the straight piece this distance falls on.
      for (;;) {
        const length = Math.hypot(stroke[piece * 2 + 2] - stroke[piece * 2], stroke[piece * 2 + 3] - stroke[piece * 2 + 1]);
        if (at <= before + length || piece * 2 + 4 >= stroke.length) {
          const along = length ? Math.min(1, (at - before) / length) : 0;
          points.push(
            Math.round((stroke[piece * 2] + (stroke[piece * 2 + 2] - stroke[piece * 2]) * along) * 10) / 10,
            Math.round((stroke[piece * 2 + 1] + (stroke[piece * 2 + 3] - stroke[piece * 2 + 1]) * along) * 10) / 10,
          );
          break;
        }
        before += length;
        piece++;
      }
    }
  });
  return points;
}
