// Runs as the Netlify build command. Fills __SITE_URL__ (link previews, search info, sitemap) with the
// site's main address, which Netlify provides as URL (your custom domain once it's connected).
import { readFile, writeFile } from "node:fs/promises";
const url = (process.env.URL || "").replace(/\/+$/, "");
for (const f of ["public/index.html", "public/robots.txt", "public/sitemap.xml"]) {
  const text = await readFile(f, "utf8");
  await writeFile(f, text.replaceAll("__SITE_URL__", url));
}
console.log(`Site address stamped: ${url || "(none set, links left relative)"}`);
