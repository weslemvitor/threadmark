#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const whatsappJidPattern = /\b(\d{10,20})@(s\.whatsapp\.net|lid|g\.us)\b/g;
const brazilPhonePatterns = [
  /(?<!\d)\+?55[\s().-]*(?:\d[\s().-]*){10,11}(?!\d)/g,
  /(?<!\d)\(\d{2}\)[\s.-]*\d{4,5}[\s.-]*\d{4}(?!\d)/g,
];
const textFilePattern = /\.(?:cjs|css|html|js|json|jsx|md|mjs|sql|ts|tsx|txt|ya?ml)$/i;
const ignoredFiles = new Set(["package-lock.json"]);

function hasLongRepeatedRun(value) {
  return /(\d)\1{4,}/.test(value);
}

function hasFixtureSequence(value) {
  return /(?:012345|123456|234567|345678|456789|987654)/.test(value);
}

export function isClearlySyntheticIdentifier(value, kind = "phone") {
  const digits = value.replace(/\D/g, "");

  if (digits.startsWith("5500") || digits.includes("000000")) return true;
  if (hasLongRepeatedRun(digits) || hasFixtureSequence(digits)) return true;
  if (kind === "lid" && digits.startsWith("900000000000")) return true;
  if (kind === "group" && digits.startsWith("120363") && digits.length < 18) return true;
  if (digits.startsWith("120255501") && digits.length === 11) return true;

  return false;
}

export function findUnsafeIdentifiers(content, path) {
  const findings = [];
  const coveredRanges = [];

  for (const match of content.matchAll(whatsappJidPattern)) {
    const digits = match[1];
    const suffix = match[2];
    const kind = suffix === "lid" ? "lid" : suffix === "g.us" ? "group" : "phone";
    const start = match.index ?? 0;
    const end = start + match[0].length;
    coveredRanges.push([start, end]);

    if (!isClearlySyntheticIdentifier(digits, kind)) {
      findings.push({
        path,
        line: content.slice(0, start).split("\n").length,
        kind: `whatsapp-${kind}`,
      });
    }
  }

  for (const pattern of brazilPhonePatterns) {
    for (const match of content.matchAll(pattern)) {
      const start = match.index ?? 0;
      if (coveredRanges.some(([rangeStart, rangeEnd]) => start >= rangeStart && start < rangeEnd)) continue;

      const digits = match[0].replace(/\D/g, "");
      const normalized = digits.startsWith("55") ? digits : `55${digits}`;
      if (!isClearlySyntheticIdentifier(normalized, "phone")) {
        findings.push({
          path,
          line: content.slice(0, start).split("\n").length,
          kind: "phone",
        });
      }
    }
  }

  return findings;
}

export function checkTrackedFiles(cwd = process.cwd()) {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd, encoding: "utf8" },
  )
    .split("\0")
    .filter((path) => path && textFilePattern.test(path) && !ignoredFiles.has(path));
  const findings = [];

  for (const path of files) {
    let content;
    try {
      content = readFileSync(resolve(cwd, path), "utf8");
    } catch {
      continue;
    }
    findings.push(...findUnsafeIdentifiers(content, path));
  }

  return findings;
}

function main() {
  const findings = checkTrackedFiles();
  if (findings.length === 0) {
    console.log("Privacy fixture check passed: tracked and new files contain only clearly synthetic phone and WhatsApp identifiers.");
    return;
  }

  console.error("Potential personal identifiers found in publishable text:");
  for (const finding of findings) {
    console.error(`- ${finding.path}:${finding.line} (${finding.kind})`);
  }
  console.error("Replace them with obvious fixtures such as +5500000000000, 900000000000001@lid, or 120363000000000000@g.us.");
  process.exitCode = 1;
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
