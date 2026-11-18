
import "dotenv/config";

import { createApp } from "./server.js";

const PORT = Number(process.env.PORT) || 5000;

const startServer = async (): Promise<void> => {
  try {
    const app = await createApp();

    app.listen(PORT, () => {
      console.log(`MentorLagbe Server running on port ${PORT}`);
      console.log("MongoDB connected successfully!");
      console.log("Better Auth is ready!");
      console.log("Stripe webhook endpoint is ready!");
    });
  } catch (error) {
    console.error("Server startup failed:", error);
    process.exitCode = 1;
  }
};

void startServer();
