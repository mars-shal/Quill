import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { generationFields } from "./validators";

/**
 * Upsert one generation by runId. A retry after a dropped HTTP response should
 * not create a second row, so the mutation is idempotent.
 */
export const record = mutation({
  args: generationFields,
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("generations")
      .withIndex("by_runId", (q) => q.eq("runId", args.runId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, args);
      return existing._id;
    }
    return await ctx.db.insert("generations", args);
  },
});

/** Newest first, for the Convex dashboard and any future client. */
export const recent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(100, Math.floor(args.limit ?? 50)));
    return await ctx.db
      .query("generations")
      .withIndex("by_createdAt")
      .order("desc")
      .take(limit);
  },
});

/** Admin cleanup: remove one run (used to clear smoke-test rows). */
export const removeByRunId = mutation({
  args: { runId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("generations")
      .withIndex("by_runId", (q) => q.eq("runId", args.runId))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.length;
  },
});
