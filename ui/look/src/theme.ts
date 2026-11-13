import { type ThemeConfig, theme } from 'antd';

/**
 * Tesky's colour, from the design's Style boards: black sky and grey-white
 * cloud by night, morning sky and white cloud by day, and the same two
 * lights in both -- ice for the agent and what it sees, amber for the app
 * that may be broken. A pass is not green: it is the text colour.
 */
export const PALETTE = {
  dark: {
    sky: '#050608',
    cloudTop: '#F4F5F7',
    cloudShade: '#8D929B',
    text: '#EDEFF3',
    muted: '#AEB3BC',
    dim: '#8E95A1',
    ice: '#7AC8F5',
    amber: '#E7B375',
  },
  light: {
    sky: '#F3F6FA',
    cloudTop: '#FFFFFF',
    cloudShade: '#C0CBDA',
    text: '#0B0F16',
    muted: '#4B5463',
    dim: '#616B7C',
    ice: '#1F86D0',
    amber: '#B06E1C',
  },
} as const;

export const FONT = {
  sans: "'Geist', 'Helvetica Neue', Helvetica, system-ui, sans-serif",
  mono: "'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace",
  serif: "'Instrument Serif', 'Iowan Old Style', Georgia, serif",
} as const;

/** antd, dressed as Tesky: round or half-round, depth from light rather than outlines. */
export function teskyTheme(dark: boolean): ThemeConfig {
  const p = dark ? PALETTE.dark : PALETTE.light;
  const hairline = dark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(11, 15, 22, 0.10)';
  return {
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      fontFamily: FONT.sans,
      fontFamilyCode: FONT.mono,
      fontSize: 14,
      colorPrimary: p.ice,
      colorInfo: p.ice,
      colorLink: p.ice,
      colorSuccess: p.text,
      colorWarning: p.amber,
      colorError: p.amber,
      colorText: p.text,
      colorTextSecondary: p.muted,
      colorTextTertiary: p.dim,
      colorTextQuaternary: p.dim,
      colorBgBase: p.sky,
      colorBgLayout: p.sky,
      colorBgContainer: dark ? '#0C0E12' : '#FFFFFF',
      colorBgElevated: dark ? '#14171C' : '#FFFFFF',
      colorBorder: hairline,
      colorBorderSecondary: hairline,
      colorSplit: hairline,
      borderRadius: 14,
      borderRadiusLG: 22,
      borderRadiusSM: 10,
      borderRadiusXS: 8,
      boxShadow: dark ? '0 24px 48px -24px rgba(0, 0, 0, 0.9)' : '0 24px 48px -28px rgba(30, 50, 80, 0.35)',
    },
    components: {
      Layout: { headerBg: 'transparent', bodyBg: 'transparent', headerHeight: 64, headerPadding: '0 24px' },
      // The primary button is Tesky's call to action: the white pill by night,
      // the ink pill by day. Ice stays for what the agent sees.
      Button: {
        borderRadius: 999,
        borderRadiusLG: 999,
        borderRadiusSM: 999,
        primaryShadow: 'none',
        defaultShadow: 'none',
        fontWeight: 500,
        colorPrimary: dark ? '#EEF0F3' : '#0B0F16',
        colorPrimaryHover: dark ? '#FFFFFF' : '#1C2230',
        colorPrimaryActive: dark ? '#DADDE2' : '#000000',
        primaryColor: dark ? '#0A0B0E' : '#FFFFFF',
        algorithm: false,
      },
      Tag: { borderRadiusSM: 999 },
      Tooltip: { borderRadius: 12 },
      Segmented: { borderRadius: 999, borderRadiusSM: 999, borderRadiusLG: 999 },
      Select: { borderRadius: 999 },
    },
  };
}
