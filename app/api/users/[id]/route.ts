import { NextResponse } from "next/server";
import { requireAdmin, requireUserId, getCurrentUserRole } from "@/lib/auth";
import { updateUserSchema, changePasswordSchema } from "@/lib/validation";
import {
  getUserById,
  updateUserProfile,
  updateUserPassword,
  deleteUser,
  LastAdminError,
  listUsers,
} from "@/lib/repos";
import { jsonError } from "@/lib/api";
import { revokeUserPlaidItems } from "@/lib/plaid-revoke";
import argon2 from "argon2";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const [callerId, callerRole] = await Promise.all([requireUserId(), getCurrentUserRole()]);

    // Members can only edit themselves; admins can edit anyone
    if (callerRole !== "admin" && callerId !== id) {
      return jsonError("forbidden", 403);
    }

    const body = await req.json().catch(() => ({}));

    // Handle password change separately (requires currentPassword for self)
    if ("currentPassword" in body || "newPassword" in body) {
      const parsed = changePasswordSchema.safeParse(body);
      if (!parsed.success) return jsonError(parsed.error?.issues[0]?.message ?? "invalid input", 400);

      const target = await getUserById(id);
      if (!target) return jsonError("not found", 404);

      // Admin resetting someone else's password skips the currentPassword check
      if (callerId !== id && callerRole === "admin") {
        // Admin sets password directly — use newPassword without current check
        await updateUserPassword(id, parsed.data.newPassword);
      } else {
        const ok = await argon2.verify(target.passwordHash, parsed.data.currentPassword);
        if (!ok) return jsonError("current password is incorrect", 400);
        await updateUserPassword(id, parsed.data.newPassword);
      }
      return NextResponse.json({ ok: true });
    }

    // Profile update (displayName, role)
    const parsed = updateUserSchema.safeParse(body);
    if (!parsed.success) return jsonError(parsed.error?.issues[0]?.message ?? "invalid input", 400);

    // Only admins can change roles
    if (parsed.data.role !== undefined && callerRole !== "admin") {
      return jsonError("forbidden", 403);
    }

    // The last-admin rule (self or other) is enforced atomically inside
    // updateUserProfile's transaction; map its error to the existing 400.
    let updated;
    try {
      updated = await updateUserProfile(id, parsed.data);
    } catch (e) {
      if (e instanceof LastAdminError) return jsonError(e.message, 400);
      throw e;
    }
    if (!updated) return jsonError("not found", 404);
    return NextResponse.json(updated);
  } catch (e) {
    const msg = (e as Error).message;
    return jsonError(msg, msg === "forbidden" ? 403 : 401);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const adminId = await requireAdmin();

    if (adminId === id) return jsonError("cannot delete your own account", 400);

    const target = await getUserById(id);
    if (!target) return jsonError("not found", 404);

    // Refuse before touching Plaid when this is the last admin; deleteUser
    // re-checks atomically inside its transaction.
    if (target.role === "admin") {
      const others = (await listUsers()).filter((u) => u.role === "admin" && u.id !== id);
      if (others.length === 0) return jsonError("cannot remove the last admin", 400);
    }

    // Revoke the user's Plaid Items first (needs the tokens the delete
    // cascades away). Best effort: failures never block the delete.
    const { failed } = await revokeUserPlaidItems(id);

    try {
      await deleteUser(id);
    } catch (e) {
      if (e instanceof LastAdminError) return jsonError(e.message, 400);
      throw e;
    }
    return NextResponse.json({ ok: true, plaidRevokeFailed: failed });
  } catch (e) {
    const msg = (e as Error).message;
    return jsonError(msg, msg === "forbidden" ? 403 : 401);
  }
}
