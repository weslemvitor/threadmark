import { loadConfig } from "./config.js";
import {
  requestWebBuildReload,
  webBuildReloadPath,
} from "./web-build-reload.js";

const config = loadConfig();
await requestWebBuildReload(webBuildReloadPath(config.dataDir));
console.log("Recarregamento da interface local solicitado.");
