import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const root = join(import.meta.dirname, "..");
const dir = join(root, "templates");

const files = readdirSync(dir).filter((f) => f.endsWith(".html")).sort();

let out = "// AUTO-GENERATED from templates/*.html - dokunmayin, kaynak dosyalari duzenleyin.\n";
out += "export const TEMPLATES: Record<string, string> = {\n";
for (const f of files) {
  out += `  ${JSON.stringify(basename(f, ".html"))}: ${JSON.stringify(readFileSync(join(dir, f), "utf-8"))},\n`;
}
out += "};\n";

writeFileSync(join(root, "src", "lib", "mail", "generated-templates.ts"), out);
console.log(`generated-templates.ts yazildi (${files.length} sablon).`);
