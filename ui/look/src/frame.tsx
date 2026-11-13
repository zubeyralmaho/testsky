import type { ReactNode } from 'react';
import { GLYPHS, type GlyphName } from './glyph-set';

/** One of Tesky's glyphs, in the colour of the text around it. */
export const Glyph = ({
  name,
  size = 16,
  width = 1.7,
}: {
  name: GlyphName;
  size?: number;
  width?: number;
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={width}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    // The set is authored in glyph-set.ts, never built from data.
    // biome-ignore lint/security/noDangerouslySetInnerHtml: static glyph markup
    dangerouslySetInnerHTML={{ __html: GLYPHS[name] }}
  />
);

/** The two platforms as Tesky marks them: filled shapes, not strokes. An unknown one is a phone. */
export const PlatformMark = ({ platform, size = 14 }: { platform?: string; size?: number }) => {
  if (platform === 'android') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="currentColor"
          fillRule="evenodd"
          d="M2.6 18 C2.6 12.8 6.8 8.8 12 8.8 C17.2 8.8 21.4 12.8 21.4 18 Z M7.05 14.4 a1.2 1.2 0 1 0 2.4 0 a1.2 1.2 0 1 0 -2.4 0 Z M14.55 14.4 a1.2 1.2 0 1 0 2.4 0 a1.2 1.2 0 1 0 -2.4 0 Z"
        />
        <path d="M7.3 10.9 L5.2 7.3 M16.7 10.9 L18.8 7.3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      </svg>
    );
  }
  if (platform === 'ios') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="currentColor"
          d="M12.5 6.5 C12.4 4.6 13.8 2.8 15.8 2.4 C15.9 4.3 14.5 6.2 12.5 6.5 Z M12 8 C10.9 8 10.1 7.1 8.6 7.1 C6.2 7.1 4.1 9.1 4.1 12.5 C4.1 16.4 6.7 21 8.9 21 C10.1 21 10.6 20.3 12 20.3 C13.4 20.3 13.9 21 15.1 21 C17 21 18.8 18.2 19.8 15.7 C18 14.9 17 13.4 17 11.7 C17 10.2 17.8 9 18.9 8.3 C17.9 7.2 16.6 7 15.5 7 C14 7 13.1 8 12 8 Z"
        />
      </svg>
    );
  }
  return <Glyph name="phone" size={size} />;
};

/** A glyph in a glass orb, Tesky's way of setting an icon down. */
export const Orb = ({
  children,
  size = 32,
  tone,
}: {
  children: ReactNode;
  size?: number;
  tone?: 'ice' | 'amber';
}) => (
  <span className={`ts-orb${tone ? ` ${tone}` : ''}`} style={{ width: size, height: size }}>
    {children}
  </span>
);

/** An entry of the floating sidebar: an orb, a label, a count, and the pill when it is the one shown. */
export const NavItem = ({
  glyph,
  label,
  count,
  on,
  toggle,
  disabled,
  title,
  onClick,
}: {
  glyph: GlyphName;
  label: string;
  count?: number | string;
  on?: boolean;
  /** A switch rather than a place: lit ice when on, so it is never mistaken for the page shown. */
  toggle?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
}) => (
  <button
    type="button"
    className={`ts-nav-item${on ? ' on' : ''}${toggle ? ' toggle' : ''}`}
    aria-pressed={on}
    disabled={disabled}
    title={title}
    onClick={onClick}
  >
    <Orb size={24}>
      <Glyph name={glyph} size={13} />
    </Orb>
    <span className="ts-nav-label">{label}</span>
    {count !== undefined ? <span className="ts-count">{count}</span> : null}
  </button>
);
