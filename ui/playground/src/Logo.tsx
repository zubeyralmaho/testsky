import darkSrc from './assets/logo-dark.webp';
import lightSrc from './assets/logo-light.webp';
import './Logo.less';

/** The logo: the day sky on a light theme, the night sky on a dark one. */
export const Logo = () => (
  <div className="logo testsky-logo">
    <img className="testsky-logo-light" src={lightSrc} alt="tesky" />
    <img className="testsky-logo-dark" src={darkSrc} alt="tesky" />
  </div>
);
