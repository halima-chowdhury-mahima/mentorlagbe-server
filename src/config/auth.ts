
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { jwt } from "better-auth/plugins";

import { getDB } from "./db.js";

const baseURL =
  process.env.BETTER_AUTH_URL || "http://localhost:5000";

export const createAuth = () => {
  return betterAuth({
    database: mongodbAdapter(getDB()),

    baseURL,

    secret: process.env.BETTER_AUTH_SECRET,

    trustedOrigins: [
      process.env.CLIENT_URL || "http://localhost:3000",
    ],

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
