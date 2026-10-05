import type { Request, Response } from "express";
import { z } from "zod";

import { supabase } from "../db/supabase";
import { ApiError } from "../middleware/errorHandler";
import { upsertProfile } from "../utils/access";

/** Must match the app's auth redirect and Supabase's allowed redirect URLs. */
const AUTH_REDIRECT = "invomatch://login-callback";
const INVITE_DAYS = 7;

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "worker"]),
});

const acceptSchema = z.object({
  full_name: z.string().min(1, "Your name is required"),
});

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function userIdForEmail(email: string): Promise<string | null> {
  const { data, error } = await supabase.rpc("user_id_by_email", { lookup: email });
  if (error) throw new ApiError(500, error.message);
  return (data as string | null) ?? null;
}

/**
 * Sends the invite email. New addresses get Supabase's invite message, which
 * creates their login. Addresses that already have a login get a sign-in
 * link instead, and the pending invite is waiting when they open the app.
 */
async function sendInviteEmail(email: string): Promise<void> {
  const { error } = await supabase.auth.admin.inviteUserByEmail(email, {
    redirectTo: AUTH_REDIRECT,
  });
  if (!error) return;

  const alreadyRegistered = /already|registered|exists/i.test(error.message);
  if (!alreadyRegistered) throw new ApiError(500, error.message);

  const { error: otpError } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: AUTH_REDIRECT, shouldCreateUser: false },
  });
  if (otpError) throw new ApiError(500, otpError.message);
}

/** GET /team — members and invites still waiting to be accepted. */
export async function listTeam(req: Request, res: Response) {
  const storeId = req.storeId!;
  const [{ data: members, error: membersError }, { data: invites, error: invitesError }] = await Promise.all([
    supabase.from("store_members").select("user_id, role, created_at").eq("store_id", storeId).order("created_at"),
    supabase
      .from("store_invites")
      .select("id, email, role, expires_at, created_at")
      .eq("store_id", storeId)
      .is("accepted_at", null)
      .order("created_at", { ascending: false }),
  ]);
  if (membersError) throw new ApiError(500, membersError.message);
  if (invitesError) throw new ApiError(500, invitesError.message);

  const userIds = (members ?? []).map((member) => member.user_id as string);
  const { data: profiles, error: profilesError } =
    userIds.length === 0
      ? { data: [], error: null }
      : await supabase.from("user_profiles").select("user_id, email, full_name").in("user_id", userIds);
  if (profilesError) throw new ApiError(500, profilesError.message);

  const profileByUser = new Map((profiles ?? []).map((profile) => [profile.user_id as string, profile]));

  res.json({
    data: {
      members: (members ?? []).map((member) => {
        const profile = profileByUser.get(member.user_id as string);
        return {
          user_id: member.user_id,
          role: member.role,
          email: profile?.email ?? "",
          full_name: profile?.full_name ?? "Team member",
          created_at: member.created_at,
        };
      }),
      invites: invites ?? [],
    },
  });
}

/** POST /team/invites — email a worker or another admin. */
export async function createInvite(req: Request, res: Response) {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, "Enter a valid email and role", parsed.error.flatten());

  const email = normalizeEmail(parsed.data.email);
  const storeId = req.storeId!;
  if (email === req.userEmail?.toLowerCase()) {
    throw new ApiError(400, "You can't invite yourself");
  }

  const existingUserId = await userIdForEmail(email);
  if (existingUserId) {
    const { data: membership, error } = await supabase
      .from("store_members")
      .select("store_id")
      .eq("user_id", existingUserId)
      .maybeSingle();
    if (error) throw new ApiError(500, error.message);
    if (membership?.store_id === storeId) throw new ApiError(409, "That person is already on your team");
    if (membership) throw new ApiError(409, "That email already belongs to another store");
  }

  const expiresAt = new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: pending, error: pendingError } = await supabase
    .from("store_invites")
    .select("id")
    .eq("store_id", storeId)
    .eq("email", email)
    .is("accepted_at", null)
    .maybeSingle();
  if (pendingError) throw new ApiError(500, pendingError.message);

  if (pending) {
    const { error } = await supabase
      .from("store_invites")
      .update({ role: parsed.data.role, invited_by: req.userId!, expires_at: expiresAt })
      .eq("id", pending.id);
    if (error) throw new ApiError(500, error.message);
  } else {
    const { error } = await supabase.from("store_invites").insert({
      store_id: storeId,
      email,
      role: parsed.data.role,
      invited_by: req.userId!,
      expires_at: expiresAt,
    });
    if (error) throw new ApiError(500, error.message);
  }

  await sendInviteEmail(email);
  res.status(201).json({ data: { email, role: parsed.data.role, expires_at: expiresAt } });
}

/** DELETE /team/members/:userId — removes access. Their records stay. */
export async function removeMember(req: Request, res: Response) {
  const userId = req.params.userId;
  if (!userId) throw new ApiError(400, "Missing team member");
  if (userId === req.userId) throw new ApiError(400, "You can't remove yourself");

  const { data: member, error } = await supabase
    .from("store_members")
    .select("user_id, role")
    .eq("store_id", req.storeId!)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new ApiError(500, error.message);
  if (!member) throw new ApiError(404, "That person is not on your team");
  if (member.role === "owner") throw new ApiError(403, "The store owner can't be removed");

  const { error: deleteError } = await supabase
    .from("store_members")
    .delete()
    .eq("store_id", req.storeId!)
    .eq("user_id", userId);
  if (deleteError) throw new ApiError(500, deleteError.message);

  res.status(204).send();
}

/** GET /invites/pending — the invite waiting for the signed-in email, if any. */
export async function pendingInvite(req: Request, res: Response) {
  const email = req.userEmail?.toLowerCase();
  if (!email) {
    res.json({ data: null });
    return;
  }

  const { data, error } = await supabase
    .from("store_invites")
    .select("id, email, role, expires_at, stores(name)")
    .eq("email", email)
    .is("accepted_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new ApiError(500, error.message);

  if (!data) {
    res.json({ data: null });
    return;
  }

  const store = data.stores as { name?: string } | null;
  res.json({
    data: {
      id: data.id,
      email: data.email,
      role: data.role,
      store_name: store?.name ?? "your store",
      expires_at: data.expires_at,
    },
  });
}

/** POST /invites/accept — joins the store from the invite sent to this email. */
export async function acceptInvite(req: Request, res: Response) {
  const parsed = acceptSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, "Your name is required", parsed.error.flatten());

  const email = req.userEmail?.toLowerCase();
  if (!email) throw new ApiError(400, "This account has no email address");

  const { data: existing, error: existingError } = await supabase
    .from("store_members")
    .select("id")
    .eq("user_id", req.userId!)
    .maybeSingle();
  if (existingError) throw new ApiError(500, existingError.message);
  if (existing) throw new ApiError(409, "You already belong to a store");

  const { data: invite, error: inviteError } = await supabase
    .from("store_invites")
    .select("id, store_id, role")
    .eq("email", email)
    .is("accepted_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (inviteError) throw new ApiError(500, inviteError.message);
  if (!invite) throw new ApiError(404, "That invite has expired. Ask for a new one.");

  const { error: memberError } = await supabase.from("store_members").insert({
    store_id: invite.store_id,
    user_id: req.userId!,
    role: invite.role,
  });
  if (memberError) throw new ApiError(500, memberError.message);

  const { error: acceptError } = await supabase
    .from("store_invites")
    .update({ accepted_at: new Date().toISOString() })
    .eq("id", invite.id);
  if (acceptError) throw new ApiError(500, acceptError.message);

  await upsertProfile(req.userId!, email, parsed.data.full_name);

  const { data: store, error: storeError } = await supabase
    .from("stores")
    .select("id, name, subscription_status, subscription_plan, created_at")
    .eq("id", invite.store_id)
    .single();
  if (storeError) throw new ApiError(500, storeError.message);

  res.json({ data: { ...store, role: invite.role } });
}
