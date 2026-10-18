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

const PLATFORM_FEE_PERCENT = 10; // OnCall's cut. Change this one number to adjust it everywhere.
const AUTO_RELEASE_HOURS = 24;   // Poster's window to approve or report a problem. Server-controlled only.

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!);

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
  const platformFeeCents = Math.round(pi.amount * (PLATFORM_FEE_PERCENT / 100));
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
  const { data: workerProfile } = await db.from("profiles").select("*").eq("id", bid.worker_id).single();

  const captured = await stripe.paymentIntents.capture(payment.stripe_payment_intent_id);
  const platformFeeCents = Math.round(Number(payment.platform_fee) * 100);
  const payoutCents = captured.amount_received - platformFeeCents;

  let transferId: string | null = null;
  if (workerProfile?.stripe_connect_account_id) {
    try {
      const transfer = await stripe.transfers.create({
        amount: payoutCents,
        currency: "eur",
        destination: workerProfile.stripe_connect_account_id,
        source_transaction:
          typeof captured.latest_charge === "string" ? captured.latest_charge : undefined,
        metadata: { taskId },
      });
      transferId = transfer.id;
    } catch (e) {
      // Charge already succeeded; don't lose that state. Money stays in the
      // platform balance and can be transferred manually.
      console.error("transfer failed", taskId, e);
    }
  }

  await db.from("payments").update({
    status: "released",
    released_at: new Date().toISOString(),
  }).eq("task_id", taskId);
  await db.from("tasks").update({ completed: true }).eq("id", taskId);
  return json({ ok: true, transferId });
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
async function connectOnboardingLink(caller: any, body: any) {
  const { returnUrl, refreshUrl } = body;
  if (typeof returnUrl !== "string" || !returnUrl.startsWith(ALLOWED_RETURN_PREFIX) ||
      typeof refreshUrl !== "string" || !refreshUrl.startsWith(ALLOWED_RETURN_PREFIX)) {
    return json({ error: "Invalid return address." }, 400);
  }
  const { data: profile } = await db.from("profiles").select("*").eq("id", caller.id).single();
  let accountId: string | null = profile?.stripe_connect_account_id ?? null;
  if (!accountId) {
    const account = await stripe.accounts.create({
      type: "express",
      email: caller.email,
      metadata: { supabase_user_id: caller.id },
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
  return json({ ready, payoutsEnabled: account.payouts_enabled, chargesEnabled: account.charges_enabled });
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
  return json({ swept: results.length, results, remindersSent });
}
