import { createProjectEditPlan, isStoryPlanningError } from "@/lib/planning/service";
import { STORY_TEMPLATE_ID } from "@/lib/planning/template";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PlanRouteContext { params: Promise<{ projectId: string }>; }

export async function POST(request: Request, context: PlanRouteContext) {
  const { projectId } = await context.params;
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object") return Response.json({ success: false, error: "Request body must be an object." }, { status: 400 });
    const body = value as Record<string, unknown>;
    const templateId = body.templateId === undefined ? STORY_TEMPLATE_ID : body.templateId;
    const creativeBrief = body.creativeBrief === undefined ? "" : body.creativeBrief;
    if (templateId !== STORY_TEMPLATE_ID || typeof creativeBrief !== "string" || creativeBrief.length > 4_000) return Response.json({ success: false, error: "templateId or creativeBrief is invalid." }, { status: 400 });
    return Response.json({ success: true, planning: await createProjectEditPlan(projectId, templateId, creativeBrief) });
  } catch (error) {
    return Response.json({ success: false, error: isStoryPlanningError(error) ? error.message : "Unable to create edit plan." }, { status: 400 });
  }
}
