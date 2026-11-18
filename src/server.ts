
import express, { type Express } from "express";
import cors from "cors";
import { toNodeHandler } from "better-auth/node";

import { connectDB } from "./config/db.js";
import { createAuth } from "./config/auth.js";

import tuitionRoutes from "./routes/tuition.routes.js";
import applicationRoutes from "./routes/application.routes.js";
import tutorRoutes from "./routes/tutor.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import paymentRoutes from "./routes/payment.routes.js";
import uploadRoutes from "./routes/upload.routes.js";
import bookmarkRoutes from "./routes/bookmark.routes.js";

export const createApp = async (): Promise<Express> => {
  await connectDB();

  if (!process.env.BETTER_AUTH_SECRET) {
    throw new Error("BETTER_AUTH_SECRET is missing.");
  }

  const app = express();

  const allowedOrigins = new Set([
    "http://localhost:3000",
    ...(process.env.CLIENT_URL || "")
      .split(",")
      .map((origin) => origin.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  ]);

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.has(origin)) {
          callback(null, true);
        } else {
          callback(new Error("Not allowed by CORS"));
        }
      },
      credentials: true,
    })
  );

  // Better Auth handler
  const auth = createAuth();

  app.all("/api/auth/*splat", toNodeHandler(auth));

  // Stripe webhook: raw body must be preserved
  app.use(
    "/api/payments/webhook",
    express.raw({ type: "application/json" })
  );

  // JSON parser
  app.use(express.json({ limit: "12mb" }));

  // API routes
  app.use("/api/uploads", uploadRoutes);
  app.use("/api/bookmarks", bookmarkRoutes);
  app.use("/api/tuitions", tuitionRoutes);
  app.use("/api/applications", applicationRoutes);
  app.use("/api/tutor", tutorRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/payments", paymentRoutes);

  // Root API
  app.get("/", (_req, res) => {
    res.status(200).json({
      success: true,
      message: "MentorLagbe API is running!",
    });
  });

  app.get("/api/health", (_req, res) => {
    res.status(200).json({
      success: true,
      message: "MentorLagbe API is healthy!",
    });
  });

  return app;
};
