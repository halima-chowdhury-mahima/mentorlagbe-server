
import express, { type Express } from "express";
import cors from "cors";
import { toNodeHandler } from "better-auth/node";

import { connectDB } from "./config/db.js";
import createAuth from "./config/auth.js";

import tuitionRoutes from "./routes/tuition.routes.js";
import applicationRoutes from "./routes/application.routes.js";
import tutorRoutes from "./routes/tutor.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import paymentRoutes from "./routes/payment.routes.js";
import uploadRoutes from "./routes/upload.routes.js";
import bookmarkRoutes from "./routes/bookmark.routes.js";
import profileRoutes from "./routes/profile.routes.js";

export const createApp = async (): Promise<Express> => {
  // 1. Connect MongoDB first
  await connectDB();

  // 2. Validate environment variables
  if (!process.env.BETTER_AUTH_SECRET) {
    throw new Error("BETTER_AUTH_SECRET is missing.");
  }

  // 3. Initialize Express
  const app = express();

  // 4. Configure allowed frontend origins

  const allowedOrigins = new Set(
  [
    "http://localhost:3000",
    "https://mentor-lagbe-red.vercel.app",

    ...(process.env.CLIENT_URL || "")
      .split(",")
      .map((origin) => origin.trim()),
  ]
    .filter(Boolean)
    .map((origin) => origin.replace(/\/+$/, ""))
);

// 5. CORS configuration
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        return callback(null, true);
      }

      const normalizedOrigin = origin.replace(/\/+$/, "");

      if (allowedOrigins.has(normalizedOrigin)) {
        return callback(null, true);
      }

      console.error(`CORS blocked origin: ${origin}`);

      return callback(
        new Error(`CORS blocked origin: ${origin}`)
      );
    },
    credentials: true,
    methods: [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
    ],
    maxAge: 86400,
  })
);

  // 6. Initialize Better Auth AFTER MongoDB connection
  const auth = createAuth();

  // 7. Better Auth routes
  app.all("/api/auth/*splat", toNodeHandler(auth));

  // 8. Stripe webhook - preserve raw body
  app.use(
    "/api/payments/webhook",
    express.raw({ type: "application/json" })
  );

  // 9. JSON parser
  app.use(express.json({ limit: "12mb" }));

  // 10. API routes
  app.use("/api/uploads", uploadRoutes);
  app.use("/api/bookmarks", bookmarkRoutes);
  app.use("/api/tuitions", tuitionRoutes);
  app.use("/api/applications", applicationRoutes);
  app.use("/api/tutor", tutorRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/payments", paymentRoutes);
  app.use("/api/profile", profileRoutes);

  // 11. Root API
  app.get("/", (_req, res) => {
    res.status(200).json({
      success: true,
      message: "MentorLagbe API is running!",
    });
  });

  // 12. Health check
  app.get("/api/health", (_req, res) => {
    res.status(200).json({
      success: true,
      message: "MentorLagbe API is healthy!",
    });
  });

  return app;
};
