import { NextResponse } from "next/server";
import { ensureUser, jsonError, readJson } from "@/lib/api";
import { paycheckScheduleRemoveSchema, paycheckScheduleSchema } from "@/lib/validation";
import { applyPaycheckPlan, archivePaychecks, getSettings, listPaychecks } from "@/lib/repos";
import { planSchedule, sequenceLabel, sequenceRemovalIds } from "@/lib/paycheck-schedule";
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

  // All or nothing: a failure part-way used to leave half a schedule behind.
  applyPaycheckPlan(auth.userId, plan.entries, label || null);

  return NextResponse.json({
    plan,
    applied: true,
    paychecks: await listPaychecks(auth.userId),
  });
}

/**
 * Remove a schedule: archive every upcoming, unreceived paycheck in it.
 * Received and past rows are kept as history (see sequenceRemovalIds) — the
 * same promise the schedule editor makes — and can be removed individually.
 */
export async function DELETE(req: Request) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const data = await readJson(req, paycheckScheduleRemoveSchema);
  if (data instanceof NextResponse) return data;

  const settings = await getSettings(auth.userId);
  if (!settings) return jsonError("settings missing", 400);

  const today = todayIso(settings.timezone);
  const ids = sequenceRemovalIds(
    await listPaychecks(auth.userId),
    sequenceLabel(data.label),
    today,
  );
  const removed = archivePaychecks(auth.userId, ids);

  return NextResponse.json({ removed, paychecks: await listPaychecks(auth.userId) });
}
