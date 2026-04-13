// The `@types/pdf-parse` package only declares types for the root import.
// We import from `pdf-parse/lib/pdf-parse.js` to bypass the package's
// index.js debug block that tries to read a bundled test PDF at import
// time. This shim declares the subpath so tsc stops complaining.
declare module 'pdf-parse/lib/pdf-parse.js' {
  import pdf from 'pdf-parse';
  export default pdf;
}
