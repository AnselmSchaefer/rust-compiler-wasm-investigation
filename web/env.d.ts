// Source files that esbuild bundles as text (`loader: { '.rs': 'text' }`).
declare module '*.rs' {
  const source: string;
  export default source;
}
