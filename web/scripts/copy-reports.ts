// Copies ../reports into public/data so the Vercel build is self-contained.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const src = join(root, "..", "reports");
const dest = join(root, "public", "data");

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
if (existsSync(src)) {
  cpSync(src, dest, { recursive: true });
  console.log(`copied ${src} -> ${dest}`);
} else {
  console.warn(`no reports dir at ${src}; public/data is empty`);
}
