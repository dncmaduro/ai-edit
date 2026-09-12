import { getProjectMediaSemanticIndex, isSemanticAnalysisError } from "@/lib/semantic/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SemanticIndexRouteContext {
  params: Promise<{ projectId: string; mediaId: string }>;
}

export async function GET(_request: Request, context: SemanticIndexRouteContext) {
  const { projectId, mediaId } = await context.params;

  try {
    const semanticIndex = await getProjectMediaSemanticIndex(projectId, mediaId);
    return Response.json({ success: true, semanticIndex });
  } catch (error) {
    const message = isSemanticAnalysisError(error) ? error.message : "Unable to read semantic index.";
    const status = message.includes("does not exist") ? 404 : 400;
    return Response.json({ success: false, error: message }, { status });
  }
}
