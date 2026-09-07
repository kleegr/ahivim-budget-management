import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const projectRoot = process.cwd();
const projectRequire = createRequire(path.join(projectRoot, "package.json"));
const tesseractRoot = path.dirname(projectRequire.resolve("tesseract.js/package.json"));
const tesseractRequire = createRequire(path.join(tesseractRoot, "package.json"));
const tesseractCoreRoot = path.dirname(tesseractRequire.resolve("tesseract.js-core/package.json"));
const languagePackageRoot = path.dirname(projectRequire.resolve("@tesseract.js-data/eng/package.json"));
const publicRoot = path.join(projectRoot, "public", "tesseract", "7.0.0");
const coreRoot = path.join(publicRoot, "core");
const languageRoot = path.join(publicRoot, "lang");

const assets = [
  {
    source: path.join(tesseractRoot, "dist", "worker.min.js"),
    destination: path.join(publicRoot, "worker.min.js"),
  },
  ...[
    "tesseract-core-lstm.wasm.js",
    "tesseract-core-simd-lstm.wasm.js",
    "tesseract-core-relaxedsimd-lstm.wasm.js",
  ].map((filename) => ({
    source: path.join(tesseractCoreRoot, filename),
    destination: path.join(coreRoot, filename),
  })),
  {
    source: path.join(
      languagePackageRoot,
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
