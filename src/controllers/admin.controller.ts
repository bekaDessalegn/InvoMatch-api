import type { Request, Response } from "express";
import { z } from "zod";

import { supabase } from "../db/supabase";
import { ApiError } from "../middleware/errorHandler";
import { adjustScans, scanBalances, setStoreSubscriptionOverride, setSubscriptionMode, subscriptionEnforced } from "../services/billing";

const settingsSchema = z.object({
  subscription_mode: z.boolean(),
});

const overrideSchema = z.object({
  override: z.enum(["on", "off", "platform"]),
});

const adjustSchema = z.object({
  delta: z.number().int().refine((value) => value !== 0, "Enter a number of scans to add or remove."),
  note: z.string().min(1, "Add a short note so the change has a reason."),
});

export async function getAdminOverview(_req: Request, res: Response) {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [{ data: settings, error: settingsError }, { data: stores, error: storesError }, { count, error: scanError }] =
    await Promise.all([
      supabase.from("platform_settings").select("subscription_mode").eq("id", 1).single(),
      supabase.from("stores").select("id, subscription_status, subscription_plan, subscription_override"),
      supabase
        .from("scan_ledger")
        .select("id", { count: "exact", head: true })
        .eq("reason", "scan")
        .gte("created_at", monthStart.toISOString()),
    ]);
  if (settingsError) throw new ApiError(500, settingsError.message);
  if (storesError) throw new ApiError(500, storesError.message);
  if (scanError) throw new ApiError(500, scanError.message);

  const rows = stores ?? [];
  const people = await listPeople();
  const platformOn = Boolean(settings.subscription_mode);
  res.json({
    data: {
      subscription_mode: platformOn,
      stores: rows.length,
      paying: rows.filter((store) => store.subscription_status === "active" && store.subscription_plan).length,
      scans_this_month: count ?? 0,
      users: people.length,
      users_without_store: people.filter((person) => !person.store_id).length,
      forced_on: rows.filter((store) => store.subscription_override === "on").length,
      forced_off: rows.filter((store) => store.subscription_override === "off").length,
    },
  });
}

export async function getAdminSettings(_req: Request, res: Response) {
  const { data, error } = await supabase.from("platform_settings").select("subscription_mode, updated_at").eq("id", 1).single();
  if (error) throw new ApiError(500, error.message);
  res.json({ data });
}

export async function patchAdminSettings(req: Request, res: Response) {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, "Invalid settings", parsed.error.flatten());
  const data = await setSubscriptionMode(parsed.data.subscription_mode);
  res.json({ data });
}

export async function listAdminStores(_req: Request, res: Response) {
  const [{ data: settings, error: settingsError }, { data: stores, error }, { data: members, error: membersError }, { data: profiles, error: profilesError }] =
    await Promise.all([
      supabase.from("platform_settings").select("subscription_mode").eq("id", 1).single(),
      supabase
        .from("stores")
        .select("id, name, subscription_status, subscription_plan, subscription_override, grace_until, created_at")
        .order("created_at", { ascending: false }),
      supabase.from("store_members").select("store_id, user_id, role").eq("role", "owner"),
      supabase.from("user_profiles").select("user_id, email, full_name"),
    ]);
  if (settingsError) throw new ApiError(500, settingsError.message);
  if (error) throw new ApiError(500, error.message);
  if (membersError) throw new ApiError(500, membersError.message);
  if (profilesError) throw new ApiError(500, profilesError.message);
  const platformOn = Boolean(settings.subscription_mode);

  const profileByUser = new Map((profiles ?? []).map((profile) => [profile.user_id as string, profile]));
  const ownerByStore = new Map((members ?? []).map((member) => [member.store_id as string, member.user_id as string]));

  const withBalances = await Promise.all(
    (stores ?? []).map(async (store) => {
      const balances = await scanBalances(store.id as string);
      const ownerId = ownerByStore.get(store.id as string);
      const owner = ownerId ? profileByUser.get(ownerId) : undefined;
      return {
        ...store,
        owner_name: (owner?.full_name as string | undefined) ?? null,
        owner_email: (owner?.email as string | undefined) ?? null,
        subscription_enforced: subscriptionEnforced(platformOn, normalizeOverride(store.subscription_override)),
        plan_scans_remaining: balances.plan,
        topup_scans_remaining: balances.topup,
        scans_remaining: balances.plan + balances.topup,
      };
    }),
  );

  res.json({ data: withBalances });
}

export async function getAdminStore(req: Request, res: Response) {
  const storeId = req.params.id as string;
  const [{ data: store, error }, { data: members, error: membersError }, { data: ledger, error: ledgerError }] =
    await Promise.all([
      supabase
        .from("stores")
        .select("id, name, subscription_status, subscription_plan, subscription_override, grace_until, created_at, stripe_customer_id")
        .eq("id", storeId)
        .maybeSingle(),
      supabase.from("store_members").select("user_id, role, created_at").eq("store_id", storeId),
      supabase
        .from("scan_ledger")
        .select("id, delta, reason, note, created_at")
        .eq("store_id", storeId)
        .order("created_at", { ascending: false })
        .limit(40),
    ]);
  if (error) throw new ApiError(500, error.message);
  if (!store) throw new ApiError(404, "Store not found");
  if (membersError) throw new ApiError(500, membersError.message);
  if (ledgerError) throw new ApiError(500, ledgerError.message);

  const userIds = (members ?? []).map((member) => member.user_id as string);
  const { data: profiles, error: profilesError } =
    userIds.length === 0
      ? { data: [], error: null }
      : await supabase.from("user_profiles").select("user_id, email, full_name").in("user_id", userIds);
  if (profilesError) throw new ApiError(500, profilesError.message);
  const profileByUser = new Map((profiles ?? []).map((profile) => [profile.user_id as string, profile]));
  const balances = await scanBalances(storeId);
  const { data: settings, error: settingsError } = await supabase
    .from("platform_settings")
    .select("subscription_mode")
    .eq("id", 1)
    .single();
  if (settingsError) throw new ApiError(500, settingsError.message);

  res.json({
    data: {
      ...store,
      subscription_override: normalizeOverride(store.subscription_override),
      subscription_enforced: subscriptionEnforced(Boolean(settings.subscription_mode), normalizeOverride(store.subscription_override)),
      has_stripe: Boolean(store.stripe_customer_id),
      ...{
        plan_scans_remaining: balances.plan,
        topup_scans_remaining: balances.topup,
        scans_remaining: balances.plan + balances.topup,
      },
      members: (members ?? []).map((member) => {
        const profile = profileByUser.get(member.user_id as string);
        return {
          user_id: member.user_id,
          role: member.role,
          full_name: (profile?.full_name as string | undefined) ?? "Team member",
          email: (profile?.email as string | undefined) ?? "",
        };
      }),
      ledger: ledger ?? [],
    },
  });
}

export async function patchAdminStoreSubscription(req: Request, res: Response) {
  const parsed = overrideSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, "Choose on, off, or platform.", parsed.error.flatten());
  const override = parsed.data.override === "platform" ? null : parsed.data.override;
  const data = await setStoreSubscriptionOverride(req.params.id as string, override);
  res.json({ data });
}

export async function listAdminUsers(_req: Request, res: Response) {
  res.json({ data: await listPeople() });
}

export async function postAdminScanAdjustment(req: Request, res: Response) {
  const parsed = adjustSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, "Invalid scan adjustment", parsed.error.flatten());
  const storeId = req.params.id as string;
  await adjustScans(storeId, parsed.data.delta, parsed.data.note.trim());
  const balances = await scanBalances(storeId);
  res.json({ data: { scans_remaining: balances.plan + balances.topup, ...balances } });
}

function normalizeOverride(value: unknown): "on" | "off" | null {
  return value === "on" || value === "off" ? value : null;
}

async function listAuthUsers() {
  const users = [];
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new ApiError(500, error.message);
    users.push(...data.users);
    if (data.users.length < 200) break;
  }
  return users;
}

async function listPeople() {
  const [authUsers, membersResult, profilesResult, storesResult] = await Promise.all([
    listAuthUsers(),
    supabase.from("store_members").select("user_id, store_id, role"),
    supabase.from("user_profiles").select("user_id, email, full_name"),
    supabase.from("stores").select("id, name"),
  ]);
  if (membersResult.error) throw new ApiError(500, membersResult.error.message);
  if (profilesResult.error) throw new ApiError(500, profilesResult.error.message);
  if (storesResult.error) throw new ApiError(500, storesResult.error.message);

  const memberByUser = new Map((membersResult.data ?? []).map((member) => [member.user_id as string, member]));
  const profileByUser = new Map((profilesResult.data ?? []).map((profile) => [profile.user_id as string, profile]));
  const storeNameById = new Map((storesResult.data ?? []).map((store) => [store.id as string, store.name as string]));

  return authUsers
    .map((user) => {
      const member = memberByUser.get(user.id);
      const profile = profileByUser.get(user.id);
      const metaName = typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name : "";
      const storeId = (member?.store_id as string | undefined) ?? null;
      return {
        id: user.id,
        email: (profile?.email as string | undefined) || user.email || "",
        full_name:
          (profile?.full_name as string | undefined) || metaName || (user.email ? user.email.split("@")[0] : "User"),
        created_at: user.created_at ?? null,
        last_sign_in_at: user.last_sign_in_at ?? null,
        store_id: storeId,
        store_name: storeId ? (storeNameById.get(storeId) ?? null) : null,
        role: (member?.role as string | undefined) ?? null,
      };
    })
    .sort((left, right) => (right.created_at ?? "").localeCompare(left.created_at ?? ""));
}
