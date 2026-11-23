import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const generationFields = {
  runId: v.string(),
  createdAt: v.number(),
  source: v.string(),
  appVersion: v.string(),
  task: v.string(),
  provider: v.string(),
  model: v.string(),
  status: v.string(),
  documentId: v.optional(v.string()),
  sessionId: v.optional(v.string()),
  title: v.optional(v.string()),
  promptChars: v.number(),
  promptSha256: v.string(),
  promptPreview: v.optional(v.string()),
  totalMs: v.number(),
  researchMs: v.number(),
  writingMs: v.number(),
  corpusChars: v.number(),
  sources: v.number(),
  relevantPages: v.number(),
  quality: v.number(),
  lowResearch: v.boolean(),
  words: v.number(),
  sections: v.number(),
  placeholders: v.number(),
  promptTokens: v.number(),
  completionTokens: v.number(),
  error: v.optional(v.string()),
};

export default defineSchema({
  generations: defineTable(generationFields)
    .index("by_createdAt", ["createdAt"])
    .index("by_runId", ["runId"]),
});
