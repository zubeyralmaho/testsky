import monoLatinExt from '@fontsource-variable/geist-mono/files/geist-mono-latin-ext-wght-normal.woff2';
import monoLatin from '@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2';
import geistLatinExt from '@fontsource-variable/geist/files/geist-latin-ext-wght-normal.woff2';
import geistLatin from '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2';
import serifItalic from '@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2';
import serifLatinExt from '@fontsource/instrument-serif/files/instrument-serif-latin-ext-400-normal.woff2';
import serifLatin from '@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2';

/**
 * Tesky's three faces: Geist for the interface, Geist Mono for what the
 * product prints (codes, files, counts), Instrument Serif for display and
 * numbers, roman and italic, never bold. They are inlined, so a report is
 * still one file and asks no third party for anything.
 *
 * The subsets are Fontsource's, as Tesky's control plane serves them: a
 * Turkish name pulls in the extended file only when it is on the page.
 */
const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';

const face = (family: string, src: string, weight: string, range: string, style = 'normal') =>
  `@font-face{font-family:'${family}';font-style:${style};font-display:swap;font-weight:${weight};src:url(${src}) format('woff2');unicode-range:${range}}`;

const FACES = [
  face('Geist', geistLatinExt, '100 900', LATIN_EXT),
  face('Geist', geistLatin, '100 900', LATIN),
  face('Geist Mono', monoLatinExt, '100 900', LATIN_EXT),
  face('Geist Mono', monoLatin, '100 900', LATIN),
  face('Instrument Serif', serifLatinExt, '400', LATIN_EXT),
  face('Instrument Serif', serifLatin, '400', LATIN),
  face('Instrument Serif', serifItalic, '400', LATIN, 'italic'),
].join('\n');

if (typeof document !== 'undefined' && !document.getElementById('testsky-fonts')) {
  const style = document.createElement('style');
  style.id = 'testsky-fonts';
  style.textContent = FACES;
  document.head.appendChild(style);
}
