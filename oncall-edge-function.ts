// supabase/functions/oncall/index.ts
//
// OnCall — single Edge Function handling every money-moving / job-lifecycle
// action. The client calls it with { action, ...params } in the POST body.
//
// verify_jwt is OFF at the gateway on purpose: the database timer (pg_cron)
// has no user login. Every user action below still checks the caller's login
// token itself (getCaller), and the timer action checks a Vault secret.

import Stripe from "npm:stripe@^17.0.0";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const PLATFORM_FEE_PERCENT = 10;         // OnCall's cut on a job.
const PREMIUM_PLATFORM_FEE_PERCENT = 6;  // Cut when the winning worker has Premium at the moment the bid is accepted.
const PREMIUM_PRICE_CENTS = 499;         // Premium: €4.99 a month.
const BOOST_PRICE_CENTS = 199;           // One-off "Boost this job": €1.99.
const FEATURED_HOURS = 48;               // How long a boosted (or Premium poster's) job stays Featured.
const AUTO_RELEASE_HOURS = 24;   // Poster's window to approve or report a problem. Server-controlled only.

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!);
// Restricted key with "Identity Verification Results" + "Recent Detailed Verification
// Results" read access. Needed only to read the date of birth for the 18+ check.
const identityKey = Deno.env.get("STRIPE_IDENTITY_KEY");
const stripeIdentity = identityKey ? new Stripe(identityKey) : null;
const MIN_AGE = 18;
const MAX_ID_ATTEMPTS = 5; // Stripe charges per completed check; stop runaway retries.

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

const db = createClient(supabaseUrl, serviceRoleKey);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function getCaller(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;
  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data, error } = await authClient.auth.getUser();
  if (error || !data?.user) return null;
  return data.user;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Bad request body." }, 400);
  }
  const { action } = body;

  if (action === "auto_release_sweep") {
    // The database timer (pg_cron) sends a shared secret kept in Supabase Vault.
    const cronSecret = req.headers.get("x-cron-secret") ?? "";
    const { data: okSecret } = cronSecret
      ? await db.rpc("check_cron_secret", { s: cronSecret })
      : { data: false };
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!okSecret && authHeader !== `Bearer ${serviceRoleKey}`) return json({ error: "Not authorized." }, 401);
    return await autoReleaseSweep();
  }

  const caller = await getCaller(req);
  if (!caller) return json({ error: "Not signed in." }, 401);

  try {
    switch (action) {
      case "create_payment_intent":
        return await createPaymentIntent(caller, body);
      case "create_checkout_session":
        return await createCheckoutSession(caller, body);
      case "submit_review":
        return await submitReview(caller, body);
      case "finalize_accept_bid":
        return await finalizeAcceptBid(caller, body);
      case "mark_job_done":
        return await markJobDone(caller, body);
      case "approve_completion":
        return await approveCompletion(caller, body);
      case "file_dispute":
        return await fileDispute(caller, body);
      case "connect_onboarding_link":
        return await connectOnboardingLink(caller, body);
      case "sync_connect_status":
        return await syncConnectStatus(caller);
      case "create_premium_checkout":
        return await createPremiumCheckout(caller, body);
      case "sync_premium":
        return json(await syncPremium(caller.id));
      case "set_premium_renewal":
        return await setPremiumRenewal(caller, body);
      case "create_boost_checkout":
        return await createBoostCheckout(caller, body);
      case "finalize_boost":
        return await finalizeBoost(caller, body);
      case "submit_report":
        return await submitReport(caller, body);
      case "start_id_check":
        return await startIdCheck(caller, body);
      case "sync_id_check":
        return json(await syncIdCheck(caller.id));
      case "delete_account":
        return await deleteAccount(caller, body);
      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (err) {
    console.error(action, err);
    return json({ error: err instanceof Error ? err.message : "Server error." }, 500);
  }
});

async function getOrCreateCustomer(caller: any) {
  const { data: posterProfile } = await db.from("profiles").select("*").eq("id", caller.id).single();
  let customerId: string | null = posterProfile?.stripe_customer_id ?? null;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: caller.email,
      metadata: { supabase_user_id: caller.id },
    });
    customerId = customer.id;
    await db.from("profiles").update({ stripe_customer_id: customerId }).eq("id", caller.id);
  }
  return customerId;
}

// ---------- 1. (legacy) PaymentIntent for an in-app card form ----------
async function createPaymentIntent(caller: any, body: any) {
  const { taskId, bidId } = body;
  const { data: task } = await db.from("tasks").select("*").eq("id", taskId).single();
  if (!task) return json({ error: "Job not found." }, 404);
  if (task.poster_id !== caller.id) {
    return json({ error: "Only the person who posted this job can accept a bid." }, 403);
  }
  if (task.accepted_bid_id) return json({ error: "This job already has an accepted bid." }, 400);
  const { data: bid } = await db.from("bids").select("*").eq("id", bidId).eq("task_id", taskId).single();
  if (!bid) return json({ error: "Bid not found." }, 404);
  const customerId = await getOrCreateCustomer(caller);
  const paymentIntent = await stripe.paymentIntents.create({
    amount: Math.round(Number(bid.price) * 100),
    currency: "eur",
    customer: customerId,
    capture_method: "manual",
    payment_method_types: ["card"],
    metadata: { taskId, bidId, posterId: caller.id, workerId: bid.worker_id },
  });
  return json({ clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id });
}

// ---------- 1b. Stripe-hosted card page: authorize and hold the money ----------
const ALLOWED_RETURN_PREFIX = "https://natb1234.github.io/oncall-app/";

async function createCheckoutSession(caller: any, body: any) {
  const { taskId, bidId, returnUrl } = body;
  if (typeof returnUrl !== "string" || !returnUrl.startsWith(ALLOWED_RETURN_PREFIX)) {
    return json({ error: "Invalid return address." }, 400);
  }
  const { data: task } = await db.from("tasks").select("*").eq("id", taskId).single();
  if (!task) return json({ error: "Job not found." }, 404);
  if (task.poster_id !== caller.id) {
    return json({ error: "Only the person who posted this job can accept a bid." }, 403);
  }
  if (task.accepted_bid_id) return json({ error: "This job already has an accepted bid." }, 400);
  const { data: bid } = await db.from("bids").select("*").eq("id", bidId).eq("task_id", taskId).single();
  if (!bid) return json({ error: "Bid not found." }, 404);

  const customerId = await getOrCreateCustomer(caller);
  const amount = Math.round(Number(bid.price) * 100);
  const base = returnUrl.split("?")[0].split("#")[0];

  const checkout = await stripe.checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    payment_method_types: ["card"],
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "eur",
        unit_amount: amount,
        product_data: { name: `OnCall job: ${String(task.title).slice(0, 80)}` },
      },
    }],
    payment_intent_data: {
      capture_method: "manual",
      metadata: { taskId, bidId, posterId: caller.id, workerId: bid.worker_id },
    },
    success_url: `${base}?paid=1&task=${taskId}&bid=${bidId}&cs={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}?paycancel=1`,
  });
  return json({ url: checkout.url });
}

// ---------- 2. Lock in the escrow once Stripe confirms the hold ----------
async function finalizeAcceptBid(caller: any, body: any) {
  const { taskId, bidId } = body;
  let { paymentIntentId } = body;

  const { data: task } = await db.from("tasks").select("*").eq("id", taskId).single();
  if (!task) return json({ error: "Job not found." }, 404);
  if (task.poster_id !== caller.id) return json({ error: "Not your job." }, 403);
  if (task.accepted_bid_id === bidId) return json({ ok: true, alreadyDone: true });
  if (task.accepted_bid_id) return json({ error: "Already accepted." }, 400);

  if (!paymentIntentId && body.sessionId) {
    const cs = await stripe.checkout.sessions.retrieve(body.sessionId);
    if (!cs.payment_intent) return json({ error: "Payment not found for this checkout." }, 400);
    paymentIntentId = typeof cs.payment_intent === "string" ? cs.payment_intent : cs.payment_intent.id;
  }
  if (!paymentIntentId) return json({ error: "Missing payment reference." }, 400);

  const { data: bid } = await db.from("bids").select("*").eq("id", bidId).eq("task_id", taskId).single();
  if (!bid) return json({ error: "Bid not found." }, 404);

  const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (pi.metadata.taskId !== taskId || pi.metadata.bidId !== bidId) {
    return json({ error: "Payment doesn't match this job/bid." }, 400);
  }
  if (pi.status !== "requires_capture") {
    return json({ error: `Payment isn't ready yet (status: ${pi.status}).` }, 400);
  }
  if (pi.amount !== Math.round(Number(bid.price) * 100)) {
    return json({ error: "Payment amount doesn't match the bid." }, 400);
  }

  await db.from("tasks").update({ accepted_bid_id: bidId }).eq("id", taskId);
  // The fee is fixed now, from the worker's Premium status at this moment.
  let workerPremium = false;
  try { workerPremium = (await syncPremium(bid.worker_id)).active; } catch (e) { console.error("premium check", e); }
  const feePercent = workerPremium ? PREMIUM_PLATFORM_FEE_PERCENT : PLATFORM_FEE_PERCENT;
  const platformFeeCents = Math.round(pi.amount * (feePercent / 100));
  await db.from("payments").insert({
    task_id: taskId,
    stripe_payment_intent_id: paymentIntentId,
    amount: pi.amount / 100,
    platform_fee: platformFeeCents / 100,
    status: "held",
  });
  return json({ ok: true });
}

// ---------- 3. Worker marks the job done — starts the auto-release clock ----------
async function markJobDone(caller: any, body: any) {
  const { taskId, photoUrl } = body;
  const { data: task } = await db.from("tasks").select("*").eq("id", taskId).single();
  if (!task) return json({ error: "Job not found." }, 404);
  if (!task.accepted_bid_id) return json({ error: "This job has no accepted bid yet." }, 400);
  const { data: bid } = await db.from("bids").select("*").eq("id", task.accepted_bid_id).single();
  if (!bid || bid.worker_id !== caller.id) {
    return json({ error: "Only the accepted worker can mark this job done." }, 403);
  }
  if (task.completed) return json({ error: "Job is already marked complete." }, 400);
  if (task.worker_completed_at) return json({ error: "Already marked done — waiting on approval." }, 400);
  if (!photoUrl) return json({ error: "Add a photo of the finished job first." }, 400);

  // Fixed window set by the server — never by the worker's app.
  const hours = AUTO_RELEASE_HOURS;

  await db.from("tasks").update({
    worker_completed_at: new Date().toISOString(),
    completion_photo_url: photoUrl,
    auto_release_at: new Date(Date.now() + hours * 3600 * 1000).toISOString(),
  }).eq("id", taskId);
  return json({ ok: true });
}

// ---------- 4. Poster approves — capture the payment and pay the worker ----------
async function approveCompletion(caller: any, body: any) {
  const { taskId } = body;
  return await releaseTaskPayment(taskId, caller.id, "poster");
}

async function releaseTaskPayment(taskId: string, callerId: string | null, mode: "poster" | "auto") {
  const { data: task } = await db.from("tasks").select("*").eq("id", taskId).single();
  if (!task) return json({ error: "Job not found." }, 404);
  if (mode === "poster" && task.poster_id !== callerId) {
    return json({ error: "Only the person who posted this job can approve it." }, 403);
  }
  if (task.completed) return json({ error: "Already released." }, 400);
  if (task.disputed) return json({ error: "This job is disputed — it needs manual review." }, 400);
  if (!task.accepted_bid_id) return json({ error: "No accepted bid." }, 400);
  if (!task.worker_completed_at) return json({ error: "The worker hasn't marked this job done yet." }, 400);

  const { data: bid } = await db.from("bids").select("*").eq("id", task.accepted_bid_id).single();
  const { data: payment } = await db.from("payments").select("*").eq("task_id", taskId).single();
  if (!payment) return json({ error: "No payment on file for this job." }, 400);

  await stripe.paymentIntents.capture(payment.stripe_payment_intent_id);

  await db.from("payments").update({
    status: "released",
    released_at: new Date().toISOString(),
  }).eq("task_id", taskId);
  await db.from("tasks").update({ completed: true }).eq("id", taskId);

  // Send the worker their share now if their payout account is ready.
  // If it isn't, the money waits in OnCall's balance and is sent later by
  // payPendingPayouts (when they finish payout setup, or on the next timer run).
  let transferId: string | null = null;
  try {
    transferId = await payWorkerForTask(taskId, bid.worker_id);
  } catch (e) {
    console.error("transfer failed", taskId, e);
  }
  return json({ ok: true, transferId });
}

// ---------- 4b. Send a worker their share of a released job ----------
// Safe to call more than once for the same job: it skips jobs already paid
// (in our database or in Stripe), and an idempotency key covers two calls racing.
async function isPayoutReady(accountId: string) {
  const account = await stripe.accounts.retrieve(accountId);
  return account.capabilities?.transfers === "active";
}

async function payWorkerForTask(taskId: string, workerId: string): Promise<string | null> {
  const { data: payment } = await db.from("payments").select("*").eq("task_id", taskId).single();
  if (!payment || payment.status !== "released") return null;
  if (payment.payout_transfer_id) return payment.payout_transfer_id;

  const { data: worker } = await db.from("profiles").select("stripe_connect_account_id").eq("id", workerId).single();
  const accountId = worker?.stripe_connect_account_id;
  if (!accountId || !(await isPayoutReady(accountId))) return null;

  const pi = await stripe.paymentIntents.retrieve(payment.stripe_payment_intent_id);
  if (pi.status !== "succeeded") return null;
  const payoutCents = pi.amount_received - Math.round(Number(payment.platform_fee) * 100);
  if (payoutCents <= 0) return null;

  // Guard against paying twice: if a transfer for this job already exists in
  // Stripe (e.g. the database update after it failed), just record it.
  const existing = await stripe.transfers.list({ destination: accountId, limit: 100 });
  let transfer = existing.data.find((t) => t.metadata?.taskId === taskId && !t.reversed);
  if (!transfer) {
    // The key changes every 10 minutes: it still stops two near-simultaneous calls
    // from both paying, but a failed attempt (which Stripe remembers per key for
    // 24h) can be retried by the next timer run.
    const window = Math.floor(Date.now() / (10 * 60 * 1000));
    transfer = await stripe.transfers.create({
      amount: payoutCents,
      currency: "eur",
      destination: accountId,
      source_transaction: typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id,
      metadata: { taskId, workerId },
    }, { idempotencyKey: `oncall-payout-${taskId}-${window}` });
  }

  await db.from("payments").update({
    payout_transfer_id: transfer.id,
    paid_out_at: new Date().toISOString(),
  }).eq("task_id", taskId);
  return transfer.id;
}

// Pays every released job whose worker hasn't been paid yet (optionally for one worker only).
async function payPendingPayouts(onlyWorkerId?: string) {
  const { data: pending } = await db
    .from("payments")
    .select("task_id")
    .eq("status", "released")
    .is("payout_transfer_id", null);

  let paid = 0;
  let paidCents = 0;
  for (const p of pending ?? []) {
    const { data: task } = await db.from("tasks").select("accepted_bid_id").eq("id", p.task_id).single();
    if (!task?.accepted_bid_id) continue;
    const { data: bid } = await db.from("bids").select("worker_id").eq("id", task.accepted_bid_id).single();
    const workerId = bid?.worker_id;
    if (!workerId || (onlyWorkerId && workerId !== onlyWorkerId)) continue;
    try {
      const transferId = await payWorkerForTask(p.task_id, workerId);
      if (transferId) {
        paid++;
        const t = await stripe.transfers.retrieve(transferId);
        paidCents += t.amount;
      }
    } catch (e) {
      console.error("pending payout failed", p.task_id, e);
    }
  }
  return { paid, paidAmount: paidCents / 100 };
}

// ---------- 5. Dispute — stops auto-release, flags for manual review ----------
async function fileDispute(caller: any, body: any) {
  const { taskId, note } = body;
  const { data: task } = await db.from("tasks").select("*").eq("id", taskId).single();
  if (!task) return json({ error: "Job not found." }, 404);
  if (!task.accepted_bid_id) return json({ error: "No accepted bid on this job." }, 400);
  const { data: bid } = await db.from("bids").select("*").eq("id", task.accepted_bid_id).single();
  const isPoster = task.poster_id === caller.id;
  const isWorker = bid?.worker_id === caller.id;
  if (!isPoster && !isWorker) return json({ error: "You're not part of this job." }, 403);
  if (task.completed) return json({ error: "This job is already paid out." }, 400);
  await db.from("tasks").update({ disputed: true, dispute_note: note ?? null }).eq("id", taskId);
  return json({ ok: true });
}

// ---------- 5b. Poster rates the worker after payout ----------
async function submitReview(caller: any, body: any) {
  const { taskId, rating, text } = body;
  const stars = Number(rating);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    return json({ error: "Pick a rating from 1 to 5 stars." }, 400);
  }
  const { data: task } = await db.from("tasks").select("*").eq("id", taskId).single();
  if (!task) return json({ error: "Job not found." }, 404);
  if (task.poster_id !== caller.id) return json({ error: "Only the person who posted this job can rate it." }, 403);
  if (!task.completed) return json({ error: "You can rate once the job is paid out." }, 400);
  if (task.rated) return json({ error: "You've already rated this job." }, 400);
  const { data: bid } = await db.from("bids").select("*").eq("id", task.accepted_bid_id).single();
  if (!bid) return json({ error: "No accepted bid." }, 400);
  await db.from("reviews").insert({
    task_id: taskId,
    reviewer_id: caller.id,
    reviewee_id: bid.worker_id,
    rating: stars,
    text: typeof text === "string" ? text.slice(0, 500) : null,
  });
  await db.from("tasks").update({ rated: true }).eq("id", taskId);
  return json({ ok: true });
}

// ---------- 6. Worker connects their payout account (Stripe-hosted onboarding) ----------
// Workers are ordinary people, not companies: telling Stripe up front skips the
// company questions, and filling in what OnCall is skips the "describe your business" step.
const WORKER_ACCOUNT_PREFILL = {
  business_type: "individual" as const,
  business_profile: {
    mcc: "7299", // Miscellaneous personal services
    url: "https://natb1234.github.io/oncall-app/",
    product_description: "Small same-day local jobs (odd jobs, help around the home) booked and paid through OnCall.",
  },
};

async function connectOnboardingLink(caller: any, body: any) {
  const { returnUrl, refreshUrl } = body;
  if (typeof returnUrl !== "string" || !returnUrl.startsWith(ALLOWED_RETURN_PREFIX) ||
      typeof refreshUrl !== "string" || !refreshUrl.startsWith(ALLOWED_RETURN_PREFIX)) {
    return json({ error: "Invalid return address." }, 400);
  }
  const { data: profile } = await db.from("profiles").select("*").eq("id", caller.id).single();
  let accountId: string | null = profile?.stripe_connect_account_id ?? null;

  if (accountId) {
    // An unfinished account made before the prefill existed (no oncall_prefill tag)
    // is replaced with a fresh prefilled one.
    // Stripe won't let us edit it once a setup link has been opened, and an
    // unfinished account can't hold any money, so nothing is lost.
    const existing = await stripe.accounts.retrieve(accountId);
    if (!existing.details_submitted && existing.metadata?.oncall_prefill !== "1") {
      accountId = null;
    }
  }

  if (!accountId) {
    const account = await stripe.accounts.create({
      type: "express",
      country: "IE",
      email: caller.email,
      ...WORKER_ACCOUNT_PREFILL,
      metadata: { supabase_user_id: caller.id, oncall_prefill: "1" },
    });
    accountId = account.id;
    await db.from("profiles").update({ stripe_connect_account_id: accountId }).eq("id", caller.id);
  }
  const accountLink = await stripe.accountLinks.create({
    account: accountId,
    type: "account_onboarding",
    return_url: returnUrl,
    refresh_url: refreshUrl,
  });
  return json({ url: accountLink.url });
}

// ---------- 7. Is a worker's payout setup ready? ----------
async function syncConnectStatus(caller: any) {
  const { data: profile } = await db.from("profiles").select("*").eq("id", caller.id).single();
  if (!profile?.stripe_connect_account_id) return json({ ready: false });
  const account = await stripe.accounts.retrieve(profile.stripe_connect_account_id);
  const ready = !!account.payouts_enabled && !!account.charges_enabled;
  // Now that the account works, send any job money that was waiting for it.
  let backPay = { paid: 0, paidAmount: 0 };
  if (account.capabilities?.transfers === "active") {
    backPay = await payPendingPayouts(caller.id);
  }
  return json({ ready, payoutsEnabled: account.payouts_enabled, chargesEnabled: account.charges_enabled, ...backPay });
}

// ---------- 7b. Premium subscription (€4.99/month) ----------
// Stripe is the source of truth. profiles.premium / premium_until are a copy for
// the app (badge, Profile page), refreshed on every check below.
async function findPremiumSubscription(customerId: string) {
  const subs = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 20 });
  return subs.data.find((s) => s.metadata?.oncall === "premium" && ["active", "trialing"].includes(s.status)) ?? null;
}

async function syncPremium(userId: string) {
  const { data: profile } = await db.from("profiles").select("stripe_customer_id, premium").eq("id", userId).single();
  let sub: any = null;
  if (profile?.stripe_customer_id) sub = await findPremiumSubscription(profile.stripe_customer_id);
  const periodEnd = sub ? (sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null) : null;
  const premiumUntil = periodEnd ? new Date(periodEnd * 1000).toISOString() : null;
  await db.from("profiles").update({ premium: !!sub, premium_until: premiumUntil }).eq("id", userId);
  return { active: !!sub, premiumUntil, cancelling: !!sub?.cancel_at_period_end };
}

async function createPremiumCheckout(caller: any, body: any) {
  const { returnUrl } = body;
  if (typeof returnUrl !== "string" || !returnUrl.startsWith(ALLOWED_RETURN_PREFIX)) {
    return json({ error: "Invalid return address." }, 400);
  }
  if ((await syncPremium(caller.id)).active) return json({ error: "You already have Premium." }, 400);
  const customerId = await getOrCreateCustomer(caller);
  const base = returnUrl.split("?")[0].split("#")[0];
  const checkout = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "eur",
        unit_amount: PREMIUM_PRICE_CENTS,
        recurring: { interval: "month" },
        product_data: { name: "OnCall Premium" },
      },
    }],
    subscription_data: { metadata: { oncall: "premium", supabase_user_id: caller.id } },
    success_url: `${base}?premium=1`,
    cancel_url: `${base}?premiumcancel=1`,
  });
  return json({ url: checkout.url });
}

// Cancel at the end of the paid month, or undo that before it ends.
async function setPremiumRenewal(caller: any, body: any) {
  const renew = body.renew === true;
  const { data: profile } = await db.from("profiles").select("stripe_customer_id").eq("id", caller.id).single();
  const sub = profile?.stripe_customer_id ? await findPremiumSubscription(profile.stripe_customer_id) : null;
  if (!sub) return json({ error: "You don't have Premium." }, 400);
  await stripe.subscriptions.update(sub.id, { cancel_at_period_end: !renew });
  return json(await syncPremium(caller.id));
}

// ---------- 7c. Boost a job (€1.99 one-off): Featured at the top of Home for 48h ----------
function isFeatured(task: any) {
  return !!task.featured_until && new Date(task.featured_until).getTime() > Date.now();
}

async function createBoostCheckout(caller: any, body: any) {
  const { taskId, returnUrl } = body;
  if (typeof returnUrl !== "string" || !returnUrl.startsWith(ALLOWED_RETURN_PREFIX)) {
    return json({ error: "Invalid return address." }, 400);
  }
  const { data: task } = await db.from("tasks").select("*").eq("id", taskId).single();
  if (!task) return json({ error: "Job not found." }, 404);
  if (task.poster_id !== caller.id) return json({ error: "You can only boost your own jobs." }, 403);
  if (task.accepted_bid_id || task.completed) return json({ error: "This job already has a worker." }, 400);
  if (isFeatured(task)) return json({ error: "This job is already Featured." }, 400);

  const customerId = await getOrCreateCustomer(caller);
  const base = returnUrl.split("?")[0].split("#")[0];
  const checkout = await stripe.checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    payment_method_types: ["card"],
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "eur",
        unit_amount: BOOST_PRICE_CENTS,
        product_data: { name: `Boost: ${String(task.title).slice(0, 60)}` },
      },
    }],
    metadata: { oncall: "boost", taskId, posterId: caller.id },
    success_url: `${base}?boosted=1&task=${taskId}&cs={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}?boostcancel=1`,
  });
  return json({ url: checkout.url });
}

// Called when the poster comes back from paying. Safe to call twice for the same payment.
async function finalizeBoost(caller: any, body: any) {
  const { sessionId } = body;
  if (typeof sessionId !== "string") return json({ error: "Missing payment reference." }, 400);
  const cs = await stripe.checkout.sessions.retrieve(sessionId);
  if (cs.metadata?.oncall !== "boost" || cs.metadata?.posterId !== caller.id) {
    return json({ error: "That payment isn't a boost for one of your jobs." }, 400);
  }
  if (cs.payment_status !== "paid") return json({ error: "Payment hasn't gone through yet." }, 400);
  const taskId = cs.metadata.taskId;
  const { data: task } = await db.from("tasks").select("*").eq("id", taskId).single();
  if (!task) return json({ error: "Job not found." }, 404);
  if (task.boost_session_id === sessionId) return json({ ok: true, featuredUntil: task.featured_until });
  const featuredUntil = new Date(Date.now() + FEATURED_HOURS * 3600 * 1000).toISOString();
  await db.from("tasks").update({ featured_until: featuredUntil, boost_session_id: sessionId }).eq("id", taskId);
  return json({ ok: true, featuredUntil });
}

// ---------- 7d. Reports of illegal content / rule breaks (EU Digital Services Act) ----------
// Saved in public.reports and emailed to the owner (REPORTS_EMAIL secret, or the
// Resend account owner while there's no domain).
const REPORTS_EMAIL = Deno.env.get("REPORTS_EMAIL") ?? "natbooth252@gmail.com";

async function submitReport(caller: any, body: any) {
  const { kind, taskId, userId } = body;
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 2000) : "";
  if (kind !== "task" && kind !== "user") return json({ error: "Unknown report type." }, 400);
  if (reason.length < 5) return json({ error: "Please say a bit more about the problem." }, 400);

  // Simple abuse limit: 20 reports per person per day.
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count } = await db.from("reports").select("id", { count: "exact", head: true })
    .eq("reporter_id", caller.id).gte("created_at", since);
  if ((count ?? 0) >= 20) return json({ error: "You've sent a lot of reports today — please email us instead." }, 429);

  let task: any = null;
  if (taskId) {
    const { data } = await db.from("tasks").select("id, title, poster_id").eq("id", taskId).maybeSingle();
    task = data;
  }
  if (kind === "task" && !task) return json({ error: "Job not found." }, 404);
  const reportedUserId = kind === "task" ? task.poster_id : userId;
  if (!reportedUserId) return json({ error: "Who are you reporting?" }, 400);

  const { data: report, error } = await db.from("reports").insert({
    reporter_id: caller.id, kind, task_id: task?.id ?? null, reported_user_id: reportedUserId, reason,
  }).select("id").single();
  if (error) throw error;

  const { data: reported } = await db.from("profiles").select("name").eq("id", reportedUserId).maybeSingle();
  try {
    await sendEmail(REPORTS_EMAIL, `OnCall report: ${kind === "task" ? "job" : "user"} — ${String(task?.title ?? reported?.name ?? "").slice(0, 60)}`,
      `<p><strong>New report</strong> (${escapeHtml(kind)})</p>
       <p><strong>Job:</strong> ${escapeHtml(task?.title ?? "—")}<br>
       <strong>Reported user:</strong> ${escapeHtml(reported?.name ?? reportedUserId)}<br>
       <strong>From:</strong> ${escapeHtml(caller.email ?? caller.id)}</p>
       <p><strong>Reason:</strong><br>${escapeHtml(reason)}</p>
       <p>Report id ${report.id}. Review it in Supabase → Table Editor → reports, set status and a decision note, and reply to the reporter.</p>`);
  } catch (e) { console.error("report email", e); }
  return json({ ok: true });
}

// ---------- 7e. ID + age verification (Stripe Identity: ID document check, no selfie) ----------
// We keep only the outcome (verified / under 18 / failed) and the date — never the
// date of birth or images, which stay with Stripe.
async function startIdCheck(caller: any, body: any) {
  const { returnUrl } = body;
  if (typeof returnUrl !== "string" || !returnUrl.startsWith(ALLOWED_RETURN_PREFIX)) {
    return json({ error: "Invalid return address." }, 400);
  }
  const { data: profile } = await db.from("profiles").select("*").eq("id", caller.id).single();
  if (!profile) return json({ error: "Set up your profile first." }, 400);
  if (profile.verified && profile.id_status === "verified") return json({ error: "You're already verified." }, 400);
  if (profile.id_status === "under_18") return json({ error: "OnCall is only for people aged 18 or over." }, 403);

  // Reuse an unfinished check (keeps failed attempts together, avoids paying twice).
  if (profile.id_session_id) {
    const existing = await stripe.identity.verificationSessions.retrieve(profile.id_session_id);
    if (existing.status === "processing") return json({ processing: true });
    if (existing.status === "verified") return json({ verified: (await syncIdCheck(caller.id)).verified });
    if (existing.status === "requires_input" && existing.url) {
      await db.from("profiles").update({ id_status: "pending" }).eq("id", caller.id);
      return json({ url: existing.url });
    }
  }
  if ((profile.id_attempts ?? 0) >= MAX_ID_ATTEMPTS) {
    return json({ error: "Too many verification attempts — please contact us." }, 429);
  }
  const base = returnUrl.split("?")[0].split("#")[0];
  const session = await stripe.identity.verificationSessions.create({
    type: "document",
    options: {
      document: {
        allowed_types: ["passport", "driving_license", "id_card"],
        require_live_capture: true,
      },
    },
    metadata: { supabase_user_id: caller.id },
    return_url: `${base}?idcheck=1`,
  } as any);
  await db.from("profiles").update({
    id_session_id: session.id, id_status: "pending", id_error: null,
    id_attempts: (profile.id_attempts ?? 0) + 1,
  }).eq("id", caller.id);
  return json({ url: session.url });
}

function ageFromDob(dob: { day: number; month: number; year: number }) {
  const now = new Date();
  let age = now.getUTCFullYear() - dob.year;
  const m = now.getUTCMonth() + 1, d = now.getUTCDate();
  if (m < dob.month || (m === dob.month && d < dob.day)) age--;
  return age;
}

async function syncIdCheck(userId: string) {
  const { data: profile } = await db.from("profiles").select("id_session_id, id_status, verified").eq("id", userId).single();
  if (!profile?.id_session_id) return { status: profile?.id_status ?? "none", verified: false };
  if (profile.verified && profile.id_status === "verified") return { status: "verified", verified: true };

  const s = await stripe.identity.verificationSessions.retrieve(profile.id_session_id);
  let update: Record<string, unknown> = {};
  if (s.status === "verified") {
    if (!stripeIdentity) {
      console.error("STRIPE_IDENTITY_KEY not set — can't check age");
      update = { id_status: "processing", id_error: "Age check not set up yet." };
    } else {
      const full: any = await stripeIdentity.identity.verificationSessions.retrieve(s.id, { expand: ["verified_outputs.dob"] });
      const dob = full.verified_outputs?.dob;
      if (!dob?.year) {
        update = { id_status: "failed", id_error: "We couldn't read a date of birth from that document." };
      } else if (ageFromDob(dob) < MIN_AGE) {
        update = { id_status: "under_18", verified: false, id_error: null };
      } else {
        update = { id_status: "verified", verified: true, id_verified_at: new Date().toISOString(), id_error: null };
      }
    }
  } else if (s.status === "processing") {
    update = { id_status: "processing" };
  } else if (s.status === "requires_input") {
    // Not submitted yet, or a check failed (blurry photo, unreadable or expired ID…).
    update = s.last_error
      ? { id_status: "failed", id_error: s.last_error.reason ?? "Verification didn't go through." }
      : { id_status: "pending" };
  } else if (s.status === "canceled") {
    update = { id_status: "none", id_session_id: null };
  }
  if (Object.keys(update).length) await db.from("profiles").update(update).eq("id", userId);
  const status = (update.id_status as string) ?? profile.id_status;
  return { status, verified: status === "verified", error: (update.id_error as string) ?? null };
}

// ---------- 7f. Delete my account (Apple App Store guideline 5.1.1(v)) ----------
// Deletes the login and personal data. Finished jobs, payments, reviews, reports
// and disputes must be kept (Privacy Policy section 6), so where they exist the
// profile stays as an anonymous "Deleted user" instead of being removed.
const DELETED_NAME = "Deleted user";

async function deleteAccount(caller: any, body: any) {
  if (body.confirm !== "DELETE") return json({ error: "Type DELETE to confirm." }, 400);
  const uid = caller.id;
  const { data: profile } = await db.from("profiles").select("*").eq("id", uid).maybeSingle();

  // 1. Not while money is moving: jobs in progress (either side) or a payout still owed.
  const { data: myTasks } = await db.from("tasks").select("id, accepted_bid_id, completed, disputed, media_url").eq("poster_id", uid);
  const { data: myBids } = await db.from("bids").select("id, task_id").eq("worker_id", uid);
  const myBidIds = (myBids ?? []).map((b) => b.id);
  const { data: wonTasks } = myBidIds.length
    ? await db.from("tasks").select("id, completed, disputed, completion_photo_url").in("accepted_bid_id", myBidIds)
    : { data: [] as any[] };
  const busy = [...(myTasks ?? []).filter((t) => t.accepted_bid_id && !t.completed), ...(wonTasks ?? []).filter((t) => !t.completed)];
  if (busy.length) {
    return json({ error: "You have a job in progress. Finish it (or wait for the dispute to be sorted) before deleting your account." }, 400);
  }
  if ((wonTasks ?? []).length) {
    const { data: owed } = await db.from("payments").select("task_id").in("task_id", wonTasks!.map((t) => t.id))
      .eq("status", "released").is("payout_transfer_id", null);
    if ((owed ?? []).length) {
      return json({ error: "Some job money is still waiting to be paid to you. Finish Profile → Getting paid first, or contact us so we can sort it out." }, 400);
    }
  }

  // 2. Stripe: stop Premium now (no more charges) and ask Stripe to delete the ID check.
  if (profile?.stripe_customer_id) {
    const subs = await stripe.subscriptions.list({ customer: profile.stripe_customer_id, status: "all", limit: 20 });
    for (const s of subs.data) {
      if (s.metadata?.oncall === "premium" && !["canceled", "incomplete_expired"].includes(s.status)) {
        await stripe.subscriptions.cancel(s.id);
      }
    }
  }
  if (profile?.id_session_id) {
    try { await stripe.identity.verificationSessions.redact(profile.id_session_id); }
    catch (e) { console.error("identity redact", e); }
  }

  // 3. Open jobs (no worker yet) go, with their bids and messages. Reports about them are kept.
  const openTaskIds = (myTasks ?? []).filter((t) => !t.accepted_bid_id).map((t) => t.id);
  if (openTaskIds.length) {
    await db.from("reports").update({ task_id: null }).in("task_id", openTaskIds);
    const { error } = await db.from("tasks").delete().in("id", openTaskIds);
    if (error) throw error;
  }
  // My bids that weren't accepted.
  const wonBidIds = new Set<string>();
  if (myBidIds.length) {
    const { data: acc } = await db.from("tasks").select("accepted_bid_id").in("accepted_bid_id", myBidIds);
    (acc ?? []).forEach((t) => wonBidIds.add(t.accepted_bid_id));
    const losing = myBidIds.filter((id) => !wonBidIds.has(id));
    if (losing.length) await db.from("bids").delete().in("id", losing);
  }

  // 4. Messages and photos — except on disputed jobs, which are kept as evidence.
  const keptTasks = [...(myTasks ?? []).filter((t) => t.accepted_bid_id), ...(wonTasks ?? [])];
  const disputedIds = new Set(keptTasks.filter((t) => t.disputed).map((t) => t.id));
  const { data: msgs } = await db.from("messages").select("id, task_id").or(`sender_id.eq.${uid},recipient_id.eq.${uid}`);
  const msgIds = (msgs ?? []).filter((m) => !disputedIds.has(m.task_id)).map((m) => m.id);
  for (let i = 0; i < msgIds.length; i += 200) {
    await db.from("messages").delete().in("id", msgIds.slice(i, i + 200));
  }
  const keepUrls = new Set<string>();
  for (const t of keptTasks) {
    if (!disputedIds.has(t.id)) continue;
    if (t.media_url) keepUrls.add(t.media_url);
    if (t.completion_photo_url) keepUrls.add(t.completion_photo_url);
  }
  const paths: string[] = [];
  for (const folder of [`${uid}/jobs`, `${uid}/done`, uid]) {
    const { data: files } = await db.storage.from("media").list(folder, { limit: 1000 });
    for (const f of files ?? []) if (f.id) paths.push(`${folder}/${f.name}`);
  }
  const removePaths = paths.filter((p) => ![...keepUrls].some((u) => u.endsWith("/media/" + p)));
  for (let i = 0; i < removePaths.length; i += 100) {
    await db.storage.from("media").remove(removePaths.slice(i, i + 100));
  }
  const notDisputedPosted = (myTasks ?? []).filter((t) => t.accepted_bid_id && !t.disputed).map((t) => t.id);
  if (notDisputedPosted.length) await db.from("tasks").update({ media_url: null, media_type: null }).in("id", notDisputedPosted);
  const notDisputedWon = (wonTasks ?? []).filter((t) => !t.disputed).map((t) => t.id);
  if (notDisputedWon.length) await db.from("tasks").update({ completion_photo_url: null }).in("id", notDisputedWon);

  // 5. Blocks, then the profile itself (or an anonymous placeholder if records must stay).
  await db.from("blocks").delete().or(`blocker_id.eq.${uid},blocked_id.eq.${uid}`);
  if (profile) {
    const { error: delErr } = await db.from("profiles").delete().eq("id", uid);
    if (delErr) {
      const { error } = await db.from("profiles").update({
        name: DELETED_NAME, trade: null, experience: null, skills: [], has_sample: false,
        area_lat: null, area_lng: null, area_label: null,
        premium: false, premium_until: null, stripe_customer_id: null, stripe_connect_account_id: null,
        verified: false, id_status: "none", id_session_id: null, id_verified_at: null, id_error: null,
        deleted_at: new Date().toISOString(),
      }).eq("id", uid);
      if (error) throw error;
    }
  }

  // 6. The login (email + password) — last, so a failure above can simply be retried.
  const { error: authErr } = await db.auth.admin.deleteUser(uid);
  if (authErr) throw authErr;
  return json({ ok: true });
}

// ---------- 8a. Reminder email to the poster ~4 hours before auto-release ----------
const REMINDER_HOURS_BEFORE = 4;
const APP_URL = "https://natb1234.github.io/oncall-app/";

async function sendEmail(to: string, subject: string, html: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) { console.warn("RESEND_API_KEY not set — skipping email to", to); return false; }
  const from = Deno.env.get("EMAIL_FROM") ?? "OnCall <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!res.ok) { console.error("email failed", res.status, await res.text()); return false; }
  return true;
}

function escapeHtml(s: string) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c]);
}

async function sendApprovalReminders() {
  const cutoff = new Date(Date.now() + REMINDER_HOURS_BEFORE * 3600 * 1000).toISOString();
  const { data: due } = await db
    .from("tasks")
    .select("id, title, poster_id, auto_release_at")
    .lte("auto_release_at", cutoff)
    .gt("auto_release_at", new Date().toISOString())
    .is("reminder_sent_at", null)
    .eq("completed", false)
    .eq("disputed", false);

  let sent = 0;
  for (const t of due ?? []) {
    const { data: u } = await db.auth.admin.getUserById(t.poster_id);
    const email = u?.user?.email;
    if (!email) continue;
    const hoursLeft = Math.max(1, Math.round((new Date(t.auto_release_at).getTime() - Date.now()) / 3600000));
    const ok = await sendEmail(
      email,
      `Action needed: approve "${String(t.title).slice(0, 60)}" within ${hoursLeft} hours`,
      `<p>Your worker has marked <strong>${escapeHtml(t.title)}</strong> as done.</p>
       <p>You have about <strong>${hoursLeft} hours</strong> left to approve it or report a problem.
       If you do nothing, payment is released to the worker automatically.</p>
       <p><a href="${APP_URL}">Open OnCall to review the job</a></p>`,
    );
    if (ok) {
      await db.from("tasks").update({ reminder_sent_at: new Date().toISOString() }).eq("id", t.id);
      sent++;
    }
  }
  return sent;
}

// ---------- 8. Timer sweep — releases any job whose auto-release clock ran out ----------
async function autoReleaseSweep() {
  let remindersSent = 0;
  try { remindersSent = await sendApprovalReminders(); } catch (e) { console.error("reminders", e); }

  const { data: dueTasks } = await db
    .from("tasks")
    .select("id")
    .lte("auto_release_at", new Date().toISOString())
    .eq("completed", false)
    .eq("auto_released", false)
    .eq("disputed", false)
    .not("accepted_bid_id", "is", null);

  const results: any[] = [];
  for (const t of dueTasks ?? []) {
    try {
      const res = await releaseTaskPayment(t.id, null, "auto");
      const resBody = await res.clone().json();
      if (resBody.ok) {
        await db.from("tasks").update({ auto_released: true }).eq("id", t.id);
      }
      results.push({ taskId: t.id, ...resBody });
    } catch (e) {
      results.push({ taskId: t.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  // Premium whose paid month has ended: re-check with Stripe (renewed or lapsed).
  try {
    const { data: lapsed } = await db.from("profiles").select("id")
      .eq("premium", true).or(`premium_until.is.null,premium_until.lt.${new Date().toISOString()}`);
    for (const p of lapsed ?? []) await syncPremium(p.id);
  } catch (e) { console.error("premium resync", e); }

  // ID checks still being processed by Stripe (people who closed the app before returning).
  try {
    const { data: waiting } = await db.from("profiles").select("id")
      .in("id_status", ["pending", "processing"]).not("id_session_id", "is", null).limit(50);
    for (const p of waiting ?? []) await syncIdCheck(p.id);
  } catch (e) { console.error("id resync", e); }

  // Catch-up: pay workers who finished payout setup after their job was released.
  let pendingPayouts = { paid: 0, paidAmount: 0 };
  try { pendingPayouts = await payPendingPayouts(); } catch (e) { console.error("pending payouts", e); }

  return json({ swept: results.length, results, remindersSent, pendingPayouts });
}
