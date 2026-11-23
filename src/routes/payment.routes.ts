
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

type ApprovalStatus = "pending" | "approved" | "rejected";

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

  const data = invoice as unknown as InvoiceWithPayments;

  for (const entry of data.payments?.data ?? []) {
    if (entry.payment?.type !== "payment_intent") continue;

    const intent = entry.payment.payment_intent;

    if (typeof intent === "string") return intent;

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

  if (directIntent) return directIntent;

  const sessionInvoiceId = getSessionInvoiceId(session);

  if (sessionInvoiceId) {
    const intent = await getPaymentIntentFromInvoice(
      stripe,
      sessionInvoiceId
    );

    if (intent) return intent;
  }

  const subscriptionId = getSubscriptionId(session);

  if (!subscriptionId) return null;

  const subscription = await stripe.subscriptions.retrieve(
    subscriptionId,
    { expand: ["latest_invoice"] }
  );

  const latestInvoice = subscription.latest_invoice;

  const invoiceId =
    typeof latestInvoice === "string"
      ? latestInvoice
      : latestInvoice?.id ?? null;

  if (!invoiceId) return null;

  return getPaymentIntentFromInvoice(stripe, invoiceId);
};

// --------------------------------------------------
// UPDATE USER PLAN
// --------------------------------------------------

const updateUserPlan = async (
  userId: string,
  subscriptionId: string,
  approvalStatus: ApprovalStatus,
  subscriptionStatus: string
): Promise<void> => {
  if (!ObjectId.isValid(userId)) {
    throw new Error("Invalid user ID.");
  }

  const isApproved =
    approvalStatus === "approved" &&
    ["active", "trialing"].includes(subscriptionStatus);

  const update = {
    $set: {
      plan: isApproved ? "pro" : "free",
      approvalStatus,
      stripeSubscriptionId: subscriptionId,
      subscriptionStatus,
      updatedAt: new Date(),
    },
  };

  const db = getDB();
  const { users } = getCollections();
  const id = new ObjectId(userId);

  const results = await Promise.all([
    db.collection("user").updateOne({ _id: id }, update),
    users.updateOne({ _id: id }, update),
  ]);

  if (
    results[0].matchedCount === 0 &&
    results[1].matchedCount === 0
  ) {
    throw new Error("User account could not be updated.");
  }
};

// --------------------------------------------------
// SAVE PAYMENT
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
    throw new Error("Checkout session is not a completed paid subscription.");
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
    console.error("Initial PaymentIntent lookup failed:", error);
  }

  const { payments } = getCollections();
  const now = new Date();

  const existing = await payments.findOne({
    stripeSessionId: session.id,
  });

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
    paidAt: session.created
      ? new Date(session.created * 1000)
      : now,
    updatedAt: now,
  };

  await payments.updateOne(
    { stripeSessionId: session.id },
    {
      $set: paymentRecord,
      $setOnInsert: {
        createdAt: now,
        approvalStatus: "pending",
        refundStatus: "not_refunded",
        cancellationStatus: "not_cancelled",
      },
    },
    { upsert: true }
  );

  // Old records without approvalStatus are treated as pending.
  await payments.updateOne(
    {
      stripeSessionId: session.id,
      approvalStatus: { $exists: false },
    },
    {
      $set: {
        approvalStatus: "pending",
        refundStatus: "not_refunded",
      },
    }
  );

  if (!paymentIntentId) {
    console.warn(
      `Payment saved without PaymentIntent: ${session.id}`
    );
  }

  // IMPORTANT:
  // Do not activate PRO here.
  // Admin approval is required.
};

// --------------------------------------------------
// VALIDATE PLAN
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
// CREATE CHECKOUT
// --------------------------------------------------

const createCheckoutSession: RequestHandler = async (
  req,
  res,
  next
) => {
  try {
    const user = res.locals.user as AuthUser;

    if (!ObjectId.isValid(user.id)) {
      res.status(400).json({
        success: false,
        message: "Invalid user account.",
      });
      return;
    }

    const db = getDB();

    const dbUser =
      (await db.collection("user").findOne({
        _id: new ObjectId(user.id),
      })) ||
      (await db.collection("users").findOne({
        _id: new ObjectId(user.id),
      }));

    if (!dbUser) {
      res.status(404).json({
        success: false,
        message: "User account not found.",
      });
      return;
    }

    if (
      dbUser.plan === "pro" &&
      dbUser.approvalStatus === "approved" &&
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

    const { payments } = getCollections();

    const pendingPayment = await payments.findOne({
      userId: user.id,
      paymentStatus: "paid",
      approvalStatus: "pending",
    });

    if (pendingPayment) {
      res.status(409).json({
        success: false,
        message: "You already have a payment awaiting admin approval.",
      });
      return;
    }

    const isTutor = user.role === "tutor";
    const plan = isTutor ? "pro_tutor" : "pro_student";
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
              description: "MentorLagbe monthly Pro subscription",
            },
            unit_amount: amount,
            recurring: { interval: "month" },
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
// VERIFY CHECKOUT
// --------------------------------------------------

const verifyCheckoutSession: RequestHandler = async (
  req,
  res,
  next
) => {
  try {
    const user = res.locals.user as AuthUser;
    const { sessionId } = req.body as { sessionId?: string };

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

    const expectedPlan =
      user.role === "tutor" ? "pro_tutor" : "pro_student";

    if (
      session.metadata?.role !== user.role ||
      session.metadata?.plan !== expectedPlan
    ) {
      res.status(403).json({
        success: false,
        message: "Subscription details do not match your account.",
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

    await savePaymentRecord(session);

    // Payment received, but PRO remains locked until Admin approval.
    await updateUserPlan(
      user.id,
      subscription.id,
      "pending",
      subscription.status
    );

    res.status(200).json({
      success: true,
      message: "Payment received. Your Pro plan is pending admin approval.",
      plan: "free",
      approvalStatus: "pending",
      subscriptionStatus: subscription.status,
    });
  } catch (error) {
    next(error);
  }
};

// --------------------------------------------------
// STRIPE WEBHOOK
// --------------------------------------------------

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
            subscription.metadata.userId === userId
          ) {
            await savePaymentRecord(session);

            const { payments } = getCollections();

            const payment = await payments.findOne({
              stripeSubscriptionId: subscriptionId,
            });

            const approvalStatus: ApprovalStatus =
              payment?.approvalStatus === "approved"
                ? "approved"
                : payment?.approvalStatus === "rejected"
                  ? "rejected"
                  : "pending";

            await updateUserPlan(
              userId,
              subscriptionId,
              approvalStatus,
              subscription.status
            );
          }
        }

        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription =
          event.data.object as Stripe.Subscription;

        const { payments } = getCollections();

        const payment = await payments.findOne({
          stripeSubscriptionId: subscription.id,
        });

        // Do not grant PRO based on Stripe status alone.
        // Only an approved payment can keep PRO active.
        if (payment?.userId) {
          const approvalStatus: ApprovalStatus =
            payment.approvalStatus === "approved"
              ? "approved"
              : payment.approvalStatus === "rejected"
                ? "rejected"
                : "pending";

          await updateUserPlan(
            String(payment.userId),
            subscription.id,
            approvalStatus,
            subscription.status
          );

          await payments.updateOne(
            { _id: payment._id },
            {
              $set: {
                subscriptionStatus: subscription.status,
                updatedAt: new Date(),
              },
            }
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
// GET MY PAYMENTS
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
// ADMIN: GET ALL PAYMENTS
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
// ADMIN: APPROVE PAYMENT
// --------------------------------------------------

const approvePayment: RequestHandler = async (
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

    if (payment.approvalStatus === "approved") {
      res.status(200).json({
        success: true,
        message: "Payment is already approved.",
        approvalStatus: "approved",
      });
      return;
    }

    if (payment.approvalStatus === "rejected") {
      res.status(409).json({
        success: false,
        message: "A rejected payment cannot be approved.",
      });
      return;
    }

    if (
      payment.paymentStatus !== "paid" &&
      payment.status !== "paid"
    ) {
      res.status(400).json({
        success: false,
        message: "Only successful payments can be approved.",
      });
      return;
    }

    if (
      payment.refundStatus === "pending" ||
      payment.refundStatus === "succeeded"
    ) {
      res.status(409).json({
        success: false,
        message: "This payment has a refund in progress or completed.",
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

    const subscription =
      await stripe.subscriptions.retrieve(subscriptionId);

    if (
      subscription.status !== "active" &&
      subscription.status !== "trialing"
    ) {
      res.status(409).json({
        success: false,
        message: "The Stripe subscription is not active.",
      });
      return;
    }

    if (
      subscription.metadata.userId !== String(payment.userId)
    ) {
      res.status(403).json({
        success: false,
        message: "Subscription owner does not match the payment.",
      });
      return;
    }

    const updateResult = await payments.updateOne(
      {
        _id: new ObjectId(paymentId),
        approvalStatus: { $nin: ["approved", "rejected"] },
        paymentStatus: "paid",
      },
      {
        $set: {
          approvalStatus: "approved",
          approvedAt: new Date(),
          subscriptionStatus: subscription.status,
          updatedAt: new Date(),
        },
      }
    );

    if (updateResult.modifiedCount === 0) {
      const latest = await payments.findOne({
        _id: new ObjectId(paymentId),
      });

      if (latest?.approvalStatus !== "approved") {
        res.status(409).json({
          success: false,
          message: "Payment status changed. Refresh and try again.",
        });
        return;
      }
    }

    try {
      await updateUserPlan(
        String(payment.userId),
        subscriptionId,
        "approved",
        subscription.status
      );
    } catch (error) {
      // Revert approval if user records could not be synchronized.
      await payments.updateOne(
        { _id: new ObjectId(paymentId) },
        {
          $set: {
            approvalStatus: "pending",
            updatedAt: new Date(),
          },
          $unset: { approvedAt: "" },
        }
      );

      throw error;
    }

    res.status(200).json({
      success: true,
      message: "Payment approved. PRO is now active.",
      approvalStatus: "approved",
      plan: "pro",
    });
  } catch (error) {
    next(error);
  }
};

// --------------------------------------------------
// ADMIN: REJECT + CANCEL + REFUND
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
        refundStatus: "succeeded",
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
        message: "Only successful payments can be rejected and refunded.",
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

    // Reject first, so PRO access is removed even if refund fails.
    await payments.updateOne(
      { _id: new ObjectId(paymentId) },
      {
        $set: {
          approvalStatus: "rejected",
          rejectedAt: payment.rejectedAt || new Date(),
          updatedAt: new Date(),
        },
      }
    );

    await updateUserPlan(
      String(payment.userId),
      subscriptionId,
      "rejected",
      "canceled"
    );

    // Cancel the Stripe subscription.
    try {
      const subscription =
        await stripe.subscriptions.retrieve(subscriptionId);

      if (subscription.status !== "canceled") {
        await stripe.subscriptions.cancel(subscriptionId);
      }

      await payments.updateOne(
        { _id: new ObjectId(paymentId) },
        {
          $set: {
            cancellationStatus: "canceled",
            subscriptionStatus: "canceled",
            updatedAt: new Date(),
          },
        }
      );
    } catch (cancelError) {
      const reason =
        cancelError instanceof Error
          ? cancelError.message
          : "Stripe subscription cancellation failed.";

      await payments.updateOne(
        { _id: new ObjectId(paymentId) },
        {
          $set: {
            cancellationStatus: "failed",
            cancellationFailureReason: reason,
            updatedAt: new Date(),
          },
        }
      );

      res.status(502).json({
        success: false,
        approvalStatus: "rejected",
        refundStatus: payment.refundStatus || "not_refunded",
        message:
          "Payment rejected and PRO access removed, but Stripe subscription cancellation failed. Please review this payment.",
      });
      return;
    }

    // Never use transactionId as a PaymentIntent ID.
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
      await payments.updateOne(
        { _id: new ObjectId(paymentId) },
        {
          $set: {
            refundStatus: "failed",
            refundFailureReason:
              "Initial Stripe PaymentIntent could not be found. Subscription was canceled.",
            paymentStatus: "paid",
            status: "paid",
            updatedAt: new Date(),
          },
        }
      );

      res.status(409).json({
        success: false,
        approvalStatus: "rejected",
        refundStatus: "failed",
        message:
          "Subscription canceled, but the initial payment could not be found for refund.",
      });
      return;
    }

    const previousAttempts = Number(payment.refundAttempts || 0);

    const attempt =
      payment.refundStatus === "failed"
        ? previousAttempts + 1
        : Math.max(previousAttempts, 1);

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
      if (
        payment.refundStatus === "pending" &&
        payment.stripeRefundId
      ) {
        refund = await stripe.refunds.retrieve(
          payment.stripeRefundId
        );
      } else {
        refund = await stripe.refunds.create(
          { payment_intent: paymentIntentId },
          { idempotencyKey }
        );
      }
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
            paymentStatus: "paid",
            status: "paid",
            cancellationStatus: "canceled",
            updatedAt: new Date(),
          },
        }
      );

      res.status(502).json({
        success: false,
        approvalStatus: "rejected",
        refundStatus: "failed",
        message:
          "Subscription canceled, but refund failed. You can retry from Admin Payments.",
      });
      return;
    }

    const refundStatus = refund.status || "pending";
    const refundSucceeded = refundStatus === "succeeded";

    await payments.updateOne(
      { _id: new ObjectId(paymentId) },
      {
        $set: {
          approvalStatus: "rejected",
          paymentStatus: refundSucceeded ? "refunded" : "paid",
          status: refundSucceeded
            ? "refunded"
            : refundStatus === "pending"
              ? "refund_pending"
              : "paid",
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
      approvalStatus: "rejected",
      refundStatus,
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
  "/admin/:paymentId/approve",
  verifyToken,
  verifyAdmin,
  approvePayment
);

router.post(
  "/admin/:paymentId/reject",
  verifyToken,
  verifyAdmin,
  rejectPayment
);

router.post("/webhook", stripeWebhook);

export default router;
