"use client";

import * as React from "react";
import { toast } from "sonner";
import { Download, Upload, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHead } from "@/components/ui/page-head";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { StatusPill } from "@/components/ui/status-pill";
import { MoneyInput } from "@/components/money-input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CategoryDialog } from "@/components/category-dialog";
import { PushNotificationsCard } from "@/components/push-notifications-card";
import type { CategoryRow, SettingsRow, UserSafe } from "@/lib/db/schema";

interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: string;
}

interface Props {
  initial: SettingsRow;
  version: string;
  currentUser: CurrentUser;
  users: UserSafe[];
  isAdmin: boolean;
  initialCategories: CategoryRow[];
}

export function SettingsClient({
  initial,
  version,
  currentUser,
  users: initialUsers,
  isAdmin,
  initialCategories,
}: Props) {
  const [startingBalanceCents, setStartingBalance] = React.useState(initial.startingBalanceCents);
  const [startingBalanceAsOf, setStartingBalanceAsOf] = React.useState(initial.startingBalanceAsOf);
  const [defaultPaycheckCents, setDefaultPaycheck] = React.useState(initial.defaultPaycheckCents);
  const [firstPaydayDate, setFirstPayday] = React.useState(initial.firstPaydayDate);
  const [payFrequencyDays, setPayFrequency] = React.useState<number>(initial.payFrequencyDays);
  const [projectionMonths, setProjectionMonths] = React.useState<number>(initial.projectionMonths);
  const [currency, setCurrency] = React.useState(initial.currency);
  const [timezone, setTimezone] = React.useState(initial.timezone);
  const [submitting, setSubmitting] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  const [users, setUsers] = React.useState<UserSafe[]>(initialUsers);
  const [userDialog, setUserDialog] = React.useState<"create" | "edit" | null>(null);
  const [editTarget, setEditTarget] = React.useState<UserSafe | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<UserSafe | null>(null);

  const [categories, setCategories] = React.useState<CategoryRow[]>(initialCategories);
  const [categoryDialogOpen, setCategoryDialogOpen] = React.useState(false);
  const [categoryDeleteTarget, setCategoryDeleteTarget] = React.useState<CategoryRow | null>(null);

  const deleteCategory = async () => {
    if (!categoryDeleteTarget) return;
    const res = await fetch(`/api/categories/${categoryDeleteTarget.id}`, { method: "DELETE" });
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error ?? "delete failed");
      return;
    }
    setCategories((prev) => prev.filter((c) => c.id !== categoryDeleteTarget.id));
    toast.success(`Category "${categoryDeleteTarget.name}" removed`);
    setCategoryDeleteTarget(null);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          startingBalanceCents,
          startingBalanceAsOf,
          defaultPaycheckCents,
          firstPaydayDate,
          payFrequencyDays,
          projectionMonths,
          currency,
          timezone,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "save failed");
      toast.success("Settings saved");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const importFile = async (file: File) => {
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const res = await fetch("/api/backup/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(json),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "import failed");
      const warnings: string[] = body.warnings ?? [];
      if (warnings.length > 0) {
        toast.warning(`Imported with ${warnings.length} warning(s): ${warnings[0]}`);
      } else {
        toast.success("Imported. Reloading…");
      }
      setTimeout(() => window.location.reload(), 600);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const refreshUsers = async () => {
    const res = await fetch("/api/users");
    if (res.ok) setUsers(await res.json());
  };

  const openCreate = () => {
    setEditTarget(null);
    setUserDialog("create");
  };

  const openEdit = (u: UserSafe) => {
    setEditTarget(u);
    setUserDialog("edit");
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const res = await fetch(`/api/users/${deleteTarget.id}`, { method: "DELETE" });
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error ?? "delete failed");
      return;
    }
    toast.success(`${deleteTarget.displayName} removed`);
    setDeleteTarget(null);
    await refreshUsers();
  };

  return (
    <div className="space-y-6 fade-in">
      <PageHead
        title="Settings"
        subtitle={`System configuration · v${version}`}
        actions={
          <>
            <Button variant="outline" asChild>
              <a href="/api/backup/export">
                <Download className="h-3 w-3" /> Export JSON
              </a>
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importFile(f);
                e.target.value = "";
              }}
            />
            <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
              <Upload className="h-3 w-3" /> Import JSON
            </Button>
          </>
        }
      />

      <div className="flex items-center gap-2 text-2xs text-[var(--mint)]">
        <span>{">"}</span>
        <span>Configuring…</span>
        <span className="blink">_</span>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div>
              <CardTitle className="mt-0.5">Projection</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <form onSubmit={save} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Starting balance</Label>
                  <MoneyInput valueCents={startingBalanceCents} onChangeCents={setStartingBalance} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="startingBalanceAsOf">Starting balance as of</Label>
                  <Input
                    id="startingBalanceAsOf"
                    type="date"
                    required
                    value={startingBalanceAsOf}
                    onChange={(e) => setStartingBalanceAsOf(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Default paycheck</Label>
                  <MoneyInput valueCents={defaultPaycheckCents} onChangeCents={setDefaultPaycheck} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="firstPayday">First payday</Label>
                  <Input
                    id="firstPayday"
                    type="date"
                    required
                    value={firstPaydayDate}
                    onChange={(e) => setFirstPayday(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="payFreq">Pay frequency (days)</Label>
                  <Input
                    id="payFreq"
                    type="number"
                    min={1}
                    max={60}
                    value={payFrequencyDays}
                    onChange={(e) => setPayFrequency(Number(e.target.value))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="projMonths">Projection months</Label>
                  <Input
                    id="projMonths"
                    type="number"
                    min={1}
                    max={36}
                    value={projectionMonths}
                    onChange={(e) => setProjectionMonths(Number(e.target.value))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="currency">Currency</Label>
                  <Input
                    id="currency"
                    required
                    maxLength={3}
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                  />
                </div>
                <div className="col-span-2 space-y-1.5">
                  <Label htmlFor="tz">Timezone</Label>
                  <Input id="tz" required value={timezone} onChange={(e) => setTimezone(e.target.value)} />
                </div>
              </div>
              <div className="flex justify-end pt-1">
                <Button type="submit" variant="primary" disabled={submitting}>
                  {submitting ? "Saving…" : "Save settings"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <AccountCard currentUser={currentUser} />
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle className="mt-0.5">Categories</CardTitle>
          </div>
          <Button variant="primary" size="sm" onClick={() => setCategoryDialogOpen(true)}>
            <Plus className="h-3 w-3" /> Add category
          </Button>
        </CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] tabular">
            <thead>
              <tr className="border-b border-[var(--border-raw)] bg-[var(--bg-1)] text-left">
                <th className="px-4 py-3 text-2xs font-medium text-[var(--text-3)]">
                  Color
                </th>
                <th className="px-4 py-3 text-2xs font-medium text-[var(--text-3)]">
                  Name
                </th>
                <th className="px-4 py-3 text-2xs font-medium text-[var(--text-3)]">
                  Kind
                </th>
                <th className="px-4 py-3 text-right text-2xs font-medium text-[var(--text-3)]">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {categories.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-2xs text-[var(--text-3)]">
                    No categories yet
                  </td>
                </tr>
              ) : (
                categories.map((c) => (
                  <tr key={c.id} className="border-b border-[var(--border-raw)] last:border-0 hover:bg-[var(--bg-2)]">
                    <td className="px-4 py-3">
                      <span
                        className="inline-block h-4 w-4 rounded-sm border border-[var(--border-raw)] align-middle"
                        style={{ background: c.color }}
                      />
                    </td>
                    <td className="px-4 py-3 font-semibold text-[var(--text-0)]">{c.name}</td>
                    <td className="px-4 py-3">
                      <Badge variant={c.kind === "income" ? "default" : "secondary"}>{c.kind}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => setCategoryDeleteTarget(c)}
                        title="Remove"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {isAdmin ? (
        <Card>
          <CardHeader>
            <div>
              <CardTitle className="mt-0.5">Family members</CardTitle>
            </div>
            <Button variant="primary" size="sm" onClick={openCreate}>
              <Plus className="h-3 w-3" /> Add member
            </Button>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] tabular">
              <thead>
                <tr className="border-b border-[var(--border-raw)] bg-[var(--bg-1)] text-left">
                  <th className="px-4 py-3 text-2xs font-medium text-[var(--text-3)]">
                    Name
                  </th>
                  <th className="px-4 py-3 text-2xs font-medium text-[var(--text-3)]">
                    Email
                  </th>
                  <th className="px-4 py-3 text-2xs font-medium text-[var(--text-3)]">
                    Role
                  </th>
                  <th className="px-4 py-3 text-right text-2xs font-medium text-[var(--text-3)]">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b border-[var(--border-raw)] last:border-0 hover:bg-[var(--bg-2)]">
                    <td className="px-4 py-3 font-semibold text-[var(--text-0)]">
                      {u.displayName}
                      {u.id === currentUser.id ? (
                        <span className="ml-2 text-2xs text-[var(--text-3)]">
                          (YOU)
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-[var(--text-2)]">{u.email}</td>
                    <td className="px-4 py-3">
                      <Badge variant={u.role === "admin" ? "default" : "secondary"}>{u.role}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => openEdit(u)}>
                          Edit
                        </Button>
                        {u.id !== currentUser.id ? (
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => setDeleteTarget(u)}
                          >
                            Remove
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      <PushNotificationsCard />

      <Card>
        <CardHeader>
          <div>
            <CardTitle className="mt-0.5">Runtime</CardTitle>
          </div>
          <StatusPill>Online</StatusPill>
        </CardHeader>
        <CardContent>
          <div className="space-y-1.5 text-[11px] tabular text-[var(--text-2)]">
            <Kv k="app_version" v={version} />
            <Kv k="user" v={`${currentUser.email} (${currentUser.role})`} />
            <Kv k="currency" v={currency} />
            <Kv k="timezone" v={timezone} />
            <Kv k="projection_window" v={`${projectionMonths} months`} />
            <Kv k="pay_cadence" v={`every ${payFrequencyDays} days`} />
          </div>
          <div className="mt-4 flex justify-end">
            <SignOutButton />
          </div>
        </CardContent>
      </Card>

      {userDialog === "create" ? (
        <UserCreateDialog
          onClose={() => setUserDialog(null)}
          onSaved={async () => {
            setUserDialog(null);
            await refreshUsers();
          }}
        />
      ) : null}
      {userDialog === "edit" && editTarget ? (
        <UserEditDialog
          user={editTarget}
          currentUserId={currentUser.id}
          onClose={() => setUserDialog(null)}
          onSaved={async () => {
            setUserDialog(null);
            await refreshUsers();
          }}
        />
      ) : null}
      {deleteTarget ? (
        <ConfirmDeleteDialog
          name={deleteTarget.displayName}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={confirmDelete}
        />
      ) : null}

      <CategoryDialog
        open={categoryDialogOpen}
        onClose={() => setCategoryDialogOpen(false)}
        onCreated={(c) => {
          setCategories((prev) =>
            [...prev, c].sort((a, b) =>
              a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind),
            ),
          );
          setCategoryDialogOpen(false);
        }}
      />

      {categoryDeleteTarget ? (
        <ConfirmDeleteDialog
          name={categoryDeleteTarget.name}
          onCancel={() => setCategoryDeleteTarget(null)}
          onConfirm={deleteCategory}
        />
      ) : null}
    </div>
  );
}

function Kv({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div>
      <span>{k}</span>
      <span className="mx-2 text-[var(--mint)]">→</span>
      <span className="text-[var(--text-0)]">{v}</span>
    </div>
  );
}

function AccountCard({ currentUser }: { currentUser: CurrentUser }) {
  const [displayName, setDisplayName] = React.useState(currentUser.name);
  const [savingName, setSavingName] = React.useState(false);
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [savingPw, setSavingPw] = React.useState(false);

  const saveName = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingName(true);
    try {
      const res = await fetch(`/api/users/${currentUser.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "save failed");
      toast.success("Name updated");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingName(false);
    }
  };

  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }
    setSavingPw(true);
    try {
      const res = await fetch(`/api/users/${currentUser.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "save failed");
      toast.success("Password changed");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingPw(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="mt-0.5">Account</CardTitle>
        </div>
        <span className="text-2xs text-[var(--text-2)]">
          {currentUser.email}
        </span>
      </CardHeader>
      <CardContent className="space-y-5">
        <form onSubmit={saveName} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="displayName">Display name</Label>
            <Input
              id="displayName"
              required
              maxLength={80}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div className="flex justify-end">
            <Button type="submit" variant="outline" size="sm" disabled={savingName}>
              {savingName ? "Saving…" : "Save name"}
            </Button>
          </div>
        </form>

        <div className="border-t border-[var(--border-raw)] pt-4">
          <p className="mb-3 text-[11px] font-semibold text-[var(--text-1)]">
            Change password
          </p>
          <form onSubmit={savePassword} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="curPw">Current password</Label>
              <Input
                id="curPw"
                type="password"
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="newPw">New password</Label>
              <Input
                id="newPw"
                type="password"
                required
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirmPw">Confirm</Label>
              <Input
                id="confirmPw"
                type="password"
                required
                minLength={8}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
            <div className="flex justify-end">
              <Button type="submit" variant="outline" size="sm" disabled={savingPw}>
                {savingPw ? "Saving…" : "Change password"}
              </Button>
            </div>
          </form>
        </div>
      </CardContent>
    </Card>
  );
}

function UserCreateDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [email, setEmail] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [role, setRole] = React.useState<"admin" | "member">("member");
  const [saving, setSaving] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, displayName, password, role }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "create failed");
      toast.success(`${displayName} added`);
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add family member</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="new-email">Email</Label>
            <Input
              id="new-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-name">Display name</Label>
            <Input
              id="new-name"
              required
              maxLength={80}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-pw">Password</Label>
            <Input
              id="new-pw"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as "admin" | "member")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">Member</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? "Adding…" : "Add member"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function UserEditDialog({
  user,
  currentUserId,
  onClose,
  onSaved,
}: {
  user: UserSafe;
  currentUserId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isSelf = user.id === currentUserId;
  const [displayName, setDisplayName] = React.useState(user.displayName);
  const [role, setRole] = React.useState<"admin" | "member">(user.role as "admin" | "member");
  const [newPassword, setNewPassword] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const profileRes = await fetch(`/api/users/${user.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName, role }),
      });
      const profileJson = await profileRes.json();
      if (!profileRes.ok) throw new Error(profileJson.error ?? "update failed");

      if (newPassword) {
        const pwRes = await fetch(`/api/users/${user.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ currentPassword: "__admin_reset__", newPassword }),
        });
        const pwJson = await pwRes.json();
        if (!pwRes.ok) throw new Error(pwJson.error ?? "password reset failed");
      }
      toast.success("User updated");
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{user.displayName}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label>Email</Label>
            <Input value={user.email} disabled className="opacity-60" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-name">Display name</Label>
            <Input
              id="edit-name"
              required
              maxLength={80}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          {!isSelf ? (
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select value={role} onValueChange={(v) => setRole(v as "admin" | "member")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="reset-pw">
              New password{" "}
              <span className="normal-case text-[var(--text-3)] tracking-normal">(optional)</span>
            </Label>
            <Input
              id="reset-pw"
              type="password"
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="leave blank to keep"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmDeleteDialog({
  name,
  onCancel,
  onConfirm,
}: {
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove {name}?</DialogTitle>
        </DialogHeader>
        <p className="pt-1 text-[11px] tracking-wide text-[var(--text-2)]">
          This will permanently delete their account and all their budget data. This cannot be undone.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SignOutButton() {
  const handleSignOut = async () => {
    const { signOut } = await import("next-auth/react");
    await signOut({ callbackUrl: "/login" });
  };
  return (
    <Button variant="outline" onClick={handleSignOut}>
      Sign out
    </Button>
  );
}
