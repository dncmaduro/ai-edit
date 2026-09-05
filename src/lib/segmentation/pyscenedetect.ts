import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const SCENE_DETECTION_RUNTIME = "pyscenedetect";
export const SCENE_DETECTOR_NAME = "pyscenedetect-content";
export const DEFAULT_SCENEDETECT_THRESHOLD = 27;
export const DEFAULT_MIN_SCENE_SECONDS = 0.8;

const DETECT_SCENES_SCRIPT = String.raw`
import json
import sys

from scenedetect import ContentDetector, detect

video_path = sys.argv[1]
threshold = float(sys.argv[2])
min_scene_len = float(sys.argv[3])
scene_list = detect(
    video_path,
    ContentDetector(threshold=threshold, min_scene_len=min_scene_len),
    show_progress=False,
    start_in_scene=True,
)
print(json.dumps({
    "scenes": [
        {"start": start.seconds, "end": end.seconds}
        for start, end in scene_list
    ],
}))
`;

export interface SceneDetectionConfig {
  runtime: typeof SCENE_DETECTION_RUNTIME;
  detector: typeof SCENE_DETECTOR_NAME;
  pythonCommand: string;
  threshold: number;
  minSceneSeconds: number;
}

export interface SceneDetectionRuntimeStatus {
  runtime: typeof SCENE_DETECTION_RUNTIME;
  available: boolean;
  version?: string;
  error?: string;
}

export interface DetectedScene {
  start: number;
  end: number;
}

export class SceneDetectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SceneDetectionError";
  }
}

function getNumberEnvironmentValue(
  name: "SCENEDETECT_THRESHOLD" | "SCENEDETECT_MIN_SCENE_SECONDS",
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = process.env[name]?.trim();
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function getSceneDetectionConfig(): SceneDetectionConfig {
  return {
    runtime: SCENE_DETECTION_RUNTIME,
    detector: SCENE_DETECTOR_NAME,
    pythonCommand: process.env.SCENEDETECT_PYTHON?.trim() || "python3",
    threshold: getNumberEnvironmentValue(
      "SCENEDETECT_THRESHOLD",
      DEFAULT_SCENEDETECT_THRESHOLD,
      0,
      255,
    ),
    minSceneSeconds: getNumberEnvironmentValue(
      "SCENEDETECT_MIN_SCENE_SECONDS",
      DEFAULT_MIN_SCENE_SECONDS,
      0.1,
      60,
    ),
  };
}

export async function checkSceneDetectionRuntime(): Promise<SceneDetectionRuntimeStatus> {
  const config = getSceneDetectionConfig();

  try {
    const { stdout } = await execFileAsync(
      config.pythonCommand,
      ["-c", "import scenedetect; print(getattr(scenedetect, '__version__', 'unknown'))"],
      { timeout: 5_000 },
    );
    const version = stdout.trim();
    return { runtime: SCENE_DETECTION_RUNTIME, available: true, ...(version ? { version } : {}) };
  } catch {
    return {
      runtime: SCENE_DETECTION_RUNTIME,
      available: false,
      error: "PySceneDetect is unavailable. Install it and configure SCENEDETECT_PYTHON if needed.",
    };
  }
}

function parseDetectedScenes(output: string): DetectedScene[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new SceneDetectionError("PySceneDetect returned invalid JSON.");
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { scenes?: unknown }).scenes)) {
    throw new SceneDetectionError("PySceneDetect returned an invalid scene list.");
  }

  let previousEnd = 0;
  const scenes = (parsed as { scenes: unknown[] }).scenes.map((sceneValue) => {
    if (!sceneValue || typeof sceneValue !== "object") {
      throw new SceneDetectionError("PySceneDetect returned an invalid scene.");
    }

    const scene = sceneValue as Record<string, unknown>;
    const start = scene.start;
    const end = scene.end;
    if (
      typeof start !== "number" ||
      !Number.isFinite(start) ||
      typeof end !== "number" ||
      !Number.isFinite(end) ||
      start < 0 ||
      start >= end ||
      start < previousEnd - 0.02
    ) {
      throw new SceneDetectionError("PySceneDetect returned invalid scene timestamps.");
    }

    previousEnd = end;
    return { start, end };
  });

  if (scenes.length === 0) {
    throw new SceneDetectionError("PySceneDetect did not return any scenes.");
  }

  return scenes;
}

export async function detectScenes(videoPath: string): Promise<DetectedScene[]> {
  const config = getSceneDetectionConfig();
  const runtime = await checkSceneDetectionRuntime();
  if (!runtime.available) {
    throw new SceneDetectionError(runtime.error ?? "PySceneDetect is unavailable.");
  }

  try {
    const { stdout } = await execFileAsync(
      config.pythonCommand,
      [
        "-c",
        DETECT_SCENES_SCRIPT,
        videoPath,
        String(config.threshold),
        String(config.minSceneSeconds),
      ],
      { maxBuffer: 10 * 1024 * 1024, timeout: 30 * 60_000 },
    );
    return parseDetectedScenes(stdout);
  } catch (error) {
    if (error instanceof SceneDetectionError) {
      throw error;
    }

    const stderr =
      typeof (error as { stderr?: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr.trim().slice(-1_000)
        : "";
    throw new SceneDetectionError(
      `PySceneDetect scene detection failed.${stderr ? ` ${stderr}` : ""}`,
    );
  }
}
