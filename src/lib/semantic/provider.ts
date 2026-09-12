import "server-only";

import { FileState, GoogleGenAI } from "@google/genai";
import {
  getSemanticAnalysisConfig,
  SEMANTIC_INTERACTION_GENERATION_CONFIG,
} from "@/lib/semantic/config";
import { buildSemanticAnalysisPrompt } from "@/lib/semantic/prompt";
import {
  geminiSegmentSemanticJsonSchema,
  segmentSemanticAnalysisSchema,
  type SegmentSemanticAnalysis,
  type SemanticUsage,
} from "@/lib/semantic/schema";

export interface PreparedVideo {
  uri: string;
  mimeType: string;
  uploadedFileState: FileState.ACTIVE;
  cleanup(): Promise<void>;
}

export interface AnalyzeSegmentInput {
  video: PreparedVideo;
  start: number;
  end: number;
  transcriptText: string;
}

export interface AnalyzeSegmentResult {
  analysis: SegmentSemanticAnalysis;
  usage?: SemanticUsage;
  interaction: ProviderCallDiagnostic;
  structuredOutputParsed: true;
  localValidationPassed: true;
  consistencyRetries: number;
}

export interface VideoUnderstandingProvider {
  prepareVideo(proxyPath: string): Promise<PreparedVideo>;
  analyzeSegment(input: AnalyzeSegmentInput): Promise<AnalyzeSegmentResult>;
}

export type ProviderFailureStage =
  | "file_upload"
  | "file_readiness"
  | "interactions_create"
  | "structured_output_parsing"
  | "local_zod_validation"
  | "semantic_consistency_validation"
  | "uploaded_file_cleanup";

export interface ProviderCallDiagnostic {
  stage: ProviderFailureStage;
  status?: number;
  code?: string;
  type?: string;
  requestId?: string;
  name?: string;
  message: string;
  details?: string[];
}

interface ProviderErrorOptions {
  transient?: boolean;
  cause?: unknown;
  diagnostic?: ProviderCallDiagnostic;
}

export class VideoUnderstandingProviderError extends Error {
  readonly transient: boolean;
  readonly cause?: unknown;
  readonly diagnostic?: ProviderCallDiagnostic;

  constructor(message: string, options: ProviderErrorOptions = {}) {
    super(message);
    this.name = "VideoUnderstandingProviderError";
    this.transient = options.transient ?? false;
    this.diagnostic = options.diagnostic;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getCode(value: unknown): string | undefined {
  return getString(value) ?? (typeof value === "number" && Number.isFinite(value) ? String(value) : undefined);
}

function redactDiagnosticText(value: string): string {
  return value
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted-api-key]")
    .replace(/([?&](?:key|api[_-]?key)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^,\s]+/gi, "$1[redacted]")
    .replace(/(?:\/Users|\/Volumes|\/private)\/[^\s"'`]+/g, "[local-path]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
}

function getHeader(value: unknown, name: string): string | undefined {
  const headers = toRecord(value);
  if (!headers) {
    return undefined;
  }
  const normalizedName = name.toLowerCase();
  for (const [key, headerValue] of Object.entries(headers)) {
    if (key.toLowerCase() === normalizedName && typeof headerValue === "string") {
      return headerValue;
    }
  }
  return undefined;
}

function getErrorStatus(error: unknown): number | undefined {
  const value = toRecord(error);
  if (!value) {
    return undefined;
  }
  return (
    getNumber(value.status) ??
    getNumber(toRecord(value.response)?.status) ??
    getResponseStatus(toRecord(value.sdkHttpResponse)?.responseInternal)
  );
}

function getResponseStatus(value: unknown): number | undefined {
  const response = toRecord(value);
  return getNumber(response?.status);
}

function getProviderDiagnostic(stage: ProviderFailureStage, error: unknown): ProviderCallDiagnostic {
  const value = toRecord(error);
  const response = toRecord(value?.response);
  const apiError = toRecord(value?.error) ?? toRecord(response?.error) ?? toRecord(toRecord(response?.data)?.error);
  const responseHeaders = toRecord(response?.headers) ?? toRecord(toRecord(value?.sdkHttpResponse)?.headers);
  const status =
    getNumber(value?.status) ?? getNumber(response?.status) ?? getResponseStatus(toRecord(value?.sdkHttpResponse)?.responseInternal);
  const message =
    getString(apiError?.message) ??
    (error instanceof Error ? error.message : undefined) ??
    getString(value?.message) ??
    "Gemini provider request failed.";
  const code = getCode(apiError?.code) ?? getCode(value?.code);
  const type = getString(apiError?.type) ?? getString(value?.type);
  const requestId =
    getString(value?.requestId) ??
    getString(value?.request_id) ??
    getHeader(responseHeaders, "x-goog-request-id") ??
    getHeader(responseHeaders, "x-request-id");
  const diagnostic: ProviderCallDiagnostic = {
    stage,
    message: redactDiagnosticText(message),
    ...(status !== undefined ? { status } : {}),
    ...(code ? { code } : {}),
    ...(type ? { type } : {}),
    ...(requestId ? { requestId } : {}),
    ...(error instanceof Error && error.name ? { name: error.name } : {}),
  };
  return diagnostic;
}

function formatProviderErrorMessage(diagnostic: ProviderCallDiagnostic, fallback: string): string {
  const details = [
    diagnostic.status !== undefined ? `HTTP ${diagnostic.status}` : undefined,
    diagnostic.code ? `code ${diagnostic.code}` : undefined,
    diagnostic.type ? `type ${diagnostic.type}` : undefined,
  ].filter(Boolean);
  const prefix = details.length > 0 ? `${fallback} (${details.join(", ")})` : fallback;
  return `${prefix}: ${diagnostic.message}`.slice(0, 900);
}

function logProviderDiagnostic(diagnostic: ProviderCallDiagnostic): void {
  console.error("[semantic-analysis] Gemini provider failure", diagnostic);
}

function providerFailure(
  stage: ProviderFailureStage,
  fallback: string,
  error: unknown,
): VideoUnderstandingProviderError {
  const diagnostic = getProviderDiagnostic(stage, error);
  logProviderDiagnostic(diagnostic);
  return new VideoUnderstandingProviderError(formatProviderErrorMessage(diagnostic, fallback), {
    transient: isTransientProviderFailure(error),
    cause: error,
    diagnostic,
  });
}

function localFailure(
  stage: ProviderFailureStage,
  message: string,
  cause?: unknown,
  transient = false,
): VideoUnderstandingProviderError {
  const issues = toRecord(cause)?.issues;
  const issueDetails = Array.isArray(issues)
    ? issues
        .flatMap((issue: unknown) => {
          const value = toRecord(issue);
          const path = Array.isArray(value?.path) ? value.path.map(String).join(".") || "root" : "root";
          const issueMessage = getString(value?.message);
          return issueMessage ? [redactDiagnosticText(`${path}: ${issueMessage}`)] : [];
        })
        .slice(0, 5)
    : undefined;
  const diagnostic: ProviderCallDiagnostic = {
    stage,
    message: redactDiagnosticText(message),
    ...(cause instanceof Error && cause.name ? { name: cause.name } : {}),
    ...(issueDetails && issueDetails.length > 0 ? { details: issueDetails } : {}),
  };
  logProviderDiagnostic(diagnostic);
  return new VideoUnderstandingProviderError(message, { transient, cause, diagnostic });
}

function isTransientProviderFailure(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status === 429 || (status !== undefined && status >= 500)) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /ECONNRESET|ETIMEDOUT|fetch failed|network|temporar/i.test(message);
}

function toUsage(value: unknown): SemanticUsage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const usage = value as Record<string, unknown>;
  const inputTokens = usage.total_input_tokens;
  const outputTokens = usage.total_output_tokens;
  const totalTokens = usage.total_tokens;
  if (
    typeof inputTokens !== "number" ||
    !Number.isInteger(inputTokens) ||
    inputTokens < 0 ||
    typeof outputTokens !== "number" ||
    !Number.isInteger(outputTokens) ||
    outputTokens < 0 ||
    typeof totalTokens !== "number" ||
    !Number.isInteger(totalTokens) ||
    totalTokens < 0
  ) {
    return undefined;
  }

  return { inputTokens, outputTokens, totalTokens };
}

function parseStructuredOutput(outputText: unknown): SegmentSemanticAnalysis {
  if (typeof outputText !== "string" || !outputText.trim()) {
    throw localFailure("structured_output_parsing", "Gemini returned an empty structured response.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(outputText);
  } catch (error) {
    throw localFailure("structured_output_parsing", "Gemini returned invalid JSON structured output.", error);
  }

  const validated = segmentSemanticAnalysisSchema.safeParse(parsed);
  if (!validated.success) {
    throw localFailure("local_zod_validation", "Gemini structured output failed local schema validation.", validated.error);
  }
  return validated.data;
}

interface SemanticConsistencyResult {
  analysis: SegmentSemanticAnalysis;
  correction?: string;
}

function hasSmellEvidence(analysis: SegmentSemanticAnalysis): boolean {
  return /smell|sniff|scent|odor|aroma|ngửi|mùi/i.test(
    [analysis.visualDescription, analysis.speechSummary ?? "", analysis.reaction.description].join(" "),
  );
}

function validateAndNormalizeSemanticConsistency(analysis: SegmentSemanticAnalysis): SemanticConsistencyResult {
  if (!analysis.reaction.present) {
    return {
      analysis: {
        ...analysis,
        reaction: { ...analysis.reaction, trigger: "none", intensity: 0 },
        scores: { ...analysis.scores, reactionValue: Math.min(analysis.scores.reactionValue, 0.2) },
      },
    };
  }

  if (!analysis.reaction.trigger || analysis.reaction.trigger === "none") {
    return {
      analysis,
      correction: "reaction.present was true but reaction.trigger was missing or none. Use an evidenced non-none trigger.",
    };
  }

  if (analysis.reaction.trigger === "smell" && !analysis.actions.includes("smell_food")) {
    if (hasSmellEvidence(analysis)) {
      return { analysis: { ...analysis, actions: [...analysis.actions, "smell_food"] } };
    }
    return {
      analysis,
      correction: "reaction.trigger was smell but neither the visual description nor speech describes smelling or sniffing. Re-analyze conservatively.",
    };
  }

  if (
    analysis.reaction.trigger === "taste" &&
    !analysis.actions.includes("taste_food") &&
    !analysis.actions.includes("eat_food")
  ) {
    return {
      analysis,
      correction: "reaction.trigger was taste but actions contained neither taste_food nor eat_food. Re-analyze the exact interval and make the fields consistent.",
    };
  }

  return { analysis };
}

function formatVideoOffset(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw localFailure("interactions_create", "Semantic segment offset is invalid.");
  }
  return `${Number(seconds.toFixed(3))}s`;
}

function getSuccessfulInteractionDiagnostic(response: unknown): ProviderCallDiagnostic {
  const sdkHttpResponse = toRecord(toRecord(response)?.sdkHttpResponse);
  const responseInternal = toRecord(sdkHttpResponse?.responseInternal);
  const headers = toRecord(sdkHttpResponse?.headers);
  return {
    stage: "interactions_create",
    message: "Gemini interaction completed.",
    ...(getNumber(responseInternal?.status) !== undefined ? { status: getNumber(responseInternal?.status) } : {}),
    ...(getHeader(headers, "x-goog-request-id") ?? getHeader(headers, "x-request-id")
      ? { requestId: getHeader(headers, "x-goog-request-id") ?? getHeader(headers, "x-request-id") }
      : {}),
  };
}

export class GeminiVideoUnderstandingProvider implements VideoUnderstandingProvider {
  readonly #client: GoogleGenAI;
  readonly #model: string;

  constructor(apiKey: string, model: string) {
    this.#client = new GoogleGenAI({ apiKey });
    this.#model = model;
  }

  async prepareVideo(proxyPath: string): Promise<PreparedVideo> {
    let uploaded;
    try {
      uploaded = await this.#client.files.upload({
        file: proxyPath,
        config: { mimeType: "video/mp4" },
      });
    } catch (error) {
      throw providerFailure("file_upload", "Gemini could not upload the proxy video", error);
    }

    if (!uploaded.name) {
      throw localFailure("file_upload", "Gemini did not return an uploaded proxy file reference.");
    }

    let file = uploaded;
    const deadline = Date.now() + 5 * 60_000;
    try {
      while (file.state === FileState.PROCESSING || file.state === undefined) {
        if (Date.now() >= deadline) {
          throw localFailure("file_readiness", "Gemini proxy video processing timed out.", undefined, true);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
        file = await this.#client.files.get({ name: uploaded.name });
      }
    } catch (error) {
      if (error instanceof VideoUnderstandingProviderError) {
        throw error;
      }
      throw providerFailure("file_readiness", "Gemini proxy video processing could not be checked", error);
    }

    if (file.state === FileState.FAILED) {
      throw localFailure(
        "file_readiness",
        `Gemini proxy video processing failed.${file.error?.message ? ` ${redactDiagnosticText(file.error.message)}` : ""}`,
        file.error,
      );
    }
    if (file.state !== FileState.ACTIVE) {
      throw localFailure("file_readiness", `Gemini proxy video did not become ACTIVE (state: ${file.state ?? "unknown"}).`);
    }
    if (!file.uri || !file.mimeType) {
      throw localFailure("file_readiness", "Gemini proxy video is missing an active URI or MIME type.");
    }

    return {
      uri: file.uri,
      mimeType: file.mimeType,
      uploadedFileState: FileState.ACTIVE,
      cleanup: async () => {
        try {
          await this.#client.files.delete({ name: uploaded.name! });
        } catch (error) {
          const diagnostic = getProviderDiagnostic("uploaded_file_cleanup", error);
          console.warn("[semantic-analysis] unable to delete temporary Gemini proxy file", diagnostic);
        }
      },
    };
  }

  async analyzeSegment(input: AnalyzeSegmentInput): Promise<AnalyzeSegmentResult> {
    let correction: string | undefined;
    for (let consistencyAttempt = 0; consistencyAttempt <= 1; consistencyAttempt += 1) {
      try {
        const response = await this.#client.interactions.create({
          model: this.#model,
          generation_config: SEMANTIC_INTERACTION_GENERATION_CONFIG,
          input: [
            {
              type: "video",
              uri: input.video.uri,
              mime_type: input.video.mimeType,
              processing: {
                type: "static",
                start_offset: formatVideoOffset(input.start),
                end_offset: formatVideoOffset(input.end),
              },
            },
            {
              type: "text",
              text: buildSemanticAnalysisPrompt({ ...input, consistencyCorrection: correction }),
            },
          ],
          response_format: {
            type: "text",
            mime_type: "application/json",
            schema: geminiSegmentSemanticJsonSchema,
          },
        });
        const consistency = validateAndNormalizeSemanticConsistency(parseStructuredOutput(response.output_text));
        if (consistency.correction) {
          if (consistencyAttempt === 1) {
            throw localFailure("semantic_consistency_validation", `Gemini semantic response remained inconsistent: ${consistency.correction}`);
          }
          correction = consistency.correction;
          continue;
        }
        return {
          analysis: consistency.analysis,
          ...(toUsage(response.usage) ? { usage: toUsage(response.usage) } : {}),
          interaction: getSuccessfulInteractionDiagnostic(response),
          structuredOutputParsed: true,
          localValidationPassed: true,
          consistencyRetries: consistencyAttempt,
        };
      } catch (error) {
        if (error instanceof VideoUnderstandingProviderError) {
          throw error;
        }
        throw providerFailure("interactions_create", "Gemini segment analysis request failed", error);
      }
    }
    throw localFailure("semantic_consistency_validation", "Gemini semantic consistency retry did not complete.");
  }
}

export function createVideoUnderstandingProvider(): VideoUnderstandingProvider {
  const config = getSemanticAnalysisConfig();
  if (!config.apiKey) {
    throw localFailure("interactions_create", "Gemini API key is not configured.");
  }
  return new GeminiVideoUnderstandingProvider(config.apiKey, config.model);
}
