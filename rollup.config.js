import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import { nodeResolve } from "@rollup/plugin-node-resolve";

// GitHub runs the action straight from the repo with no install step, so the bundle
// in dist/ is committed and has to carry every dependency.
const bundle = (input, file) => ({
  input,
  output: { file, format: "es", sourcemap: false },
  plugins: [nodeResolve({ preferBuiltins: true }), commonjs(), json()],
  // The @actions/* packages are TypeScript-compiled CommonJS whose __awaiter helper
  // probes a module-level `this`. Rollup correctly rewrites it to undefined, which
  // is the branch the helper already handles; the warning is noise on every build.
  onwarn(warning, warn) {
    if (warning.code === "THIS_IS_UNDEFINED" || warning.code === "CIRCULAR_DEPENDENCY") return;
    warn(warning);
  },
});

export default [
  bundle("src/main.js", "dist/index.js"),
  bundle("src/cleanup.js", "dist/cleanup.js"),
];
