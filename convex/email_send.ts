"use node";

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { htmlToText, idempotencyKey, hashEmail } from "./email_lib";

const AGENTMAIL_API = "https://api.agentmail.to/v0";

/**
 * Sends the stored report HTML as the email body (plan §4.9 / §5).
 * Uses the AgentMail REST API directly so Convex does not bundle the
 * optional @x402/fetch SDK dependency. Never attaches a file.
 */
export const sendReport = internalAction({
  args: {
    deliveryId: v.id("emailDeliveries"),
    jobId: v.id("jobs"),
    reportId: v.id("reports"),
    email: v.string(),
    requestId: v.string(),
  },
  handler: async (ctx, args) => {
    const apiKey = process.env.AGENTMAIL_API_KEY;
    if (!apiKey) {
      await ctx.runMutation(internal.email.markDelivery, {
        deliveryId: args.deliveryId,
        status: "failed",
        errorMsg: "AGENTMAIL_NOT_CONFIGURED: set AGENTMAIL_API_KEY on the Convex deployment",
      });
      return;
    }

    const existing = await ctx.runQuery(internal.email.getDelivery, { deliveryId: args.deliveryId });
    if (!existing || existing.status === "sent") return;

    const pack = await ctx.runQuery(internal.email.getJobAndReport, {
      jobId: args.jobId,
      reportId: args.reportId,
    });
    if (!pack) {
      await ctx.runMutation(internal.email.markDelivery, {
        deliveryId: args.deliveryId,
        status: "failed",
        errorMsg: "REPORT_NOT_FOUND",
      });
      return;
    }

    const blob = await ctx.storage.get(pack.htmlStorageId);
    if (!blob) {
      await ctx.runMutation(internal.email.markDelivery, {
        deliveryId: args.deliveryId,
        status: "failed",
        errorMsg: "HTML_MISSING",
      });
      return;
    }
    const html = await blob.text();
    const text = htmlToText(html);
    const subject = `Car Shopper — ${pack.criteria.make} ${pack.criteria.model} ≤ ${pack.criteria.maxPrice} €`;

    try {
      let inboxId = process.env.AGENTMAIL_INBOX_ID;
      if (!inboxId) {
        const created = await agentmailFetch(apiKey, "/inboxes", {
          client_id: "car-shopper-reports-v1",
          display_name: "Car Shopper",
        });
        inboxId = created.inbox_id ?? created.inboxId;
      }
      if (!inboxId) throw new Error("AgentMail did not return an inbox id");

      const sent = await agentmailFetch(
        apiKey,
        `/inboxes/${encodeURIComponent(inboxId)}/messages/send`,
        { to: args.email, subject, text, html, labels: ["car-shopper", "report"] },
        { "Idempotency-Key": idempotencyKey(args.reportId, hashEmail(args.email)) }
      );

      const messageId = sent.message_id ?? sent.messageId ?? "agentmail";
      await ctx.runMutation(internal.email.markDelivery, {
        deliveryId: args.deliveryId,
        status: "sent",
        providerId: String(messageId),
      });
    } catch (e: any) {
      await ctx.runMutation(internal.email.markDelivery, {
        deliveryId: args.deliveryId,
        status: "failed",
        errorMsg: String(e?.message ?? e).slice(0, 400),
      });
    }
  },
});

async function agentmailFetch(
  apiKey: string,
  path: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {}
): Promise<any> {
  const res = await fetch(`${AGENTMAIL_API}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  if (!res.ok) {
    throw new Error(`AgentMail HTTP ${res.status}: ${data?.message ?? data?.error ?? text.slice(0, 200)}`);
  }
  return data;
}
