import "server-only";

import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

const PROJECT_DIRECTORIES = [
  "raw",
  "proxy",
  "audio",
  "cache",
  "analysis",
  "output",
] as const;
const PROJECTS_DIRECTORY = "projects";

export type ProjectDirectoryName = (typeof PROJECT_DIRECTORIES)[number];

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

export function getProjectRoot(): string {
  const configuredRoot = process.env.PROJECT_ROOT?.trim();

  if (!configuredRoot) {
    throw new StorageError(
      "PROJECT_ROOT is not configured. Set it to an absolute media storage path.",
    );
  }

  if (!path.isAbsolute(configuredRoot)) {
    throw new StorageError("PROJECT_ROOT must be an absolute path.");
  }

  return path.resolve(configuredRoot);
}

export function assertSafeProjectId(projectId: string): void {
  if (
    !projectId ||
    projectId === "." ||
    projectId === ".." ||
    projectId.includes("/") ||
    projectId.includes("\\") ||
    path.isAbsolute(projectId)
  ) {
    throw new StorageError("Project ID must be a single, non-empty path segment.");
  }
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentPath, candidatePath);

  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath))
  );
}

export function getProjectDir(projectId: string): string {
  assertSafeProjectId(projectId);
  const projectDir = path.resolve(getProjectRoot(), PROJECTS_DIRECTORY, projectId);

  if (!isPathInside(getProjectRoot(), projectDir)) {
    throw new StorageError("Project ID resolves outside PROJECT_ROOT.");
  }

  return projectDir;
}

function getProjectSubdirectory(
  projectId: string,
  directoryName: ProjectDirectoryName,
): string {
  return path.join(getProjectDir(projectId), directoryName);
}

export function getProjectRawDir(projectId: string): string {
  return getProjectSubdirectory(projectId, "raw");
}

export function getProjectProxyDir(projectId: string): string {
  return getProjectSubdirectory(projectId, "proxy");
}

export function getProjectAudioDir(projectId: string): string {
  return getProjectSubdirectory(projectId, "audio");
}

export function getProjectCacheDir(projectId: string): string {
  return getProjectSubdirectory(projectId, "cache");
}

export function getProjectAnalysisDir(projectId: string): string {
  return getProjectSubdirectory(projectId, "analysis");
}

export function getProjectOutputDir(projectId: string): string {
  return getProjectSubdirectory(projectId, "output");
}

export function getProjectManifestPath(projectId: string): string {
  return path.join(getProjectDir(projectId), "manifest.json");
}

async function ensureDirectoryInsideRoot(directoryPath: string, rootPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true });

  const directoryInfo = await lstat(directoryPath);
  if (directoryInfo.isSymbolicLink()) {
    throw new StorageError(`Refusing to use symbolic link directory: ${directoryPath}`);
  }

  const resolvedDirectory = await realpath(directoryPath);
  if (!isPathInside(rootPath, resolvedDirectory)) {
    throw new StorageError(`Refusing to use directory outside PROJECT_ROOT: ${directoryPath}`);
  }
}

export async function ensureProjectDirectories(projectId: string): Promise<void> {
  const projectRoot = getProjectRoot();
  await mkdir(projectRoot, { recursive: true });
  const resolvedRoot = await realpath(projectRoot);
  const projectsDir = path.join(projectRoot, PROJECTS_DIRECTORY);
  const projectDir = getProjectDir(projectId);

  await ensureDirectoryInsideRoot(projectsDir, resolvedRoot);
  await ensureDirectoryInsideRoot(projectDir, resolvedRoot);
  await Promise.all(
    PROJECT_DIRECTORIES.map((directoryName) =>
      ensureDirectoryInsideRoot(
        path.join(/* turbopackIgnore: true */ projectDir, directoryName),
        resolvedRoot,
      ),
    ),
  );
}

export function assertPathWithinProjectRoot(filePath: string): string {
  if (!path.isAbsolute(filePath)) {
    throw new StorageError("Media path must be an absolute path.");
  }

  const resolvedPath = path.resolve(filePath);
  if (!isPathInside(getProjectRoot(), resolvedPath)) {
    throw new StorageError("Media path must be located inside PROJECT_ROOT.");
  }

  return resolvedPath;
}

/**
 * Resolves an existing regular file and rejects symlinks that leave PROJECT_ROOT.
 */
export async function resolveProjectMediaFile(filePath: string): Promise<string> {
  const resolvedPath = assertPathWithinProjectRoot(filePath);
  const projectRoot = getProjectRoot();
  let resolvedRoot: string;
  let resolvedFile: string;

  try {
    resolvedRoot = await realpath(projectRoot);
  } catch {
    throw new StorageError("PROJECT_ROOT does not exist or cannot be accessed.");
  }

  try {
    resolvedFile = await realpath(resolvedPath);
  } catch {
    throw new StorageError("Media file does not exist or cannot be accessed.");
  }

  if (!isPathInside(resolvedRoot, resolvedFile)) {
    throw new StorageError("Media path must resolve inside PROJECT_ROOT.");
  }

  const fileInfo = await stat(resolvedFile);
  if (!fileInfo.isFile()) {
    throw new StorageError("Media path must point to a regular file.");
  }

  return resolvedFile;
}

export async function resolveProjectRelativeFile(
  projectId: string,
  relativePath: string,
): Promise<string> {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).includes("..")
  ) {
    throw new StorageError("Project file path must be a safe relative path.");
  }

  const projectDir = getProjectDir(projectId);
  const resolvedCandidate = path.resolve(projectDir, relativePath);
  if (!isPathInside(projectDir, resolvedCandidate)) {
    throw new StorageError("Project file path resolves outside its project directory.");
  }

  let resolvedProjectDir: string;
  let resolvedFile: string;
  try {
    resolvedProjectDir = await realpath(projectDir);
    resolvedFile = await realpath(resolvedCandidate);
  } catch {
    throw new StorageError("Project file does not exist or cannot be accessed.");
  }

  if (!isPathInside(resolvedProjectDir, resolvedFile)) {
    throw new StorageError("Project file path must resolve inside its project directory.");
  }

  const fileInfo = await stat(resolvedFile);
  if (!fileInfo.isFile()) {
    throw new StorageError("Project file path must point to a regular file.");
  }

  return resolvedFile;
}
