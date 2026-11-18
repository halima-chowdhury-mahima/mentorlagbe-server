
import type { Request, Response } from "express";

import { createApp } from "../src/server.js";

let appPromise: ReturnType<typeof createApp> | null = null;

export default async function handler(
  req: Request,
  res: Response
): Promise<void> {
  try {
    if (!appPromise) {
      appPromise = createApp();
    }

    const app = await appPromise;

    app(req, res);
  } catch (error) {
    console.error("Vercel Function Error:", error);

    appPromise = null;

    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: "Internal server error.",
      });
    }
  }
}
