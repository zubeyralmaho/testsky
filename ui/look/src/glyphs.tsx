/**
 * Tesky's glyphs: drawn for the product on a 24px grid, one stroke, one lit
 * point each -- never an icon set or an emoji. Night is the product's own;
 * day is drawn the same way for the theme switch.
 */
const ICE = '#7AC8F5';

const Glyph = ({ size, children }: { size: number; children: React.ReactNode }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.7}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const NightGlyph = ({ size = 18 }: { size?: number }) => (
  <Glyph size={size}>
    <path d="M19.5 14.5 A8 8 0 1 1 9.5 4.5 A6.5 6.5 0 0 0 19.5 14.5 Z" />
    <circle cx="17.6" cy="5.2" r="1.1" fill={ICE} stroke="none" />
  </Glyph>
);

export const DayGlyph = ({ size = 18 }: { size?: number }) => (
  <Glyph size={size}>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.8 V5 M12 19 V21.2 M2.8 12 H5 M19 12 H21.2 M5.5 5.5 L7.1 7.1 M16.9 16.9 L18.5 18.5 M5.5 18.5 L7.1 16.9 M16.9 7.1 L18.5 5.5" />
    <circle cx="12" cy="12" r="1.2" fill={ICE} stroke="none" />
  </Glyph>
);
