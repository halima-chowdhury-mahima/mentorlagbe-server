
export type PaymentStatus =
  | "pending"
  | "completed"
  | "failed"
  | "refunded";

export interface Payment {
  _id?: string;
  userId: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  stripeSessionId?: string;
  stripePaymentIntentId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}
