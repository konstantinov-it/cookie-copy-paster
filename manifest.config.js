import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "Cookie Copy Paster",
  version: "1.0.1",
  description: "Копирует выбранные cookie с одного URL на другой.",
  icons: {
    16: "icons/icon16.png",
    32: "icons/icon32.png",
    48: "icons/icon48.png",
    128: "icons/icon128.png",
  },
  permissions: ["cookies", "storage", "tabs", "scripting"],
  host_permissions: ["<all_urls>"],
  background: {
    service_worker: "src/background/index.js",
    type: "module",
  },
  action: {
    default_popup: "index.html",
    default_title: "Cookie Copy Paster",
  },
});
