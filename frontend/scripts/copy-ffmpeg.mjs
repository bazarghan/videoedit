import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(here, "..");
const modules = path.join(frontend, "node_modules", "@ffmpeg");
const publicDir = path.join(frontend, "public", "ffmpeg");

const files = [
  ["core/dist/esm/ffmpeg-core.js", "ffmpeg-core.js"],
  ["core/dist/esm/ffmpeg-core.wasm", "ffmpeg-core.wasm"],
];

mkdirSync(publicDir, { recursive: true });
for (const [source, target] of files) {
  const from = path.join(modules, source);
  const to = path.join(publicDir, target);
  if (!existsSync(from)) {
    throw new Error(`Missing ${from}. Run npm install first.`);
  }
  mkdirSync(path.dirname(to), { recursive: true });
  if (
    !existsSync(to) ||
    statSync(from).size !== statSync(to).size ||
    statSync(from).mtimeMs > statSync(to).mtimeMs
  ) {
    copyFileSync(from, to);
    console.log(`copied ${target}`);
  }
}
