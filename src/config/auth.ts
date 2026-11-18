
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { jwt } from "better-auth/plugins";

import { getDB } from "./db.js";

export const createAuth = () => {
  const baseURL = (
    process.env.BETTER_AUTH_URL || "http://localhost:5000"
  ).replace(/\/+$/, "");

  const trustedOrigins = (
    process.env.CLIENT_URL || "http://localhost:3000"
  )
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);

  const secret = process.env.BETTER_AUTH_SECRET;

  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET is missing.");
  }

  return betterAuth({
    database: mongodbAdapter(getDB()),

    baseURL,

    secret,

    trustedOrigins,

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
    },

    user: {
      additionalFields: {
        role: {
          type: "string",
          required: true,
          defaultValue: "student",
          input: false,
        },
        plan: {
          type: "string",
          required: true,
          defaultValue: "free",
          input: false,
        },
      },
    },

    plugins: [
      jwt({
        jwt: {
          issuer: baseURL,
          audience: baseURL,
          expirationTime: "15m",

          definePayload: ({ user }) => ({
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            plan: user.plan,
          }),
        },
      }),
    ],
  });
};
