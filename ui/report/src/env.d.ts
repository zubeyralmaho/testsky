// Not rsbuild's own asset types: they type every .svg as a URL, and this build
// makes a plain .svg import a component. The few other assets are typed here.
declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*.woff2' {
  const src: string;
  export default src;
}

// testsky builds the report and the visualizer in one pass, with svgr's
// default export: a plain .svg import is a component, as the visualizer expects.
declare module '*.svg' {
  const ReactComponent: React.FunctionComponent<
    React.SVGProps<SVGSVGElement> & { style?: React.CSSProperties }
  >;
  export default ReactComponent;
}

declare module '*.svg?react' {
  const ReactComponent: React.FunctionComponent<React.SVGProps<SVGSVGElement>>;
  export default ReactComponent;
}
