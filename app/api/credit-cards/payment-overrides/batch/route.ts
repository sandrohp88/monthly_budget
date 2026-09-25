import { NextResponse } from "next/server";
import { ensureUser, jsonError, readJson } from "@/lib/api";
import { applyCardPaymentOps, CardPaymentConflictError } from "@/lib/repos";
import { cardPaymentBatchSchema } from "@/lib/validation";

/**
 * Apply several planned-card-payment changes atomically (move, edit, plan,
 * reset). All ops succeed or none do; conflicts are 409 with a user-facing
 * message. A 409 with `code: "linked_payment"` means the change would strand
 * a bank-transaction link — the client confirms and resends with
 * `unlinkAllocations: true`. See applyCardPaymentOps.
 */
export async function POST(req: Request) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const data = await readJson(req, cardPaymentBatchSchema);
  if (data instanceof NextResponse) return data;
  try {
    applyCardPaymentOps(auth.userId, data.ops, { unlinkAllocations: data.unlinkAllocations });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof CardPaymentConflictError) {
      if (e.code) return NextResponse.json({ error: e.message, code: e.code }, { status: 409 });
      return jsonError(e.message, e.message === "card not found" ? 404 : 409);
    }
    return jsonError((e as Error).message ?? "payment change failed");
  }
}
