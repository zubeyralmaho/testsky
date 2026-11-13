import darkSrc from '../assets/logo-dark.webp';
import lightSrc from '../assets/logo-light.webp';
import './logo.less';

/**
 * The logo in the report header: the day sky on a light theme, the night sky
 * on a dark one. Unlike the upstream logo it links nowhere.
 */
export const Logo = ({ hideLogo }: { hideLogo?: boolean }) =>
  hideLogo ? null : (
    <div className="logo testsky-logo">
      <img className="testsky-logo-light" src={lightSrc} alt="tesky" />
      <img className="testsky-logo-dark" src={darkSrc} alt="tesky" />
    </div>
  );
