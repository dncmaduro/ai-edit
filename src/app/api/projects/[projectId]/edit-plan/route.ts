import { getProjectEditPlan, isStoryPlanningError } from "@/lib/planning/service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
interface EditPlanRouteContext { params: Promise<{ projectId: string }>; }
export async function GET(_request: Request, context: EditPlanRouteContext) {
  const { projectId } = await context.params;
  try { return Response.json({ success: true, editPlan: await getProjectEditPlan(projectId) }); }
  catch (error) { const message = isStoryPlanningError(error) ? error.message : "Unable to read edit plan."; return Response.json({ success: false, error: message }, { status: message.includes("does not exist") ? 404 : 400 }); }
}
