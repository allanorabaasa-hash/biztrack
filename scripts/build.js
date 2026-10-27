const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const webDir = path.join(root, "www");

fs.rmSync(webDir, { recursive: true, force: true });
fs.mkdirSync(webDir, { recursive: true });

for (const file of ["index.html", "manifest.webmanifest", "sw.js"]) {
  fs.copyFileSync(path.join(root, file), path.join(webDir, file));
}
fs.cpSync(path.join(root, "static"), path.join(webDir, "static"), {
  recursive: true,
});

const capacitorVendorDir = path.join(webDir, "static", "vendor", "capacitor");
fs.mkdirSync(capacitorVendorDir, { recursive: true });
const capacitorBundles = [
  ["capacitor.js", "@capacitor/core/dist/capacitor.js"],
  ["app.js", "@capacitor/app/dist/plugin.js"],
  ["network.js", "@capacitor/network/dist/plugin.js"],
  ["status-bar.js", "@capacitor/status-bar/dist/plugin.js"],
  ["splash-screen.js", "@capacitor/splash-screen/dist/plugin.js"],
];
for (const [destination, source] of capacitorBundles) {
  fs.copyFileSync(
    path.join(root, "node_modules", source),
    path.join(capacitorVendorDir, destination),
  );
}

const indexPath = path.join(webDir, "index.html");
let indexHtml = fs.readFileSync(indexPath, "utf8");
const pluginScripts = capacitorBundles
  .map(
    ([destination]) =>
      `    <script src="./static/vendor/capacitor/${destination}" defer></script>`,
  )
  .join("\n");
indexHtml = indexHtml.replace(
  '    <script src="./static/vendor/supabase-2.56.0.min.js" defer></script>',
  `    <script src="./static/vendor/supabase-2.56.0.min.js" defer></script>\n${pluginScripts}`,
);
fs.writeFileSync(indexPath, indexHtml);

console.log("Copied BizTrack web app to www/.");
