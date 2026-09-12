import "server-only";
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getProjectAnalysisDir, resolveProjectRelativeFile } from "@/lib/storage";
import { editPlanSchema, type EditPlan } from "@/lib/planning/schema";

export const EDIT_PLAN_RELATIVE_PATH = "analysis/edit-plan.json";
export class EditPlanArtifactError extends Error { constructor(message: string) { super(message); this.name = "EditPlanArtifactError"; } }
export async function writeEditPlan(projectId: string, plan: EditPlan): Promise<string> {
  if (!editPlanSchema.safeParse(plan).success) throw new EditPlanArtifactError("Edit plan has an invalid shape.");
  const dir = getProjectAnalysisDir(projectId); const target = path.join(dir, "edit-plan.json"); const temp = path.join(dir, `.edit-plan-${randomUUID()}.tmp`);
  try { await writeFile(temp, `${JSON.stringify(plan, null, 2)}\n`, "utf8"); await rename(temp, target); } catch { throw new EditPlanArtifactError("Unable to write edit plan artifact."); }
  return EDIT_PLAN_RELATIVE_PATH;
}
export async function readEditPlan(projectId: string, relativePath = EDIT_PLAN_RELATIVE_PATH): Promise<EditPlan> {
  try { const value: unknown = JSON.parse(await readFile(await resolveProjectRelativeFile(projectId, relativePath), "utf8")); const parsed = editPlanSchema.safeParse(value); if (!parsed.success) throw new EditPlanArtifactError("Edit plan artifact has an invalid shape."); return parsed.data; } catch (error) { if (error instanceof EditPlanArtifactError) throw error; throw new EditPlanArtifactError("Edit plan artifact cannot be read."); }
}
