
import { Router } from "express";
import type { RequestHandler } from "express";
import { ObjectId } from "mongodb";
import Stripe from "stripe";

import { getDB } from "../config/db.js";
import { getCollections } from "../config/collections.js";
import { getStripe } from "../config/stripe.js";
import {
  verifyToken,
  verifyStudent,
  verifyTutor,
} from "../middlewares/auth.middleware.js";

const router = Router();

interface AuthUser {
  id: string;
  name?: string;
  email?: string;
  role: "student" | "tutor" | "admin";
}

// Update user's subscription information
const updateUserSubscription = async (
  userId: string,
  subscriptionId: string,
  status: Stripe.Subscription.Status,
  allowReplace = false
): Promise<void> => {
  if (!ObjectId.isValid(userId)) {
    throw new Error("Invalid user ID.");
  }

  const active = status === "active" || status === "trialing";

  const filter = allowReplace
    ? { _id: new ObjectId(userId) }
    : {
        _id: new ObjectId(userId),
        stripeSubscriptionId: subscriptionId,
      };

  const result = await getDB().collection("user").updateOne(
    filter,
    {
      $set: {
        plan: active ? "pro" : "free",
        stripeSubscriptionId: subscriptionId,
        subscriptionStatus: status,
        updatedAt: new Date(),
      },
    }
  );

  if (result.matchedCount === 0) {
    console.log(
      `Subscription update skipped. Subscription ${subscriptionId} is not the current subscription for user ${userId}.`
    );
    return;
  }

  console.log(
    `Subscription updated: user=${userId}, status=${status}`
  );
};

// Save payment record only once
const savePaymentRecord = async (
  session: Stripe.Checkout.Session
): Promise<void> => {
  const metadata = session.metadata;

  if (!metadata?.userId || !metadata?.role || !metadata?.plan) {
    return;
  }

  const { payments } = getCollections();

  await payments.createIndex(
    { stripeSessionId: 1 },
    { unique: true, name: "unique_stripe_session_id" }
  );

  const paymentRecord = {
    userId: metadata.userId,
    role: metadata.role,
    plan: metadata.plan,
    amount: (session.amount_total ?? 0) / 100,
    currency: session.currency,
    stripeSessionId: session.id,
    subscriptionId:
      typeof session.subscription === "string"
        ? session.subscription
        : session.subscription?.id ?? null,
    paymentIntentId:
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : null,
    status: "paid",
    createdAt: new Date(),
  };

  try {
    await payments.updateOne(
      { stripeSessionId: session.id },
      {
        $setOnInsert: paymentRecord,
      },
      { upsert: true }
    );
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === 11000
    ) {
      return;
    }

    throw error;
  }
};

// Create monthly Stripe subscription
const createCheckoutSession: RequestHandler = async (
  _req,
  res,
  next
) => {
  try {
    const user = res.locals.user as AuthUser;

    if (user.role !== "student" && user.role !== "tutor") {
      res.status(403).json({
        success: false,
        message: "Only students and tutors can purchase Pro.",
      });
      return;
    }

    const isTutor = user.role === "tutor";
    const plan = isTutor ? "pro_tutor" : "pro_student";
    const amount = isTutor ? 1500 : 1000;

    const stripe = getStripe();

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: user.email,
      client_reference_id: user.id,

      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: isTutor
                ? "MentorLagbe Pro Tutor"
                : "MentorLagbe Pro Student",
              description: "MentorLagbe monthly Pro subscription",
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
          role: user.role,
          plan,
        },
      },

      metadata: {
        userId: user.id,
        role: user.role,
        plan,
      },

      success_url: `${process.env.CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/payment/cancel`,
    });

    res.status(200).json({
      success: true,
      message: "Subscription checkout created successfully.",
      url: session.url,
    });
  } catch (error) {
    next(error);
  }
};

// Student Pro: $10/month
router.post(
  "/create-student-checkout",
  verifyToken,
  verifyStudent,
  createCheckoutSession
);

// Tutor Pro: $15/month
router.post(
  "/create-tutor-checkout",
  verifyToken,
  verifyTutor,
  createCheckoutSession
);

// Verify checkout session
router.post("/verify-session", verifyToken, async (req, res, next) => {
  try {
    const user = res.locals.user as AuthUser;

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
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (
      session.status !== "complete" ||
      session.mode !== "subscription" ||
      !["paid", "no_payment_required"].includes(session.payment_status)
    ) {
      res.status(400).json({
        success: false,
        message: "Subscription checkout is not completed.",
      });
      return;
    }

    if (
      session.metadata?.userId !== user.id ||
      session.client_reference_id !== user.id
    ) {
      res.status(403).json({
        success: false,
        message: "This subscription does not belong to your account.",
      });
      return;
    }

    if (user.role !== "student" && user.role !== "tutor") {
      res.status(403).json({
        success: false,
        message: "Invalid account role.",
      });
      return;
    }

    if (session.metadata?.role !== user.role) {
      res.status(403).json({
        success: false,
        message: "Subscription role does not match your account.",
      });
      return;
    }

    const expectedPlan =
      user.role === "tutor" ? "pro_tutor" : "pro_student";

    if (session.metadata?.plan !== expectedPlan) {
      res.status(400).json({
        success: false,
        message: "Invalid subscription plan.",
      });
      return;
    }

    const subscriptionId =
      typeof session.subscription === "string"
        ? session.subscription
        : session.subscription?.id;

    if (!subscriptionId) {
      res.status(400).json({
        success: false,
        message: "Subscription information not found.",
      });
      return;
    }

    const subscription =
      await stripe.subscriptions.retrieve(subscriptionId);

    if (
      subscription.status !== "active" &&
      subscription.status !== "trialing"
    ) {
      res.status(400).json({
        success: false,
        message: "Your subscription is not active.",
      });
      return;
    }

    await updateUserSubscription(
      user.id,
      subscription.id,
      subscription.status,
      true
    );

    await savePaymentRecord(session);

    res.status(200).json({
      success: true,
      message: "Your MentorLagbe Pro subscription is active!",
      plan: "pro",
      subscriptionStatus: subscription.status,
    });
  } catch (error) {
    next(error);
  }
});

// Stripe webhook
const stripeWebhook: RequestHandler = async (req, res) => {
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
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;

        const subscriptionId =
          typeof session.subscription === "string"
            ? session.subscription
            : session.subscription?.id;

        if (subscriptionId) {
          const subscription =
            await stripe.subscriptions.retrieve(subscriptionId);

          const userId = subscription.metadata.userId;

          if (userId) {
            const isActive =
              subscription.status === "active" ||
              subscription.status === "trialing";

            await updateUserSubscription(
              userId,
              subscription.id,
              subscription.status,
              isActive
            );
          }
        }

        if (
          session.payment_status === "paid" ||
          session.payment_status === "no_payment_required"
        ) {
          await savePaymentRecord(session);
        }

        break;
      }

      case "customer.subscription.updated": {
        const subscription =
          event.data.object as Stripe.Subscription;

        const userId = subscription.metadata.userId;

        if (userId) {
          await updateUserSubscription(
            userId,
            subscription.id,
            subscription.status
          );
        }

        break;
      }

      case "customer.subscription.deleted": {
        const subscription =
          event.data.object as Stripe.Subscription;

        const userId = subscription.metadata.userId;

        if (userId) {
          await updateUserSubscription(
            userId,
            subscription.id,
            "canceled"
          );
        }

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

router.post("/webhook", stripeWebhook);

export default router;
