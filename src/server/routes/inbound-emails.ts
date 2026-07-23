import { Hono } from "hono";
import type { AppEnv } from "../index.js";
import { InboundEmailRepo } from "../repos/inbound-email.js";

export const inboundEmails = new Hono<AppEnv>();

inboundEmails.get("/", async (c) => {
  const repo = new InboundEmailRepo(c.get("db"), c.get("identity"));
  return c.json(await repo.listMetadata());
});
