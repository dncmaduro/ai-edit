import "server-only";

import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getProjectAnalysisDir, resolveProjectRelativeFile, StorageError } from "@/lib/storage";
import { semanticIndexSchema, type SemanticIndex } from "@/lib/semantic/schema";

export class SemanticArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemanticArtifactError";
  }
}

export function assertValidSemanticIndex(value: unknown): asserts value is SemanticIndex {
  const parsed = semanticIndexSchema.safeParse(value);
  if (!parsed.success) {
    throw new SemanticArtifactError("Semantic index artifact has an invalid shape.");
  }

  const ids = new Set<string>();
  for (const entry of parsed.data.segments) {
    if (ids.has(entry.segmentId)) {
      throw new SemanticArtifactError("Semantic index artifact contains duplicate segment IDs.");
    }
    ids.add(entry.segmentId);
  }
}

export function getSemanticIndexRelativePath(mediaId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(mediaId)) {
    throw new SemanticArtifactError("Media ID is invalid for semantic index persistence.");
  }
  return path.posix.join("analysis", `${mediaId}.semantic-index.json`);
}

export async function writeProjectSemanticIndex(projectId: string, index: SemanticIndex): Promise<string> {
  assertValidSemanticIndex(index);
  const relativePath = getSemanticIndexRelativePath(index.mediaId);
  const analysisDir = getProjectAnalysisDir(projectId);
  const outputPath = path.join(analysisDir, path.basename(relativePath));
  const tempPath = path.join(analysisDir, `.semantic-index-${randomUUID()}.tmp`);

  try {
    await writeFile(tempPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    await rename(tempPath, outputPath);
  } catch {
    throw new SemanticArtifactError("Unable to write semantic index artifact.");
  }

  return relativePath;
}

export async function readProjectSemanticIndex(
  projectId: string,
  relativePath: string,
  expectedMediaId: string,
): Promise<SemanticIndex> {
  let indexPath: string;
  try {
    indexPath = await resolveProjectRelativeFile(projectId, relativePath);
  } catch (error) {
    if (error instanceof StorageError) {
      throw new SemanticArtifactError(error.message);
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(indexPath, "utf8"));
  } catch {
    throw new SemanticArtifactError("Semantic index artifact contains invalid JSON or cannot be read.");
  }

  assertValidSemanticIndex(parsed);
  if (parsed.mediaId !== expectedMediaId) {
    throw new SemanticArtifactError("Semantic index media ID does not match its manifest entry.");
  }
  return parsed;
}
