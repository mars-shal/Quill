import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

/**
 * POST /generations
 *
 * The Python sidecar posts one metadata record here. The shared bearer token
 * is set with `npx convex env set QUILL_TELEMETRY_TOKEN ...` and the same value
 * goes in Quill's `.env` as QUILL_CONVEX_TOKEN.
 */
http.route({
  path: "/generations",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const expected = process.env.QUILL_TELEMETRY_TOKEN;
    const authorization = request.headers.get("authorization") || "";
    if (!expected || authorization !== `Bearer ${expected}`) {
      return new Response("unauthorized", { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response("invalid json", { status: 400 });
    }
    if (!body || typeof body !== "object") {
      return new Response("generation must be an object", { status: 400 });
    }

    try {
      await ctx.runMutation(internal.generations.record, body as never);
    } catch (error) {
      return new Response(`invalid generation: ${String(error)}`, { status: 400 });
    }
    return Response.json({ ok: true });
  }),
});

export default http;
