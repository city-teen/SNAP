import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { db, paysnapRatesTable } from "@workspace/db";
import {
  GetPaysnapEditSessionResponse,
  GetPaysnapRatesResponse,
  LockPaysnapEditSessionResponse,
  UpdatePaysnapRatesBody,
  UpdatePaysnapRatesResponse,
  UnlockPaysnapEditSessionBody,
  UnlockPaysnapEditSessionResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();
const EDIT_COOKIE_NAME = "paysnap_edit_session";
const EDIT_SESSION_DURATION_MS = 15 * 60 * 1000;
const EDIT_SESSION_SCOPE = "paysnap:edit-rates";
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/api/paysnap",
};

type EditSessionPayload = {
  scope: string;
  expiresAt: number;
};

function getCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }

  return null;
}

function safeEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left, "utf8").digest();
  const rightHash = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftHash, rightHash);
}

function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function createEditSessionToken(secret: string): string {
  const payload: EditSessionPayload = {
    scope: EDIT_SESSION_SCOPE,
    expiresAt: Date.now() + EDIT_SESSION_DURATION_MS,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encodedPayload}.${signPayload(encodedPayload, secret)}`;
}

function hasValidEditSession(cookieHeader: string | undefined, secret: string): boolean {
  const token = getCookie(cookieHeader, EDIT_COOKIE_NAME);
  if (!token) return false;

  const separator = token.lastIndexOf(".");
  if (separator <= 0 || separator === token.length - 1) return false;

  const encodedPayload = token.slice(0, separator);
  const suppliedSignature = token.slice(separator + 1);
  if (!safeEqual(suppliedSignature, signPayload(encodedPayload, secret))) return false;

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Partial<EditSessionPayload>;
    return (
      payload.scope === EDIT_SESSION_SCOPE &&
      typeof payload.expiresAt === "number" &&
      payload.expiresAt > Date.now()
    );
  } catch {
    return false;
  }
}

function toRatesResponse(
  rates: typeof paysnapRatesTable.$inferSelect | undefined,
) {
  return {
    aedRate: rates?.aedRate == null ? null : Number(rates.aedRate),
    inrRate: rates?.inrRate == null ? null : Number(rates.inrRate),
    updatedAt: rates?.updatedAt.toISOString() ?? null,
  };
}

router.get("/paysnap/rates", async (_req, res): Promise<void> => {
  const [rates] = await db
    .select()
    .from(paysnapRatesTable)
    .where(eq(paysnapRatesTable.id, 1))
    .limit(1);

  res.setHeader("Cache-Control", "no-store");
  res.json(GetPaysnapRatesResponse.parse(toRatesResponse(rates)));
});

router.put("/paysnap/rates", async (req, res): Promise<void> => {
  const parsed = UpdatePaysnapRatesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter valid rates greater than zero." });
    return;
  }

  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    res.status(503).json({ error: "Rate editing is not configured." });
    return;
  }

  if (!hasValidEditSession(req.headers.cookie, sessionSecret)) {
    res.status(401).json({ error: "Unlock rate editing before saving." });
    return;
  }

  const values = {
    aedRate:
      parsed.data.aedRate === null ? null : String(parsed.data.aedRate),
    inrRate:
      parsed.data.inrRate === null ? null : String(parsed.data.inrRate),
    updatedAt: new Date(),
  };

  const [rates] = await db
    .insert(paysnapRatesTable)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({
      target: paysnapRatesTable.id,
      set: values,
    })
    .returning();

  res.json(UpdatePaysnapRatesResponse.parse(toRatesResponse(rates)));
});

router.get("/paysnap/edit-session", (req, res) => {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    res.status(503).json({ error: "Rate edit lock is not configured." });
    return;
  }

  res.json(
    GetPaysnapEditSessionResponse.parse({
      unlocked: hasValidEditSession(req.headers.cookie, sessionSecret),
    }),
  );
});

router.post("/paysnap/edit-session", (req, res) => {
  const parsed = UnlockPaysnapEditSessionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a valid password." });
    return;
  }

  const configuredPassword = process.env.PAYSNAP_EDIT_PASSWORD;
  const sessionSecret = process.env.SESSION_SECRET;
  if (!configuredPassword || !sessionSecret) {
    res.status(503).json({ error: "Rate edit lock is not configured." });
    return;
  }

  const suppliedHash = createHash("sha256")
    .update(parsed.data.password, "utf8")
    .digest();
  const configuredHash = createHash("sha256")
    .update(configuredPassword, "utf8")
    .digest();

  if (!timingSafeEqual(suppliedHash, configuredHash)) {
    res.status(401).json({ error: "Password did not match." });
    return;
  }

  res.cookie(EDIT_COOKIE_NAME, createEditSessionToken(sessionSecret), {
    ...COOKIE_OPTIONS,
    maxAge: EDIT_SESSION_DURATION_MS,
  });
  res.json(UnlockPaysnapEditSessionResponse.parse({ unlocked: true }));
});

router.delete("/paysnap/edit-session", (_req, res) => {
  res.clearCookie(EDIT_COOKIE_NAME, COOKIE_OPTIONS);
  res.json(LockPaysnapEditSessionResponse.parse({ unlocked: false }));
});

export default router;
