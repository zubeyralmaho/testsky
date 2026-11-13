/**
 * Glyphs from Tesky's product stylesheet (apps/control-plane look.ts): drawn
 * for the product on a 24px grid, one stroke, one lit point each. Inner SVG,
 * authored here and never built from data.
 */
export const GLYPHS = {
  agent: "<path d=\"M12 3.2 L13.7 9.1 L19.6 10.8 L13.7 12.5 L12 18.4 L10.3 12.5 L4.4 10.8 L10.3 9.1 Z\"></path><path d=\"M18.5 16.5 v3.4 M16.8 18.2 h3.4\"></path><circle cx=\"12\" cy=\"10.8\" r=\"1\" fill=\"#7AC8F5\" stroke=\"none\"></circle>",
  assert: "<path d=\"M5 9.5 H19 M5 14.5 H19 M15 5.5 L9 18.5\"></path>",
  broken: "<rect x=\"6.5\" y=\"2.8\" width=\"11\" height=\"18.4\" rx=\"2.6\"></rect><path d=\"M12.9 6.4 L10.4 11 L13.5 12.7 L11.2 17.2\"></path><circle cx=\"11.2\" cy=\"17.6\" r=\"1.2\" fill=\"#E7B375\" stroke=\"none\"></circle>",
  check: "<path d=\"M6.5 12.5 l3.5 3.5 L17.5 8.5\"></path>",
  chip: "<rect x=\"6\" y=\"6\" width=\"12\" height=\"12\" rx=\"3\"></rect><path d=\"M9.5 3 V6 M14.5 3 V6 M9.5 18 V21 M14.5 18 V21 M3 9.5 H6 M3 14.5 H6 M18 9.5 H21 M18 14.5 H21\"></path><circle cx=\"12\" cy=\"12\" r=\"1.5\" fill=\"#7AC8F5\" stroke=\"none\"></circle>",
  emulator: "<rect x=\"2.5\" y=\"4\" width=\"19\" height=\"13\" rx=\"2.5\"></rect><path d=\"M9 20.5 H15 M12 17 V20.5\"></path><rect x=\"9.5\" y=\"6.5\" width=\"5\" height=\"8\" rx=\"1.2\"></rect><circle cx=\"12\" cy=\"8.4\" r=\"0.8\" fill=\"#7AC8F5\" stroke=\"none\"></circle>",
  ground: "<circle cx=\"10.5\" cy=\"10.5\" r=\"6.3\" stroke-dasharray=\"3 2.6\"></circle><path d=\"M20.5 20.5 L15.3 15.3\"></path>",
  healed: "<path d=\"M19.5 12 A7.5 7.5 0 1 1 16.8 6.2 M17.3 3 V6.6 H13.7 M8.6 12.2 l2.4 2.4 l4.4 -4.6\"></path><circle cx=\"19.5\" cy=\"12\" r=\"1.1\" fill=\"#7AC8F5\" stroke=\"none\"></circle>",
  next: "<path d=\"M9.5 6 l6 6 l-6 6\"></path>",
  phone: "<rect x=\"6.5\" y=\"2.8\" width=\"11\" height=\"18.4\" rx=\"2.6\"></rect><path d=\"M10.5 18.2 H13.5\"></path><circle cx=\"12\" cy=\"5.6\" r=\"0.9\" fill=\"#7AC8F5\" stroke=\"none\"></circle>",
  play: "<path d=\"M8 5.5 V18.5 L18.5 12 Z\"></path>",
  replay: "<path d=\"M5.5 12 a6.5 6.5 0 1 0 2.2 -4.9 M7.2 3.6 V7.4 H11\"></path><circle cx=\"12\" cy=\"12\" r=\"2.2\"></circle><circle cx=\"12\" cy=\"12\" r=\"0.9\" fill=\"#7AC8F5\" stroke=\"none\"></circle>",
  report: "<path d=\"M6 2.8 H13.5 L19 8.3 V19.7 a1.5 1.5 0 0 1 -1.5 1.5 H6 a1.5 1.5 0 0 1 -1.5 -1.5 V4.3 a1.5 1.5 0 0 1 1.5 -1.5 Z M13.5 2.8 V8.3 H19 M9.2 10.6 V15.4 L13.2 13 Z M7.5 18.4 H16\"></path><circle cx=\"12.6\" cy=\"18.4\" r=\"1.2\" fill=\"#E7B375\" stroke=\"none\"></circle>",
  runs: "<path d=\"M5 12 a7 7 0 1 0 2.1 -5 M7 3.6 V7.2 H10.6\"></path><path d=\"M10.6 9.6 V14.4 L14.6 12 Z\"></path><circle cx=\"5\" cy=\"12\" r=\"1.1\" fill=\"#7AC8F5\" stroke=\"none\"></circle>",
  search: "<circle cx=\"10.5\" cy=\"10.5\" r=\"5.8\"></circle><path d=\"M15 15 L20 20\"></path>",
  server: "<rect x=\"3\" y=\"4\" width=\"18\" height=\"7\" rx=\"3.5\"></rect><rect x=\"3\" y=\"13\" width=\"18\" height=\"7\" rx=\"3.5\"></rect><path d=\"M7 7.5 H11 M7 16.5 H11\"></path><circle cx=\"16.8\" cy=\"16.5\" r=\"1.1\"></circle><circle cx=\"16.8\" cy=\"7.5\" r=\"1.1\" fill=\"#7AC8F5\" stroke=\"none\"></circle>",
  tests: "<rect x=\"4\" y=\"3.5\" width=\"16\" height=\"17\" rx=\"3\"></rect><path d=\"M8 8.5 H16 M8 12 H16 M8 15.5 H12.5\"></path><circle cx=\"17.2\" cy=\"17\" r=\"1.2\" fill=\"#7AC8F5\" stroke=\"none\"></circle>",
  tree: "<rect x=\"9\" y=\"3\" width=\"6\" height=\"4.5\" rx=\"1.6\"></rect><rect x=\"3\" y=\"16.5\" width=\"6\" height=\"4.5\" rx=\"1.6\"></rect><rect x=\"15\" y=\"16.5\" width=\"6\" height=\"4.5\" rx=\"1.6\"></rect><path d=\"M12 7.5 V12 M6 16.5 V14 Q6 12 8 12 H16 Q18 12 18 14 V16.5\"></path><circle cx=\"12\" cy=\"12\" r=\"1.2\" fill=\"#7AC8F5\" stroke=\"none\"></circle>",
} as const;

export type GlyphName = keyof typeof GLYPHS;
