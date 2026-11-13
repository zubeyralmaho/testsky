// The visualizer is compiled from source with svgr's default export: a plain
// .svg import is a component, as in ui/report.
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

declare module '*.webp' {
  const src: string;
  export default src;
}

declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*.woff2' {
  const src: string;
  export default src;
}
