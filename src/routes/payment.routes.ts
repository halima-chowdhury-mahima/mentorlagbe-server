
import { Router, type RequestHandler } from "express";
import { ObjectId } from "mongodb";
import Stripe from "stripe";

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

interface InvoicePaymentEntry {
  status?: string;
  payment?: {
    type?: string;
    payment_intent?: string | { id: string } | null;
  } | null;
}

// --------------------------------------------------
// Helpers
// --------------------------------------------------

const getStripeObjectId = (
  value: string | { id: string } | null | undefined
): string | null => {
  if (!value) return null;

  return typeof value === "string" ? value : value.id;
};

const getSubscriptionId = (
  session: Stripe.Checkout.Session
): string | null => {
  return getStripeObjectId(session.subscription);
};

const getErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : "Unknown error.";
};

// --------------------------------------------------
// Get PaymentIntent from a paid invoice
// Stripe SDK v23 invoice payments structure
// --------------------------------------------------

const getPaymentIntentFromInvoice = async (
  invoiceId: string
): Promise<string | null> => {
  const stripe = getStripe();

  const invoice = await stripe.invoices.retrieve(invoiceId, {
    expand: ["payments.data.payment.payment_intent"],
  });

  const invoiceWithPayments = invoice as unknown as {
    payments?: {
      data?: InvoicePaymentEntry[];
    };
  };

  const payments = invoiceWithPayments.payments?.data ?? [];

  const paidPayment = payments.find(
    (item) =>
      item.status === "paid" &&
      item.payment?.type === "payment_intent"
  );

  const paymentIntent = paidPayment?.payment?.payment_intent;

  if (!paymentIntent) {
    return null;
  }

  return typeof paymentIntent === "string"
    ? paymentIntent
    : paymentIntent.id;
};

// --------------------------------------------------
// Get initial PaymentIntent from subscription
// --------------------------------------------------

const getSubscriptionPaymentIntentId = async (
  subscriptionId: string,
  checkoutInvoiceId?: string | null
): Promise<string | null> => {
  let invoiceId = checkoutInvoiceId ?? null;

  if (!invoiceId) {
    const stripe = getStripe();

    const subscription =
      await stripe.subscriptions.retrieve(subscriptionId);

    invoiceId = getStripeObjectId(subscription.latest_invoice);
  }

  if (!invoiceId) {
    return null;
  }

  return getPaymentIntentFromInvoice(invoiceId);
};

// --------------------------------------------------
// Update user subscription
// --------------------------------------------------

const updateUserSubscription = async (
  userId: string,
  subscriptionId: string,
  status: Stripe.Subscription.Status,
  allowReplace = false
): Promise<boolean> => {
  if (!ObjectId.isValid(userId)) {
    throw new Error("Invalid user ID.");
  }

  const active =
    status === "active" || status === "trialing";

  const filter = allowReplace
    ? { _id: new ObjectId(userId) }
    : {
        _id: new ObjectId(userId),
        stripeSubscriptionId: subscriptionId,
      };

  const { users } = getCollections();

  const result = await users.updateOne(filter, {
    $set: {
      plan: active ? "pro" : "free",
      stripeSubscriptionId: subscriptionId,
      subscriptionStatus: status,
      updatedAt: new Date(),
    },
  });

  if (result.matchedCount === 0) {
    console.error(
      `Subscription update failed: user=${userId}, subscription=${subscriptionId}`
    );

    return false;
  }

  console.log(
    `Subscription updated: user=${userId}, plan=${active ? "pro" : "free"}`
  );

  return true;
};

// --------------------------------------------------
// Save payment record once
// Also updates missing PaymentIntent on old records
// --------------------------------------------------

const savePaymentRecord = async (
  session: Stripe.Checkout.Session
): Promise<void> => {
  const metadata = session.metadata;

  if (!metadata?.userId || !metadata?.role || !metadata?.plan) {
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
    throw new Error("Stripe subscription ID is missing.");
  }

  const checkoutInvoiceId = getStripeObjectId(session.invoice);

  const paymentIntentId =
    await getSubscriptionPaymentIntentId(
      subscriptionId,
      checkoutInvoiceId
    );

  if (!paymentIntentId) {
    throw new Error(
      "Could not find the PaymentIntent for the paid subscription invoice."
    );
  }

  const { payments } = getCollections();

  await payments.createIndex(
    { stripeSessionId: 1 },
    {
      unique: true,
      name: "unique_stripe_session_id",
    }
  );

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

    userRole: metadata.role,
    role: metadata.role,

    plan: metadata.plan,

    planName:
      metadata.plan === "pro_tutor"
        ? "Tutor PRO"
        : "Student PRO",

    amount: (session.amount_total ?? 0) / 100,

    currency: session.currency?.toUpperCase() ?? "USD",

    paymentStatus: "paid",
    status: "paid",

    approvalStatus: "pending",
    refundStatus: null,

    method: "stripe",
    subscriptionCanceled: false,

    paidAt: now,
    createdAt: now,
  };

  await payments.updateOne(
    { stripeSessionId: session.id },
    {
      // Always update these fields.
      // This also repairs old records with empty PaymentIntent IDs.
      $set: {
        transactionId: paymentIntentId,
        stripeSubscriptionId: subscriptionId,
        stripePaymentIntentId: paymentIntentId,
        subscriptionId,
        paymentIntentId,
        updatedAt: now,
      },

      // Only create the remaining fields for a new record.
      $setOnInsert: paymentRecord,
    },
    { upsert: true }
  );

  console.log(
    `Payment record saved: session=${session.id}, paymentIntent=${paymentIntentId}`
  );
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

    const { users } = getCollections();

    const dbUser = await users.findOne({
      _id: new ObjectId(user.id),
    });

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

    const clientURL = (process.env.CLIENT_URL || "")
      .split(",")[0]
      .trim()
      .replace(/\/$/, "");

    if (!clientURL) {
      throw new Error("CLIENT_URL is missing.");
    }

    const userName = user.name || dbUser.name || "";
    const userEmail = user.email || dbUser.email || "";

    if (!userEmail) {
      res.status(400).json({
        success: false,
        message: "Your account email is required for checkout.",
      });
      return;
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",

      customer_email: userEmail,

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
          userName,
          userEmail,
        },
      },

      metadata: {
        userId: user.id,
        role: user.role,
        plan,
        userName,
        userEmail,
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

    // Save the verified payment before activating Pro.
    // If the invoice PaymentIntent cannot be found,
    // the account will not be activated accidentally.
    await savePaymentRecord(session);

    const updated = await updateUserSubscription(
      user.id,
      subscription.id,
      subscription.status,
      true
    );

    if (!updated) {
      res.status(500).json({
        success: false,
        message:
          "Payment verified, but your Pro plan could not be activated. Please contact support.",
      });
      return;
    }

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
    console.error(
      "Stripe webhook signature error:",
      error
    );

    res.status(400).send(
      "Invalid Stripe webhook signature."
    );

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
          session.status === "complete" &&
          session.mode === "subscription"
        ) {
          const subscriptionId =
            getSubscriptionId(session);

          if (!subscriptionId) {
            throw new Error("Subscription ID not found.");
          }

          const subscription =
            await stripe.subscriptions.retrieve(subscriptionId);

          const userId = session.metadata?.userId;

          if (
            userId &&
            subscription.metadata.userId === userId &&
            subscription.metadata.role === session.metadata?.role &&
            subscription.metadata.plan === session.metadata?.plan &&
            (
              subscription.status === "active" ||
              subscription.status === "trialing"
            )
          ) {
            // Save payment first.
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
    console.error(
      "Stripe webhook processing failed:",
      error
    );

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
// Admin: Get all payment records
// --------------------------------------------------

const getAllPayments: RequestHandler = async (
  _req,
  res,
  next
) => {
  try {
    const user = res.locals.user as AuthUser;

    if (user.role !== "admin") {
      res.status(403).json({
        success: false,
        message: "Admin access required.",
      });
      return;
    }

    const { payments } = getCollections();

    const records = await payments
      .find({})
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
// Admin: Reject payment, cancel subscription & refund
// --------------------------------------------------

const rejectPayment: RequestHandler = async (
  req,
  res,
  next
) => {
  try {
    const user = res.locals.user as AuthUser;

    if (user.role !== "admin") {
      res.status(403).json({
        success: false,
        message: "Admin access required.",
      });
      return;
    }

    const paymentIdParam = req.params.paymentId;

    const paymentId = Array.isArray(paymentIdParam)
      ? paymentIdParam[0]
      : paymentIdParam;

    if (!paymentId || !ObjectId.isValid(paymentId)) {
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

    if (payment.approvalStatus === "approved") {
      res.status(400).json({
        success: false,
        message: "This payment has already been approved.",
      });
      return;
    }

    if (payment.refundStatus === "succeeded") {
      res.status(200).json({
        success: true,
        message: "This payment has already been refunded.",
        refundStatus: "succeeded",
      });
      return;
    }

    if (
      payment.status !== "paid" &&
      payment.paymentStatus !== "paid"
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
        message: "Stripe subscription information is missing.",
      });
      return;
    }

    const stripe = getStripe();

    // Retrieve the subscription first.
    const subscription =
      await stripe.subscriptions.retrieve(subscriptionId);

    // Verify subscription ownership when metadata is available.
    if (
      subscription.metadata.userId &&
      subscription.metadata.userId !== payment.userId
    ) {
      res.status(403).json({
        success: false,
        message:
          "Subscription does not belong to this payment record.",
      });
      return;
    }

    // Use stored PaymentIntent, or recover it from the invoice.
    let paymentIntentId =
      payment.stripePaymentIntentId ||
      payment.paymentIntentId ||
      null;

    if (!paymentIntentId) {
      paymentIntentId =
        await getSubscriptionPaymentIntentId(subscriptionId);
    }

    if (!paymentIntentId) {
      res.status(400).json({
        success: false,
        message:
          "Could not find the initial Stripe PaymentIntent. No refund was attempted.",
      });
      return;
    }

    // Save recovered PaymentIntent before continuing.
    await payments.updateOne(
      { _id: new ObjectId(paymentId) },
      {
        $set: {
          stripePaymentIntentId: paymentIntentId,
          paymentIntentId,
          updatedAt: new Date(),
        },
      }
    );

    // Mark rejection and refund processing.
    await payments.updateOne(
      { _id: new ObjectId(paymentId) },
      {
        $set: {
          approvalStatus: "rejected",
          refundStatus: "pending",
          refundError: null,
          updatedAt: new Date(),
        },
      }
    );

    try {
      // Cancel subscription first.
      if (subscription.status !== "canceled") {
        await stripe.subscriptions.cancel(subscriptionId);
      }

      await payments.updateOne(
        { _id: new ObjectId(paymentId) },
        {
          $set: {
            subscriptionCanceled: true,
            updatedAt: new Date(),
          },
        }
      );

      // Downgrade user's Pro plan.
      const userUpdated = await updateUserSubscription(
        payment.userId,
        subscriptionId,
        "canceled",
        true
      );

      if (!userUpdated) {
        console.error(
          `Could not downgrade user ${payment.userId} after subscription cancellation.`
        );
      }

      // Refund the initial payment.
      const refund = await stripe.refunds.create(
        {
          payment_intent: paymentIntentId,

          reason: "requested_by_customer",

          metadata: {
            paymentId,
            userId: payment.userId,
            rejectedBy: user.id,
          },
        },
        {
          idempotencyKey:
            `mentorlagbe-refund-${paymentId}`,
        }
      );

      const refundSucceeded =
        refund.status === "succeeded";

      await payments.updateOne(
        { _id: new ObjectId(paymentId) },
        {
          $set: {
            approvalStatus: "rejected",

            refundStatus: refundSucceeded
              ? "succeeded"
              : "pending",

            refundId: refund.id,
            refundError: null,

            status: refundSucceeded
              ? "refunded"
              : "paid",

            paymentStatus: refundSucceeded
              ? "refunded"
              : "paid",

            subscriptionCanceled: true,
            updatedAt: new Date(),
          },
        }
      );

      res.status(200).json({
        success: true,

        message: refundSucceeded
          ? "Payment rejected, subscription canceled, and refund completed."
          : "Payment rejected and subscription canceled. Refund is still processing.",

        approvalStatus: "rejected",
        subscriptionCanceled: true,

        refundStatus: refundSucceeded
          ? "succeeded"
          : "pending",

        refundId: refund.id,
      });
    } catch (error) {
      await payments.updateOne(
        { _id: new ObjectId(paymentId) },
        {
          $set: {
            approvalStatus: "rejected",
            refundStatus: "failed",
            refundError: getErrorMessage(error),
            updatedAt: new Date(),
          },
        }
      );

      throw error;
    }
  } catch (error) {
    next(error);
  }
};

// --------------------------------------------------
// Routes
// --------------------------------------------------

// Student and Tutor: Create Pro checkout
router.post(
  "/create-checkout-session",
  verifyToken,
  validateCheckoutPlan,
  createCheckoutSession
);

// Student and Tutor: Verify payment
router.post(
  "/verify-session",
  verifyToken,
  verifyCheckoutSession
);

// Logged-in user: Own payment history
router.get(
  "/my-payments",
  verifyToken,
  getMyPayments
);

// Admin: All payment records
router.get(
  "/admin/all",
  verifyToken,
  getAllPayments
);

// Admin: Reject payment + cancel subscription + refund
router.patch(
  "/admin/:paymentId/reject",
  verifyToken,
  rejectPayment
);

// Stripe webhook
router.post(
  "/webhook",
  stripeWebhook
);

export default router;
