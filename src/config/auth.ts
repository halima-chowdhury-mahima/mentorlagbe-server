
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { jwt } from "better-auth/plugins";

import { getDB } from "./db.js";

const SERVER_URL =
  process.env.BETTER_AUTH_URL || "http://localhost:5000";

const CLIENT_URLS = (
  process.env.CLIENT_URL || "http://localhost:3000"
)
  .split(",")
  .map((url) => url.trim().replace(/\/+$/, ""))
  .filter(Boolean);

const SECRET = process.env.BETTER_AUTH_SECRET;

if (!SECRET) {
  throw new Error("BETTER_AUTH_SECRET is missing.");
}

if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
  throw new Error("Google OAuth credentials are missing.");
}

const PRODUCTION = process.env.NODE_ENV === "production";

const createAuth = () =>
  betterAuth({
    appName: "MentorLagbe",

    baseURL: SERVER_URL.replace(/\/+$/, ""),

    secret: SECRET,

    database: mongodbAdapter(getDB()),

    trustedOrigins: CLIENT_URLS,

    advanced: {
      defaultCookieAttributes: {
        sameSite: PRODUCTION ? "none" : "lax",
        secure: PRODUCTION,
        httpOnly: true,
      },
    },

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
    },

    socialProviders: {
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  },
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
          issuer: SERVER_URL.replace(/\/+$/, ""),
          audience: SERVER_URL.replace(/\/+$/, ""),
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

export default createAuth;
