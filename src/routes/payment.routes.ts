
import { Router, type RequestHandler } from "express";
import { ObjectId } from "mongodb";
import Stripe from "stripe";

import { getDB } from "../config/db.js";

import { getCollections } from "../config/collections.js";
import { getStripe } from "../config/stripe.js";
import { verifyToken } from "../middlewares/auth.middleware.js";

const router = Router();

interface AuthUser {
  id: string;
  name?: string;
  email?: string;
  role: "student" | "tutor" | "admin";
  plan?: string;
}

type ProPlan = "pro_student" | "pro_tutor";

// --------------------------------------------------
// Helpers
// --------------------------------------------------

const getSubscriptionId = (
  session: Stripe.Checkout.Session
): string | null => {
  return typeof session.subscription === "string"
    ? session.subscription
    : session.subscription?.id ?? null;
};

const getPaymentIntentId = (
  session: Stripe.Checkout.Session
): string | null => {
  return typeof session.payment_intent === "string"
    ? session.payment_intent
    : session.payment_intent?.id ?? null;
};

// --------------------------------------------------
// Update user subscription
// --------------------------------------------------

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

  const { users } = getCollections();

const result = await users.updateOne(
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
      `Subscription update skipped: user=${userId}, subscription=${subscriptionId}`
    );
  }
};

// --------------------------------------------------
// Save payment record once
// --------------------------------------------------

const savePaymentRecord = async (
  session: Stripe.Checkout.Session
): Promise<void> => {
  const metadata = session.metadata;

  if (
    !metadata?.userId ||
    !metadata?.role ||
    !metadata?.plan
  ) {
    throw new Error("Payment metadata is incomplete.");
  }

  if (
    session.mode !== "subscription" ||
    session.status !== "complete" ||
    session.payment_status !== "paid"
  ) {
    throw new Error("Checkout session is not a completed paid subscription.");
  }

  const { payments } = getCollections();

  await payments.createIndex(
    { stripeSessionId: 1 },
    {
      unique: true,
      name: "unique_stripe_session_id",
    }
  );

  const subscriptionId = getSubscriptionId(session);
  const paymentIntentId = getPaymentIntentId(session);

  const paymentRecord = {
    userId: metadata.userId,
    userEmail: metadata.userEmail || session.customer_details?.email || "",
    userName: metadata.userName || session.customer_details?.name || "",
    userRole: metadata.role,
    role: metadata.role,
    plan: metadata.plan,
    planName:
      metadata.plan === "pro_tutor"
        ? "Tutor PRO"
        : "Student PRO",
    amount: (session.amount_total ?? 0) / 100,
    currency: session.currency?.toUpperCase() ?? "USD",
    transactionId: paymentIntentId || session.id,
    stripeSessionId: session.id,
    stripeSubscriptionId: subscriptionId,
    stripePaymentIntentId: paymentIntentId,
    subscriptionId,
    paymentIntentId,
    paymentStatus: "paid",
    status: "paid",
    method: "stripe",
    paidAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
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

// --------------------------------------------------
// Validate checkout plan
// --------------------------------------------------

const validateCheckoutPlan: RequestHandler = (
  req,
  res,
  next
) => {
  const user = res.locals.user as AuthUser | undefined;
  const requestedPlan = req.body?.plan;

  if (!user) {
    res.status(401).json({
      success: false,
      message: "Authentication required.",
    });
    return;
  }

  const expectedPlan =
    user.role === "student"
      ? "student-pro"
      : user.role === "tutor"
        ? "tutor-pro"
        : null;

  if (!expectedPlan) {
    res.status(403).json({
      success: false,
      message: "Only students and tutors can purchase Pro.",
    });
    return;
  }

  if (requestedPlan !== expectedPlan) {
    res.status(400).json({
      success: false,
      message: "Selected plan does not match your account role.",
    });
    return;
  }

  next();
};

// --------------------------------------------------
// Create monthly Stripe subscription checkout
// --------------------------------------------------

const createCheckoutSession: RequestHandler = async (
  req,
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

    if (!ObjectId.isValid(user.id)) {
      res.status(400).json({
        success: false,
        message: "Invalid user account.",
      });
      return;
    }

    const dbUser = await getDB()
  .collection("user")
  .findOne({ _id: new ObjectId(user.id) });

    if (!dbUser) {
      res.status(404).json({
        success: false,
        message: "User account not found.",
      });
      return;
    }

    if (dbUser.plan === "pro") {
      res.status(400).json({
        success: false,
        message: "You already have an active Pro plan.",
      });
      return;
    }

    const isTutor = user.role === "tutor";

    const plan: ProPlan = isTutor
      ? "pro_tutor"
      : "pro_student";

    const amount = isTutor ? 1500 : 1000;

    const stripe = getStripe();

    const clientURL = (
      process.env.CLIENT_URL || ""
    ).split(",")[0].trim().replace(/\/$/, "");

    if (!clientURL) {
      throw new Error("CLIENT_URL is missing.");
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",

      customer_email: user.email || dbUser.email,

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
          userName: user.name || dbUser.name || "",
          userEmail: user.email || dbUser.email || "",
        },
      },

      metadata: {
        userId: user.id,
        role: user.role,
        plan,
        userName: user.name || dbUser.name || "",
        userEmail: user.email || dbUser.email || "",
      },

      success_url: `${clientURL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,

      cancel_url: `${clientURL}/payment/cancel`,
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

// --------------------------------------------------
// Verify checkout session
// --------------------------------------------------

const verifyCheckoutSession: RequestHandler = async (
  req,
  res,
  next
) => {
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

    const session = await stripe.checkout.sessions.retrieve(
      sessionId
    );

    if (
      session.status !== "complete" ||
      session.mode !== "subscription" ||
      session.payment_status !== "paid"
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

    if (
      user.role !== "student" &&
      user.role !== "tutor"
    ) {
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
      user.role === "tutor"
        ? "pro_tutor"
        : "pro_student";

    if (session.metadata?.plan !== expectedPlan) {
      res.status(400).json({
        success: false,
        message: "Invalid subscription plan.",
      });
      return;
    }

    const subscriptionId = getSubscriptionId(session);

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

    if (
      subscription.metadata.userId !== user.id ||
      subscription.metadata.role !== user.role ||
      subscription.metadata.plan !== expectedPlan
    ) {
      res.status(403).json({
        success: false,
        message: "Subscription details do not match your account.",
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
};

// --------------------------------------------------
// Stripe webhook
// --------------------------------------------------

const stripeWebhook: RequestHandler = async (
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

        if (
          session.payment_status === "paid" &&
          session.status === "complete"
        ) {
          const subscriptionId = getSubscriptionId(session);

          if (!subscriptionId) {
            throw new Error("Subscription ID not found.");
          }

          const subscription =
            await stripe.subscriptions.retrieve(subscriptionId);

          const userId = session.metadata?.userId;

          if (
            userId &&
            subscription.metadata.userId === userId &&
            (subscription.status === "active" ||
              subscription.status === "trialing")
          ) {
            await updateUserSubscription(
              userId,
              subscription.id,
              subscription.status,
              true
            );

            await savePaymentRecord(session);
          }
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

    res.status(200).json({
      received: true,
    });
  } catch (error) {
    console.error("Stripe webhook processing failed:", error);

    res.status(500).json({
      success: false,
      message: "Webhook processing failed.",
    });
  }
};

// --------------------------------------------------
// Get logged-in user's payment history
// --------------------------------------------------

const getMyPayments: RequestHandler = async (
  _req,
  res,
  next
) => {
  try {
    const user = res.locals.user as AuthUser;

    const { payments } = getCollections();

    const records = await payments
      .find({ userId: user.id })
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json({
      success: true,
      payments: records,
    });
  } catch (error) {
    next(error);
  }
};

// --------------------------------------------------
// Routes
// --------------------------------------------------

// Common PRO checkout endpoint for Student and Tutor
router.post(
  "/create-checkout-session",
  verifyToken,
  validateCheckoutPlan,
  createCheckoutSession
);

// Verify payment
router.post(
  "/verify-session",
  verifyToken,
  verifyCheckoutSession
);

// Logged-in user's payment history
router.get(
  "/my-payments",
  verifyToken,
  getMyPayments
);

// Stripe webhook
router.post(
  "/webhook",
  stripeWebhook
);

export default router;
