import "server-only";

import { SEMANTIC_PROMPT_VERSION } from "@/lib/semantic/config";

export function formatTimestamp(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

export interface SemanticPromptInput {
  start: number;
  end: number;
  transcriptText: string;
  consistencyCorrection?: string;
}

export function buildSemanticAnalysisPrompt(input: SemanticPromptInput): string {
  const transcriptContext = input.transcriptText.trim()
    ? `Local Vietnamese ASR transcript for this interval (it may contain mistakes):\n${input.transcriptText.trim()}`
    : "No local transcript is available for this interval. Use only visible and audible evidence.";

  return `You are analyzing one existing candidate segment from raw footage for a concise food-review video.

Prompt version: ${SEMANTIC_PROMPT_VERSION}
Interval: ${formatTimestamp(input.start)} to ${formatTimestamp(input.end)}. Analyze only this interval. Do not change its timing or create new segments.

${transcriptContext}

${input.consistencyCorrection ? `Consistency correction for this new analysis only: ${input.consistencyCorrection}\n` : ""}

Return the requested JSON using only visible or audible evidence from this interval. The local transcript is supplemental context, not proof: do not invent speech that is absent from the video. When evidence is ambiguous, choose the less specific classification. Prefer unknown/neutral, empty arrays, and generic product descriptions over unsupported specificity. Do not identify people by name.

Food and brand evidence:
- food.brands contains only a commercial brand clearly visible as a logo/product label or explicitly spoken as a commercial brand. Do not put countries, cities, geographic origin, ingredients, fish species, product categories, flavors, manufacturer locations, or uncertain ASR terms in brands. For example, Alaska as fish origin is not a brand. If uncertain, return an empty brands array.
- food.items must be supported by clear packaging text, speech, or unmistakable visual evidence. Prefer a conservative generic description such as "processed fish snack" when identity is uncertain. Do not invent ingredients, species, product variants, or names from uncertain ASR. If visual and transcript evidence disagree, use the less specific generic description.

Actions: include only actions directly evidenced INSIDE this exact supplied interval. Do not infer an action because it is about to happen after the interval. Distinguish show_product, show_packaging, open_package, inspect_product, smell_food, taste_food, eat_food, pull_apart_food, point_at_package, and speak_to_camera precisely. smell_food means intentionally sniffing the food. taste_food means food visibly enters the mouth, a tasting bite is visibly occurring, or compatible audio clearly establishes tasting now. eat_food means ongoing eating or chewing. inspect_product means visual examination without tasting. Do not use taste_food merely because food is visible, held near the mouth, pulled apart, presented, or announced as about to be tasted. Prefer omission over anticipatory inference.

Reaction semantics:
- A reaction is a response to the food or product sensory experience: taste, smell, texture, appearance, price/value, or packaging/product surprise.
- Do not count upbeat introduction, smiling while presenting, normal conversation, or generic presenter energy as a food reaction.
- When reaction.present is false, set trigger to "none". When true, set trigger to the evidenced cause: taste, smell, texture, appearance, price, packaging, or other. Do not infer a trigger without evidence.
- Strong reactions require observable or spoken evidence. The reaction description must state that evidence.

Classify what the segment primarily is, describe evidence objectively, and score its relative usefulness for a short food-review edit. This is analysis only, not a final edit-selection decision.

Score definitions:
- highlightValue: hook potential for short-form editing. A visually surprising package, strong price reveal, or unusual appearance may be a hook without a food reaction.
- informationValue: useful factual product or review information communicated.
- reactionValue: editorial usefulness of a food/product reaction specifically; generic presenter enthusiasm must not increase it.
- visualValue: clarity and usefulness of what is visibly shown.
- overallEditorialValue: overall editing usefulness, not a simple average. Do not force score diversity artificially.`;
}
