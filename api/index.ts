// Vercel serverless entry point. Deliberately trivial: it re-exports the
// tsc-compiled handler so Vercel's esbuild bundler never recompiles the NestJS
// source, which would drop the decorator metadata DI depends on.
// Requires `nest build` to have run first — see buildCommand in vercel.json.
export { default } from "../apps/api/dist/serverless";
