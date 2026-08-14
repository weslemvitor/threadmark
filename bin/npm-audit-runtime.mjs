#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const allowedAdvisories = new Set([
  "https://github.com/advisories/GHSA-5p2g-fcmc-qvqq",
  "https://github.com/advisories/GHSA-w3rx-r6r6-pgpr",
  "https://github.com/advisories/GHSA-xcpc-8h2w-3j85",
]);

const result = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["audit", "--omit=dev", "--audit-level=high", "--json"],
  { encoding: "utf8" },
);

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  process.stderr.write(result.stderr);
  process.stderr.write(result.stdout);
  process.stderr.write("Nao foi possivel interpretar o relatorio do npm audit.\n");
  process.exit(1);
}

const vulnerabilities = report.vulnerabilities ?? {};

function advisoryUrlsFor(name, visited = new Set()) {
  if (visited.has(name)) {
    return new Set();
  }
  visited.add(name);

  const vulnerability = vulnerabilities[name];
  if (!vulnerability) {
    return new Set();
  }

  const urls = new Set();
  for (const via of vulnerability.via ?? []) {
    if (typeof via === "string") {
      for (const url of advisoryUrlsFor(via, visited)) {
        urls.add(url);
      }
    } else if (via?.url) {
      urls.add(via.url);
    }
  }
  return urls;
}

const blocking = Object.values(vulnerabilities).filter((vulnerability) => {
  if (!["high", "critical"].includes(vulnerability.severity)) {
    return false;
  }
  const urls = advisoryUrlsFor(vulnerability.name);
  return urls.size === 0 || [...urls].some((url) => !allowedAdvisories.has(url));
});

if (blocking.length > 0) {
  process.stderr.write(result.stderr);
  process.stderr.write(
    `${JSON.stringify(
      {
        ...report,
        vulnerabilities: Object.fromEntries(
          blocking.map((item) => [item.name, item]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  process.exit(1);
}

const acknowledged = Object.values(vulnerabilities).filter((vulnerability) =>
  ["high", "critical"].includes(vulnerability.severity),
);

if (acknowledged.length > 0) {
  process.stdout.write(
    `Auditoria aprovada com ${acknowledged.length} dependencia(s) transitiva(s) coberta(s) por advisories upstream sem correcao compativel.\n`,
  );
} else {
  process.stdout.write("Auditoria de dependencias de producao aprovada sem ressalvas.\n");
}
