import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { InvestigationToolDescriptor, InvestigationToolResult } from "./types.js";

const operationSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(4_000),
  argumentsExample: z.string().max(20_000),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  constraints: z.array(z.string().max(2_000)).max(50).optional(),
  effect: z.enum(["read", "prepare", "write"]).optional(),
  authorization: z.enum(["none", "task"]).optional(),
  automaticFollowUpOperation: z.string().max(200).optional(),
}).strict();

const descriptorSchema = z.object({
  id: z.string().trim().min(1).max(500),
  configurationId: z.string().trim().min(1).max(500).optional(),
  name: z.string().trim().min(1).max(500),
  type: z.enum([
    "codebase",
    "knowledge",
    "debugger_skill",
    "postgres_readonly",
    "clickhouse_readonly",
    "aws_cloudwatch",
    "vercel",
    "connected_app",
  ]),
  description: z.string().max(4_000).nullable(),
  scope: z.string().max(10_000),
  operations: z.array(operationSchema).min(1).max(100),
}).strict();

const manifestSchema = z.object({
  version: z.literal(1),
  databasePath: z.string().refine(path.isAbsolute, "databasePath must be absolute"),
  dataDir: z.string().refine(path.isAbsolute, "dataDir must be absolute"),
  commandHome: z.string().refine(path.isAbsolute, "commandHome must be absolute").nullable(),
  resultLogPath: z.string().refine(path.isAbsolute, "resultLogPath must be absolute"),
  authorizedDescriptors: z.array(descriptorSchema).max(100),
  maxOperations: z.number().int().min(1).max(100),
  maxSameOperation: z.number().int().min(1).max(100),
  maxCodeSearchOperations: z.number().int().min(1).max(100),
}).strict();

export interface ToolBridgeManifest {
  version: 1;
  databasePath: string;
  dataDir: string;
  commandHome: string | null;
  resultLogPath: string;
  authorizedDescriptors: InvestigationToolDescriptor[];
  maxOperations: number;
  maxSameOperation: number;
  maxCodeSearchOperations: number;
}

export function parseToolBridgeManifest(value: unknown): ToolBridgeManifest {
  return manifestSchema.parse(value) as ToolBridgeManifest;
}

export async function readToolBridgeManifest(filePath: string): Promise<ToolBridgeManifest> {
  return parseToolBridgeManifest(JSON.parse(await readFile(filePath, "utf8")));
}

export async function appendToolBridgeResult(
  filePath: string,
  result: InvestigationToolResult,
): Promise<void> {
  await appendFile(filePath, `${JSON.stringify(result)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function readToolBridgeResults(filePath: string): Promise<InvestigationToolResult[]> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return content.split(/\r?\n/u).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const value = JSON.parse(line) as InvestigationToolResult;
      if (
        !value ||
        typeof value !== "object" ||
        typeof value.requestId !== "string" ||
        typeof value.toolId !== "string" ||
        typeof value.operation !== "string" ||
        (value.status !== "success" && value.status !== "error")
      ) return [];
      return [value];
    } catch {
      return [];
    }
  });
}
