
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
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

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// CORS configuration
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  })
);

const startServer = async (): Promise<void> => {
  try {
    // Connect MongoDB
    await connectDB();

    // Validate Better Auth secret
    if (!process.env.BETTER_AUTH_SECRET) {
      throw new Error("BETTER_AUTH_SECRET is missing in .env");
    }

    // Initialize Better Auth
    const auth = createAuth();

    // Better Auth handler must be before express.json()
    app.all("/api/auth/*splat", toNodeHandler(auth));

    // Stripe webhook must receive the raw request body.
    // Keep this before express.json().
    app.use(
      "/api/payments/webhook",
      express.raw({ type: "application/json" })
    );

    // Parse JSON request bodies
    app.use(express.json({ limit: "12mb" }));

    // Upload routes
    app.use("/api/uploads", uploadRoutes);

    // Bookmark routes
    app.use("/api/bookmarks", bookmarkRoutes);

    // Main API routes
    app.use("/api/tuitions", tuitionRoutes);
    app.use("/api/applications", applicationRoutes);
    app.use("/api/tutor", tutorRoutes);
    app.use("/api/admin", adminRoutes);
    app.use("/api/payments", paymentRoutes);

    // Root API route
    app.get("/", (_req, res) => {
      res.status(200).json({
        success: true,
        message: "MentorLagbe API is running!",
      });
    });

    // Start server
    app.listen(PORT, () => {
      console.log(`MentorLagbe Server running on port ${PORT}`);
      console.log("MongoDB connected successfully!");
      console.log("Better Auth is ready!");
      console.log("Stripe webhook endpoint is ready!");
    });
  } catch (error) {
    console.error("Server startup failed:", error);
    process.exit(1);
  }
};

startServer();
