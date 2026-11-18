
import Stripe from "stripe";

export const getStripe = (): Stripe => {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY is missing in .env");
  }

  return new Stripe(secretKey);
};
