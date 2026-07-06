// Typed re-export of the wasm-pack output in ./pkg (built from rust/wasm).
// Consumers call `init()` once (in a worker, never the audio thread) and then
// use the exported bindings.

export { default as init, version } from "../pkg/antiphon.js";
