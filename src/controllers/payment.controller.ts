
import type { RequestHandler, Response } from "express";
import { ObjectId } from "mongodb";
import Stripe from "stripe";

import { getCollections } from "../config/collections.js";
import { getDB } from "../config/db.js";
import { getStripe } from "../config/stripe.js";

interface AuthUser {
  id: string;
  name?: string;
  email?: string;
  role: "student" | "tutor" | "admin";
  plan?: string;
}

type ProRole = "student" | "tutor";
type ProPlan = "pro_student" | "pro_tutor";

const getUser = (res: Response): AuthUser =>
  res.locals.user as AuthUser;

const getClientURL = (): string =>
  (process.env.CLIENT_URL || "http://localhost:3000")
    .split(",")[0]
    .trim()
    .replace(/\/+$/, "");

const getSubscriptionId = (
  session: Stripe.Checkout.Session
): string => {
  if (typeof session.subscription === "string") {
    return session.subscription;
  }

  return session.subscription?.id ?? "";
};

const getPaymentIntentId = async (
  stripe: Stripe,
  session: Stripe.Checkout.Session,
  subscriptionId: string
): Promise<string> => {
  if (typeof session.payment_intent === "string") {
    return session.payment_intent;
  }

  if (session.payment_intent?.id) {
    return session.payment_intent.id;
  }

  const subscription =
    await stripe.subscriptions.retrieve(subscriptionId);

  const latestInvoice = subscription.latest_invoice;

  if (!latestInvoice) return "";

  const invoice =
    typeof latestInvoice === "string"
      ? await stripe.invoices.retrieve(latestInvoice)
      : latestInvoice;

  const paymentIntent = (
    invoice as Stripe.Invoice & {
      payment_intent?: string | Stripe.PaymentIntent | null;
    }
  ).payment_intent;

  if (typeof paymentIntent === "string") {
    return paymentIntent;
  }

  return paymentIntent?.id ?? "";
};

/**
 * Save a successful Checkout payment once and activate PRO.
 * Stripe session ID is unique, so webhook + success-page
 * verification cannot create duplicate payment records.
 */
const processSuccessfulCheckout = async (
  session: Stripe.Checkout.Session
): Promise<void> => {
  const metadata = session.metadata;

  if (!metadata?.userId || !metadata.role || !metadata.plan) {
    throw new Error("Payment metadata is incomplete.");
  }

  if (
    metadata.role !== "student" &&
    metadata.role !== "tutor"
  ) {
    throw new Error("Invalid payment role.");
  }

  const role = metadata.role as ProRole;
  const expectedPlan: ProPlan =
    role === "student" ? "pro_student" : "pro_tutor";

  if (metadata.plan !== expectedPlan) {
    throw new Error("Payment plan does not match the user role.");
  }

  if (
    session.mode !== "subscription" ||
    session.status !== "complete" ||
    session.payment_status !== "paid"
  ) {
    throw new Error("Stripe payment has not been completed.");
  }

  if (!ObjectId.isValid(metadata.userId)) {
    throw new Error("Invalid user ID in Stripe metadata.");
  }

  const stripe = getStripe();
  const subscriptionId = getSubscriptionId(session);

  if (!subscriptionId) {
    throw new Error("Stripe subscription was not found.");
  }

  const subscription =
    await stripe.subscriptions.retrieve(subscriptionId);

  if (
    subscription.status !== "active" &&
    subscription.status !== "trialing"
  ) {
    throw new Error("Stripe subscription is not active.");
  }

  if (
    subscription.metadata.userId !== metadata.userId ||
    subscription.metadata.role !== role ||
    subscription.metadata.plan !== expectedPlan
  ) {
    throw new Error("Stripe subscription metadata does not match.");
  }

  const paymentIntentId = await getPaymentIntentId(
    stripe,
    session,
    subscriptionId
  );

  const users = getDB().collection("user");
  const { payments } = getCollections();

  const databaseUser = await users.findOne({
    _id: new ObjectId(metadata.userId),
    role,
  });

  if (!databaseUser) {
    throw new Error("Matching user account was not found.");
  }

  // Create the unique index once. It prevents duplicate records
  // when both webhook and checkout verification process a session.
  await payments.createIndex(
    { stripeSessionId: 1 },
    {
      unique: true,
      name: "unique_stripe_session_id",
    }
  );

  const now = new Date();
  const planName =
    role === "student" ? "Student PRO" : "Tutor PRO";

  const paymentRecord = {
    userId: metadata.userId,
    userEmail: metadata.userEmail || databaseUser.email || "",
    userName: metadata.userName || databaseUser.name || "",
    userRole: role,
    role,
    plan: expectedPlan,
    planName,
    amount: (session.amount_total ?? 0) / 100,
    currency: (session.currency || "usd").toLowerCase(),
    transactionId: paymentIntentId || session.id,
    stripeSessionId: session.id,
    stripeSubscriptionId: subscriptionId,
    stripePaymentIntentId: paymentIntentId,
    subscriptionId,
    paymentIntentId,
    paymentStatus: "paid",
    status: "paid",
    method: "stripe",
    paidAt: new Date(session.created * 1000),
    createdAt: new Date(session.created * 1000),
    updatedAt: now,
  };

  try {
    await payments.updateOne(
      { stripeSessionId: session.id },
      { $setOnInsert: paymentRecord },
      { upsert: true }
    );
  } catch (error) {
    // Another webhook/verification request may have inserted it.
    if (
      !(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === 11000
      )
    ) {
      throw error;
    }
  }

  // Activate PRO only after Stripe confirms the payment.
  // Do not overwrite a different subscription belonging to this user.
  const activationResult = await users.updateOne(
    {
      _id: new ObjectId(metadata.userId),
      role,
      $or: [
        { stripeSubscriptionId: { $exists: false } },
        { stripeSubscriptionId: null },
        { stripeSubscriptionId: subscriptionId },
      ],
    },
    {
      $set: {
        plan: "pro",
        proPlan: expectedPlan,
        stripeSubscriptionId: subscriptionId,
        subscriptionStatus: subscription.status,
        proActivatedAt: now,
        updatedAt: now,
      },
    }
  );

  if (activationResult.matchedCount === 0) {
    throw new Error(
      "PRO activation was skipped because another subscription is already linked to this account."
    );
  }
};

/**
 * Create a Student or Tutor monthly PRO checkout.
 */
export const createCheckoutSession = (
  requiredRole: ProRole
): RequestHandler => {
  return async (_req, res, next) => {
    try {
      const user = getUser(res);

      if (user.role !== requiredRole) {
        res.status(403).json({
          success: false,
          message: `Only ${requiredRole}s can purchase this plan.`,
        });
        return;
      }

      if (!ObjectId.isValid(user.id)) {
        res.status(400).json({
          success: false,
          message: "Invalid user account.",
        });
        return;
      }

      const users = getDB().collection("user");

      const databaseUser = await users.findOne({
        _id: new ObjectId(user.id),
        role: requiredRole,
      });

      if (!databaseUser) {
        res.status(404).json({
          success: false,
          message: "User account not found.",
        });
        return;
      }

      if (databaseUser.plan === "pro") {
        res.status(409).json({
          success: false,
          message: "Your PRO plan is already active.",
        });
        return;
      }

      const isTutor = requiredRole === "tutor";
      const plan: ProPlan = isTutor
        ? "pro_tutor"
        : "pro_student";
      const amount = isTutor ? 1500 : 1000;

      const stripe = getStripe();

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer_email: user.email || databaseUser.email,
        client_reference_id: user.id,
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: isTutor
                  ? "MentorLagbe Tutor PRO"
                  : "MentorLagbe Student PRO",
                description: isTutor
                  ? "Unlimited tuition posts - monthly subscription"
                  : "Unlimited tuition bookmarks - monthly subscription",
              },
              unit_amount: amount,
              recurring: {
                interval: "month",
              },
            },
            quantity: 1,
          },
        ],
        subscription_data: {
          metadata: {
            userId: user.id,
            role: requiredRole,
            plan,
          },
        },
        metadata: {
          userId: user.id,
          role: requiredRole,
          plan,
          userName: user.name || databaseUser.name || "",
          userEmail: user.email || databaseUser.email || "",
        },
        success_url:
          `${getClientURL()}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${getClientURL()}/payment/cancel`,
      });

      if (!session.url) {
        throw new Error("Stripe did not return a Checkout URL.");
      }

      res.status(200).json({
        success: true,
        url: session.url,
      });
    } catch (error) {
      next(error);
    }
  };
};

/**
 * Verify the Checkout Session after Stripe redirects the user.
 */
export const verifyCheckoutSession: RequestHandler = async (
  req,
  res,
  next
) => {
  try {
    const user = getUser(res);
    const { sessionId } = req.body as {
      sessionId?: string;
    };

    if (!sessionId) {
      res.status(400).json({
        success: false,
        message: "Stripe session ID is required.",
      });
      return;
    }

    const stripe = getStripe();
    const session =
      await stripe.checkout.sessions.retrieve(sessionId);

    if (
      session.metadata?.userId !== user.id ||
      session.client_reference_id !== user.id
    ) {
      res.status(403).json({
        success: false,
        message: "This payment does not belong to your account.",
      });
      return;
    }

    if (
      user.role !== "student" &&
      user.role !== "tutor"
    ) {
      res.status(403).json({
        success: false,
        message: "Only students and tutors can activate PRO.",
      });
      return;
    }

    if (session.metadata?.role !== user.role) {
      res.status(403).json({
        success: false,
        message: "Payment role does not match your account.",
      });
      return;
    }

    await processSuccessfulCheckout(session);

    res.status(200).json({
      success: true,
      message: "Payment successful! Your PRO plan is now active.",
      plan: "pro",
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Stripe Webhook.
 * Raw request body is configured in server.ts.
 */
export const stripeWebhook: RequestHandler = async (
  req,
  res
) => {
  const signature = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    res.status(500).send("Stripe webhook secret is missing.");
    return;
  }

  if (typeof signature !== "string") {
    res.status(400).send("Missing Stripe signature.");
    return;
  }

  if (!Buffer.isBuffer(req.body)) {
    res.status(400).send("Invalid webhook request body.");
    return;
  }

  const stripe = getStripe();
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      webhookSecret
    );
  } catch (error) {
    console.error("Stripe webhook signature error:", error);
    res.status(400).send("Invalid Stripe webhook signature.");
    return;
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const session =
          event.data.object as Stripe.Checkout.Session;

        if (session.payment_status === "paid") {
          await processSuccessfulCheckout(session);
        }

        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription =
          event.data.object as Stripe.Subscription;

        const userId = subscription.metadata.userId;

        if (!userId || !ObjectId.isValid(userId)) {
          break;
        }

        const users = getDB().collection("user");

        const update: Record<string, unknown> = {
          subscriptionStatus: subscription.status,
          updatedAt: new Date(),
        };

        if (
          subscription.status === "canceled" ||
          subscription.status === "incomplete_expired"
        ) {
          update.plan = "free";
        }

        await users.updateOne(
          {
            _id: new ObjectId(userId),
            stripeSubscriptionId: subscription.id,
          },
          {
            $set: update,
            ...(update.plan === "free"
              ? {
                  $unset: {
                    proPlan: "",
                    proActivatedAt: "",
                  },
                }
              : {}),
          }
        );

        break;
      }

      default:
        break;
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error("Stripe webhook processing failed:", error);

    res.status(500).json({
      success: false,
      message: "Webhook processing failed.",
    });
  }
};

/**
 * Get payment history for the logged-in user.
 */
export const getMyPayments: RequestHandler = async (
  _req,
  res,
  next
) => {
  try {
    const user = getUser(res);
    const { payments } = getCollections();

    const records = await payments
      .find({ userId: user.id })
      .sort({ paidAt: -1, createdAt: -1 })
      .toArray();

    res.status(200).json({
      success: true,
      payments: records,
    });
  } catch (error) {
    next(error);
  }
};
