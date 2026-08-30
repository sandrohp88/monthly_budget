import { NextResponse } from "next/server";
import { ensureUser, jsonError, readJson } from "@/lib/api";
import { paycheckScheduleSchema } from "@/lib/validation";
import {
  createPaycheck,
  deletePaycheck,
  getSettings,
  listPaychecks,
  updatePaycheck,
} from "@/lib/repos";
import { planSchedule } from "@/lib/paycheck-schedule";
import { addDaysIso, todayIso } from "@/lib/dates";

/**
 * Plan a paycheck run, and apply it on `?apply=true`.
 *
 * Always plans first, even when applying, so the two paths can't drift: what
 * the user approved in the preview is what gets written. The plan is pure
 * (lib/paycheck-schedule.ts) and refuses to touch a received or past row, so
 * "apply" can never rewrite history to match a schedule.
 */
export async function POST(req: Request) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const data = await readJson(req, paycheckScheduleSchema);
  if (data instanceof NextResponse) return data;

  const settings = await getSettings(auth.userId);
  if (!settings) return jsonError("settings missing", 400);

  const today = todayIso(settings.timezone);
  const label = (data.label ?? "").trim();
  const existing = await listPaychecks(auth.userId);

  const plan = planSchedule({
    existing,
    label,
    anchor: data.anchorDate,
    cadence: data.cadence,
    amountCents: data.amountCents,
    // A run always starts from today: back-filling a schedule would invent
    // income for days the projection has already walked past.
    from: today,
    through: addDaysIso(today, data.months * 31),
    today,
    pruneExtra: data.pruneExtra ?? false,
  });

  if (new URL(req.url).searchParams.get("apply") !== "true") {
    return NextResponse.json({ plan, applied: false });
  }

  for (const entry of plan.entries) {
    if (entry.action === "add") {
      await createPaycheck(auth.userId, {
        payDate: entry.payDate,
        amountCents: entry.amountCents,
        note: label || null,
      });
    } else if (entry.action === "update" || entry.action === "move") {
      await updatePaycheck(auth.userId, entry.id, {
        payDate: entry.payDate,
        amountCents: entry.amountCents,
      });
    } else {
      await deletePaycheck(auth.userId, entry.id);
    }
  }

  return NextResponse.json({
    plan,
    applied: true,
    paychecks: await listPaychecks(auth.userId),
  });
}
