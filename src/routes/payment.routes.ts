
import { Router, type RequestHandler } from "express";
import { ObjectId } from "mongodb";
import Stripe from "stripe";

import { getDB } from "../config/db.js";
import { getCollections } from "../config/collections.js";
import { getStripe } from "../config/stripe.js";
import {
  verifyToken,
  verifyAdmin,
} from "../middlewares/auth.middleware.js";

const router = Router();

interface AuthUser {
  id: string;
  name?: string;
  email?: string;
  role: "student" | "tutor" | "admin";
  plan?: string;
}

type ProPlan = "pro_student" | "pro_tutor";

interface InvoicePaymentEntry {
  payment?: {
    type?: string;
    payment_intent?: string | Stripe.PaymentIntent | null;
  };
}

interface InvoiceWithPayments {
  payments?: {
    data?: InvoicePaymentEntry[];
  };
}

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

const getSubscriptionId = (
  session: Stripe.Checkout.Session
): string | null => {
  return typeof session.subscription === "string"
    ? session.subscription
    : session.subscription?.id ?? null;
};

const getSessionInvoiceId = (
  session: Stripe.Checkout.Session
): string | null => {
  return typeof session.invoice === "string"
    ? session.invoice
    : session.invoice?.id ?? null;
};

const getPaymentIntentFromInvoice = async (
  stripe: Stripe,
  invoiceId: string
): Promise<string | null> => {
  const invoice = await stripe.invoices.retrieve(invoiceId, {
    expand: ["payments.data.payment.payment_intent"],
  });

  const invoiceWithPayments =
    invoice as unknown as InvoiceWithPayments;

  for (const entry of invoiceWithPayments.payments?.data ?? []) {
    const intent = entry.payment?.payment_intent;

    if (entry.payment?.type !== "payment_intent") {
      continue;
    }

    if (typeof intent === "string") {
      return intent;
    }

    if (intent && typeof intent === "object" && intent.id) {
      return intent.id;
    }
  }

  return null;
};

const getInitialPaymentIntentId = async (
  stripe: Stripe,
  session: Stripe.Checkout.Session
): Promise<string | null> => {
  const directIntent =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id ?? null;

  if (directIntent) {
    return directIntent;
  }

  const invoiceId = getSessionInvoiceId(session);

  if (invoiceId) {
    const intentId = await getPaymentIntentFromInvoice(
      stripe,
      invoiceId
    );

    if (intentId) return intentId;
  }

  const subscriptionId = getSubscriptionId(session);

  if (!subscriptionId) return null;

  const subscription = await stripe.subscriptions.retrieve(
    subscriptionId,
    { expand: ["latest_invoice"] }
  );

  const latestInvoice = subscription.latest_invoice;

  const latestInvoiceId =
    typeof latestInvoice === "string"
      ? latestInvoice
      : latestInvoice?.id ?? null;

  if (!latestInvoiceId) return null;

  return getPaymentIntentFromInvoice(stripe, latestInvoiceId);
};

// Update both Better Auth's "user" collection and the
// application's "users" collection.
const updateUserSubscription = async (
  userId: string,
  subscriptionId: string,
  status: Stripe.Subscription.Status,
  allowReplace = false
): Promise<void> => {
  if (!ObjectId.isValid(userId)) {
    throw new Error("Invalid user ID.");
  }

  const active =
    status === "active" || status === "trialing";

  const userIdObject = new ObjectId(userId);

  const filter = allowReplace
    ? { _id: userIdObject }
    : {
        _id: userIdObject,
        stripeSubscriptionId: subscriptionId,
      };

  const update = {
    $set: {
      plan: active ? "pro" : "free",
      stripeSubscriptionId: subscriptionId,
      subscriptionStatus: status,
      updatedAt: new Date(),
    },
  };

  const db = getDB();
  const { users } = getCollections();

  const results = await Promise.all([
    db.collection("user").updateOne(filter, update),
    users.updateOne(filter, update),
  ]);

  if (
    results[0].matchedCount === 0 &&
    results[1].matchedCount === 0
  ) {
    console.warn(
      `Subscription update skipped: user=${userId}, subscription=${subscriptionId}`
    );
  }
};

// --------------------------------------------------
// SAVE PAYMENT RECORD
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
    throw new Error(
      "Checkout session is not a completed paid subscription."
    );
  }

  const subscriptionId = getSubscriptionId(session);

  if (!subscriptionId) {
    throw new Error("Subscription ID not found.");
  }

  const stripe = getStripe();

  let paymentIntentId: string | null = null;

  try {
    paymentIntentId = await getInitialPaymentIntentId(
      stripe,
      session
    );
  } catch (error) {
    console.error(
      "Could not retrieve initial PaymentIntent:",
      error
    );
  }

  const { payments } = getCollections();
  const now = new Date();

  const paymentRecord = {
    userId: metadata.userId,
    userEmail:
      metadata.userEmail ||
      session.customer_details?.email ||
      "",
    userName:
      metadata.userName ||
      session.customer_details?.name ||
      "",
    email:
      metadata.userEmail ||
      session.customer_details?.email ||
      "",
    name:
      metadata.userName ||
      session.customer_details?.name ||
      "",
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
    refundStatus: "not_refunded",
    cancellationStatus: "not_cancelled",
    paidAt: session.created
      ? new Date(session.created * 1000)
      : now,
    updatedAt: now,
  };

  try {
    await payments.updateOne(
      { stripeSessionId: session.id },
      {
        $set: paymentRecord,
        $setOnInsert: {
          createdAt: now,
        },
      },
      { upsert: true }
    );
  } catch (error) {
    // If webhook and verification run simultaneously,
    // the unique index may reject the second insert.
    const mongoError = error as { code?: number };

    if (mongoError.code !== 11000) {
      throw error;
    }

    await payments.updateOne(
      { stripeSessionId: session.id },
      {
        $set: paymentRecord,
      }
    );
  }

  if (!paymentIntentId) {
    console.warn(
      `Payment saved without PaymentIntent: session=${session.id}`
    );
  }
};


// --------------------------------------------------
// VALIDATE CHECKOUT PLAN
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
// CREATE CHECKOUT SESSION
// --------------------------------------------------

const createCheckoutSession: RequestHandler = async (
  req,
  res,
  next
) => {
  try {
    const user = res.locals.user as AuthUser;

    if (
      user.role !== "student" &&
      user.role !== "tutor"
    ) {
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

    if (
      dbUser.plan === "pro" &&
      ["active", "trialing"].includes(
        String(dbUser.subscriptionStatus || "")
      )
    ) {
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

    // Amounts are in cents: $15 and $10.
    const amount = isTutor ? 1500 : 1000;

    const clientURL = (
      process.env.CLIENT_URL || ""
    )
      .split(",")[0]
      .trim()
      .replace(/\/$/, "");

    if (!clientURL) {
      throw new Error("CLIENT_URL is missing.");
    }

    const stripe = getStripe();

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
              description:
                "MentorLagbe monthly Pro subscription",
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

      success_url:
        `${clientURL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,

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
// VERIFY CHECKOUT SESSION
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

    const session =
      await stripe.checkout.sessions.retrieve(sessionId);

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
        message:
          "This subscription does not belong to your account.",
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
        message:
          "Subscription role does not match your account.",
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
        message:
          "Subscription details do not match your account.",
      });
      return;
    }

    await savePaymentRecord(session);

    await updateUserSubscription(
      user.id,
      subscription.id,
      subscription.status,
      true
    );

    res.status(200).json({
      success: true,
      message:
        "Your MentorLagbe Pro subscription is active!",
      plan: "pro",
      subscriptionStatus: subscription.status,
    });
  } catch (error) {
    next(error);
  }
};

// --------------------------------------------------
// STRIPE WEBHOOK
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
            await savePaymentRecord(session);

            await updateUserSubscription(
              userId,
              subscription.id,
              subscription.status,
              true
            );
          }
        }

        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
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

// --------------------------------------------------
// USER: GET MY PAYMENTS
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
      total: records.length,
      payments: records,
    });
  } catch (error) {
    next(error);
  }
};

// --------------------------------------------------
// ADMIN: GET ALL PRO PAYMENTS
// --------------------------------------------------

const getAllPayments: RequestHandler = async (
  _req,
  res,
  next
) => {
  try {
    const { payments } = getCollections();

    const records = await payments
      .find({
        method: "stripe",
        $or: [
          { plan: "pro_student" },
          { plan: "pro_tutor" },
          { plan: "student-pro" },
          { plan: "tutor-pro" },
        ],
      })
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json({
      success: true,
      total: records.length,
      payments: records,
    });
  } catch (error) {
    next(error);
  }
};

// --------------------------------------------------
// ADMIN: CANCEL SUBSCRIPTION + REFUND PAYMENT
// --------------------------------------------------

const rejectPayment: RequestHandler = async (
  req,
  res,
  next
) => {
  try {
    const paymentId = req.params.paymentId;

    if (
      typeof paymentId !== "string" ||
      !ObjectId.isValid(paymentId)
    ) {
      res.status(400).json({
        success: false,
        message: "Invalid payment ID.",
      });
      return;
    }

    const { payments } = getCollections();

    const payment = await payments.findOne({
      _id: new ObjectId(paymentId),
    });

    if (!payment) {
      res.status(404).json({
        success: false,
        message: "Payment record not found.",
      });
      return;
    }

    if (
      payment.refundStatus === "succeeded" ||
      payment.paymentStatus === "refunded"
    ) {
      res.status(200).json({
        success: true,
        message: "This payment has already been refunded.",
        payment,
      });
      return;
    }

    if (
      payment.paymentStatus !== "paid" &&
      payment.status !== "paid" &&
      payment.status !== "refund_pending"
    ) {
      res.status(400).json({
        success: false,
        message:
          "Only successful payments can be rejected and refunded.",
      });
      return;
    }

    const subscriptionId =
      payment.stripeSubscriptionId ||
      payment.subscriptionId;

    if (!subscriptionId) {
      res.status(400).json({
        success: false,
        message: "Stripe subscription ID is missing.",
      });
      return;
    }

    const stripe = getStripe();

    // Retrieve subscription before attempting cancellation.
    const subscription =
      await stripe.subscriptions.retrieve(subscriptionId);

    // Cancel the subscription if it is still active.
    if (subscription.status !== "canceled") {
      await stripe.subscriptions.cancel(subscriptionId);
    }

    // Save cancellation immediately. If refund fails,
    // the database still records that the subscription was canceled.
    await payments.updateOne(
      { _id: new ObjectId(paymentId) },
      {
        $set: {
          cancellationStatus: "canceled",
          subscriptionStatus: "canceled",
          rejectedAt: payment.rejectedAt || new Date(),
          updatedAt: new Date(),
        },
      }
    );

    await updateUserSubscription(
      payment.userId,
      subscriptionId,
      "canceled"
    );

    // Find the initial PaymentIntent.
    let paymentIntentId =
      payment.stripePaymentIntentId ||
      payment.paymentIntentId ||
      null;

    if (!paymentIntentId && payment.stripeSessionId) {
      const session =
        await stripe.checkout.sessions.retrieve(
          payment.stripeSessionId
        );

      paymentIntentId = await getInitialPaymentIntentId(
        stripe,
        session
      );
    }

    if (!paymentIntentId) {
      const latestSubscription =
        await stripe.subscriptions.retrieve(
          subscriptionId,
          { expand: ["latest_invoice"] }
        );

      const invoice = latestSubscription.latest_invoice;

      const invoiceId =
        typeof invoice === "string"
          ? invoice
          : invoice?.id ?? null;

      if (invoiceId) {
        paymentIntentId = await getPaymentIntentFromInvoice(
          stripe,
          invoiceId
        );
      }
    }

    if (!paymentIntentId) {
      await payments.updateOne(
        { _id: new ObjectId(paymentId) },
        {
          $set: {
            refundStatus: "failed",
            refundFailureReason:
              "Initial Stripe PaymentIntent could not be found. Subscription was canceled.",
            status: "paid",
            updatedAt: new Date(),
          },
        }
      );

      res.status(409).json({
        success: false,
        message:
          "Subscription canceled, but the initial payment could not be found for refund. The payment record has been marked for review.",
      });
      return;
    }

    // Reuse the same idempotency key for an unfinished attempt.
    // A new key is created only after a previous refund failed.
    const previousAttempt = Number(
      payment.refundAttempts || 0
    );

    const attempt =
      payment.refundStatus === "failed"
        ? previousAttempt + 1
        : Math.max(previousAttempt, 1);

    const idempotencyKey =
      payment.refundStatus === "pending" &&
      payment.refundAttemptKey
        ? payment.refundAttemptKey
        : `mentorlagbe-refund-${paymentId}-${attempt}`;

    await payments.updateOne(
      { _id: new ObjectId(paymentId) },
      {
        $set: {
          refundStatus: "pending",
          refundAttemptKey: idempotencyKey,
          refundAttempts: attempt,
          stripePaymentIntentId: paymentIntentId,
          paymentIntentId,
          updatedAt: new Date(),
        },
      }
    );

    let refund: Stripe.Refund;

    try {
      refund = await stripe.refunds.create(
        {
          payment_intent: paymentIntentId,
        },
        {
          idempotencyKey,
        }
      );
    } catch (refundError) {
      const reason =
        refundError instanceof Error
          ? refundError.message
          : "Stripe refund request failed.";

      await payments.updateOne(
        { _id: new ObjectId(paymentId) },
        {
          $set: {
            refundStatus: "failed",
            refundFailureReason: reason,
            cancellationStatus: "canceled",
            status: "paid",
            updatedAt: new Date(),
          },
        }
      );

      res.status(502).json({
        success: false,
        message:
          "Subscription canceled, but Stripe could not complete the refund. You can retry the refund from Admin Payments.",
        refundStatus: "failed",
      });
      return;
    }

    const refundStatus = refund.status || "pending";
    const refundSucceeded = refundStatus === "succeeded";

    await payments.updateOne(
      { _id: new ObjectId(paymentId) },
      {
        $set: {
          paymentStatus: refundSucceeded ? "refunded" : "paid",
          status: refundSucceeded
            ? "refunded"
            : "refund_pending",
          refundStatus,
          stripeRefundId: refund.id,
          refundId: refund.id,
          refundedAmount: refund.amount / 100,
          refundCurrency: refund.currency.toUpperCase(),
          refundFailureReason:
            refundStatus === "failed"
              ? "Stripe reported that the refund failed."
              : null,
          refundedAt: refundSucceeded ? new Date() : null,
          cancellationStatus: "canceled",
          subscriptionStatus: "canceled",
          updatedAt: new Date(),
        },
      }
    );

    res.status(200).json({
      success: true,
      message: refundSucceeded
        ? "Subscription canceled and initial payment refunded successfully."
        : "Subscription canceled. Stripe is processing the refund.",
      refund: {
        id: refund.id,
        status: refund.status,
        amount: refund.amount / 100,
        currency: refund.currency,
      },
    });
  } catch (error) {
    console.error("Admin payment rejection failed:", error);
    next(error);
  }
};

// --------------------------------------------------
// ROUTES
// --------------------------------------------------

router.post(
  "/create-checkout-session",
  verifyToken,
  validateCheckoutPlan,
  createCheckoutSession
);

router.post(
  "/verify-session",
  verifyToken,
  verifyCheckoutSession
);

router.get(
  "/my-payments",
  verifyToken,
  getMyPayments
);

router.get(
  "/admin/all",
  verifyToken,
  verifyAdmin,
  getAllPayments
);

router.post(
  "/admin/:paymentId/reject",
  verifyToken,
  verifyAdmin,
  rejectPayment
);

router.post("/webhook", stripeWebhook);

export default router;
