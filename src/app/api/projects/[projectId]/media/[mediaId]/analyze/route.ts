import {
  analyzeProjectMedia,
  isSemanticAnalysisError,
  smokeTestProjectMediaSegment,
} from "@/lib/semantic/service";
import { VideoUnderstandingProviderError } from "@/lib/semantic/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface AnalyzeRouteContext {
  params: Promise<{ projectId: string; mediaId: string }>;
}

function getRequestedSegmentId(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const segmentId = (value as Record<string, unknown>).segmentId;
  return typeof segmentId === "string" && /^seg_\d{4}$/.test(segmentId) ? segmentId : undefined;
}

export async function POST(request: Request, context: AnalyzeRouteContext) {
  const { projectId, mediaId } = await context.params;

  try {
    const requestText = await request.text();
    const requestBody = requestText ? JSON.parse(requestText) : undefined;
    const segmentId = getRequestedSegmentId(requestBody);
    if (requestBody !== undefined && !segmentId) {
      return Response.json({ success: false, error: "segmentId must be a candidate ID such as seg_0001." }, { status: 400 });
    }
    if (segmentId) {
      const smokeTest = await smokeTestProjectMediaSegment(projectId, mediaId, segmentId);
      return Response.json({ success: true, smokeTest });
    }
    const semanticAnalysis = await analyzeProjectMedia(projectId, mediaId);
    return Response.json({ success: true, semanticAnalysis });
  } catch (error) {
    const message = isSemanticAnalysisError(error) ? error.message : "Unable to analyze media semantically.";
    return Response.json(
      {
        success: false,
        error: message,
        ...(error instanceof VideoUnderstandingProviderError && error.diagnostic
          ? { diagnostic: error.diagnostic }
          : {}),
      },
      { status: 400 },
    );
  }
}
