export type PaymentStatus =
  | "pending"
  | "paid"
  | "completed"
  | "failed"
  | "refunded";

export type PaymentApprovalStatus =
  | "pending"
  | "approved"
  | "rejected";

export type RefundStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | null;

export type PaymentPlan =
  | "pro_student"
  | "pro_tutor";

export interface Payment {
  _id?: string;
  userId: string;
  user?: {
    name?: string;
    email?: string;
  };
  role: "student" | "tutor";
  plan: PaymentPlan;
  planName: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  approvalStatus: PaymentApprovalStatus;
  refundStatus: RefundStatus;
  method: "stripe";
  stripeSessionId: string;
  stripeSubscriptionId: string;
  stripePaymentIntentId: string;
  transactionId: string;
  refundId?: string;
  refundError?: string;
  subscriptionCanceled?: boolean;
  createdAt: Date;
  updatedAt: Date;
}