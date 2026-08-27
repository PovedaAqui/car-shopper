import { query, mutation, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { hashEmail, isValidEmail } from "./email_lib";

/**
 * Product email API (plan §5 POST /reports/{id}/email).
 * HTML body via AgentMail — never an attachment. Retries do not resend.
 */

export const requestEmail = mutation({
  args: {
    jobId: v.id("jobs"),
    userId: v.string(),
    email: v.string(),
    confirm: v.boolean(),
  },
  handler: async (ctx, args) => {
    if (!args.confirm) throw new Error("CONFIRM_REQUIRED: explicit confirmation is required");
    if (!isValidEmail(args.email)) throw new Error("INVALID_EMAIL");

    const job = await ctx.db.get("jobs", args.jobId);
    if (!job || job.userId !== args.userId) throw new Error("NOT_FOUND");
    if (job.status !== "completed") throw new Error("REPORT_NOT_READY");

    const report = await ctx.db.query("reports").withIndex("by_job", (q) => q.eq("jobId", args.jobId)).first();
    if (!report) throw new Error("REPORT_NOT_READY");

    const recipientHash = hashEmail(args.email);
    const existing = await ctx.db
      .query("emailDeliveries")
      .withIndex("by_report_hash", (q) => q.eq("reportId", report._id).eq("recipientHash", recipientHash))
      .collect();
    const live = existing.find((d) => d.status === "pending" || d.status === "sent");
    if (live) {
      return {
        deliveryId: live._id,
        requestId: live.requestId ?? null,
        status: live.status,
        reused: true,
      };
    }

    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const deliveryId = await ctx.db.insert("emailDeliveries", {
      reportId: report._id,
      recipientHash,
      providerId: "agentmail",
      status: "pending",
      requestId,
      createdAt: Date.now(),
    });

    await ctx.scheduler.runAfter(0, internal.email_send.sendReport, {
      deliveryId,
      jobId: args.jobId,
      reportId: report._id,
      email: args.email.trim(),
      requestId,
    });

    return { deliveryId, requestId, status: "pending" as const, reused: false };
  },
});

export const listDeliveries = query({
  args: { jobId: v.id("jobs"), userId: v.string() },
  handler: async (ctx, { jobId, userId }) => {
    const job = await ctx.db.get("jobs", jobId);
    if (!job || job.userId !== userId) return [];
    const report = await ctx.db.query("reports").withIndex("by_job", (q) => q.eq("jobId", jobId)).first();
    if (!report) return [];
    const rows = await ctx.db.query("emailDeliveries").withIndex("by_report", (q) => q.eq("reportId", report._id)).collect();
    return rows
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((d) => ({
        deliveryId: d._id,
        status: d.status,
        requestId: d.requestId ?? null,
        createdAt: d.createdAt,
        sentAt: d.sentAt ?? null,
        errorMsg: d.errorMsg ?? null,
      }));
  },
});

export const getDelivery = internalQuery({
  args: { deliveryId: v.id("emailDeliveries") },
  handler: async (ctx, { deliveryId }) => {
    return await ctx.db.get("emailDeliveries", deliveryId);
  },
});

export const getJobAndReport = internalQuery({
  args: { jobId: v.id("jobs"), reportId: v.id("reports") },
  handler: async (ctx, { jobId, reportId }) => {
    const job = await ctx.db.get("jobs", jobId);
    const report = await ctx.db.get("reports", reportId);
    if (!job || !report) return null;
    return {
      criteria: job.criteria,
      htmlStorageId: report.htmlStorageId,
    };
  },
});

export const markDelivery = internalMutation({
  args: {
    deliveryId: v.id("emailDeliveries"),
    status: v.union(v.literal("sent"), v.literal("failed"), v.literal("bounced")),
    providerId: v.optional(v.string()),
    outboundId: v.optional(v.string()),
    errorMsg: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get("emailDeliveries", args.deliveryId);
    if (!row) return;
    if (row.status === "sent" && args.status === "sent") return;
    await ctx.db.patch("emailDeliveries", args.deliveryId, {
      status: args.status,
      providerId: args.providerId ?? row.providerId,
      outboundId: args.outboundId ?? row.outboundId,
      errorMsg: args.errorMsg,
      sentAt: args.status === "sent" ? Date.now() : row.sentAt,
    });
  },
});
