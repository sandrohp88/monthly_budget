import { NextResponse } from "next/server";
import { ensureUser, jsonError, readJson } from "@/lib/api";
import { paycheckCreateSchema } from "@/lib/validation";
import { createPaycheck, getSettings, listPaychecks } from "@/lib/repos";
import { generatePaychecksFromSettings } from "@/lib/projection";

export async function GET() {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json({ paychecks: await listPaychecks(auth.userId) });
}

export async function POST(req: Request) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const data = await readJson(req, paycheckCreateSchema);
  if (data instanceof NextResponse) return data;
  try {
    const created = await createPaycheck(auth.userId, {
      payDate: data.payDate,
      amountCents: data.amountCents,
      note: data.note ?? null,
    });
    return NextResponse.json({ paycheck: created });
  } catch (e) {
    return jsonError((e as Error).message ?? "create failed");
  }
}

export async function PUT(_req: Request) {
  // Regenerate from settings: previews diff, applies if `?apply=true`.
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const url = new URL(_req.url);
  const apply = url.searchParams.get("apply") === "true";

  const settings = await getSettings(auth.userId);
  if (!settings) return jsonError("settings missing", 400);

  const projected = generatePaychecksFromSettings({
    firstPayday: settings.firstPaydayDate,
    frequencyDays: settings.payFrequencyDays,
    months: settings.projectionMonths,
    defaultAmountCents: settings.defaultPaycheckCents,
  });
  const existing = await listPaychecks(auth.userId);
  const existingDates = new Set(existing.map((p) => p.payDate));
  const toAdd = projected.filter((p) => !existingDates.has(p.payDate));

  if (apply) {
    for (const p of toAdd) {
      await createPaycheck(auth.userId, {
        payDate: p.payDate,
        amountCents: p.amountCents,
        note: null,
      });
    }
  }
  return NextResponse.json({ added: toAdd.length, preview: toAdd, applied: apply });
}
