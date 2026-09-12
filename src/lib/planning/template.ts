import "server-only";

export const STORY_TEMPLATE_ID = "food-review-100s";
export const STORY_TEMPLATE_VERSION = 1;
export const STORY_SECTION_TYPES = [
  "highlight",
  "introduction",
  "product_info",
  "host_review",
  "friend_review",
  "ending",
] as const;
export type StorySectionType = (typeof STORY_SECTION_TYPES)[number];

export interface StoryTemplateSection {
  type: StorySectionType;
  required: boolean;
  minDurationSeconds: number;
  targetDurationSeconds: number;
  maxDurationSeconds: number;
}

export interface StoryTemplate {
  id: typeof STORY_TEMPLATE_ID;
  version: typeof STORY_TEMPLATE_VERSION;
  targetDurationSeconds: number;
  sections: StoryTemplateSection[];
}

export const foodReview100sTemplate: StoryTemplate = {
  id: STORY_TEMPLATE_ID,
  version: STORY_TEMPLATE_VERSION,
  targetDurationSeconds: 100,
  sections: [
    { type: "highlight", required: true, minDurationSeconds: 5, targetDurationSeconds: 8, maxDurationSeconds: 12 },
    { type: "introduction", required: true, minDurationSeconds: 6, targetDurationSeconds: 10, maxDurationSeconds: 15 },
    { type: "product_info", required: true, minDurationSeconds: 10, targetDurationSeconds: 15, maxDurationSeconds: 22 },
    { type: "host_review", required: true, minDurationSeconds: 20, targetDurationSeconds: 30, maxDurationSeconds: 40 },
    { type: "friend_review", required: false, minDurationSeconds: 12, targetDurationSeconds: 25, maxDurationSeconds: 30 },
    { type: "ending", required: false, minDurationSeconds: 5, targetDurationSeconds: 12, maxDurationSeconds: 15 },
  ],
};

export function getStoryTemplate(templateId: string): StoryTemplate | undefined {
  return templateId === STORY_TEMPLATE_ID ? foodReview100sTemplate : undefined;
}
