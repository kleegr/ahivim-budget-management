import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const publicRoot = path.join(projectRoot, "public", "tesseract", "7.0.0");
const coreRoot = path.join(publicRoot, "core");
const languageRoot = path.join(publicRoot, "lang");

const assets = [
  {
    source: path.join(projectRoot, "node_modules", "tesseract.js", "dist", "worker.min.js"),
    destination: path.join(publicRoot, "worker.min.js"),
  },
  ...[
    "tesseract-core-lstm.wasm.js",
    "tesseract-core-simd-lstm.wasm.js",
    "tesseract-core-relaxedsimd-lstm.wasm.js",
  ].map((filename) => ({
    source: path.join(projectRoot, "node_modules", "tesseract.js-core", filename),
    destination: path.join(coreRoot, filename),
  })),
  {
    source: path.join(
      projectRoot,
      "node_modules",
      "@tesseract.js-data",
      "eng",
      "4.0.0_best_int",
      "eng.traineddata.gz",
    ),
    destination: path.join(languageRoot, "eng.traineddata.gz"),
  },
];

mkdirSync(coreRoot, { recursive: true });
mkdirSync(languageRoot, { recursive: true });

for (const { source, destination } of assets) {
  copyFileSync(source, destination);
}

console.log(`Prepared ${assets.length} local OCR assets in ${path.relative(projectRoot, publicRoot)}.`);
