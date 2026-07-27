import { Hono } from "hono";
import { handle } from "@hono/node-server/vercel";
import { waitUntil } from "@vercel/functions";
import { verifySignature } from "../src/line.js";
import { handleEvent, type LineEvent } from "../src/handler.js";

const app = new Hono().basePath("/api");

app.get("/", (c) =>
  c.json({ ok: true, service: "care-log (小安 照護日誌)", time: new Date().toISOString() })
);

app.post("/webhook", async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header("x-line-signature");

  if (!verifySignature(rawBody, signature)) {
    return c.text("bad signature", 403);
  }

  let events: LineEvent[] = [];
  try {
    const body = JSON.parse(rawBody) as { events?: LineEvent[] };
    events = body.events ?? [];
  } catch {
    return c.text("bad body", 400);
  }

  // Ack LINE immediately; process in the background (function stays alive
  // via waitUntil, up to the 300s maxDuration).
  waitUntil(
    Promise.allSettled(events.map((e) => handleEvent(e))).then((results) => {
      for (const r of results) {
        if (r.status === "rejected") console.error("event failed", r.reason);
      }
    })
  );

  return c.text("ok", 200);
});

export default handle(app);
