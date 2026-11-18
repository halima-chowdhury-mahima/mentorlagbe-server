
import { Router } from "express";

import { verifyToken } from "../middlewares/auth.middleware.js";

const router = Router();

// Upload image to ImgBB
router.post("/image", verifyToken, async (req, res, next) => {
  try {
    const image = req.body?.image as string | undefined;
    const apiKey = process.env.IMGBB_API_KEY;

    if (!apiKey) {
      res.status(500).json({
        success: false,
        message: "ImgBB API key is missing",
      });
      return;
    }

    if (!image || typeof image !== "string") {
      res.status(400).json({
        success: false,
        message: "Please provide an image",
      });
      return;
    }

    // Accept base64 image data or a data URL
    const imageData = image.replace(
      /^data:image\/[a-zA-Z0-9.+-]+;base64,/,
      ""
    );

    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(imageData)) {
      res.status(400).json({
        success: false,
        message: "Invalid image format",
      });
      return;
    }

    // Limit image size to approximately 8 MB
    const estimatedSize = (imageData.length * 3) / 4;

    if (estimatedSize > 8 * 1024 * 1024) {
      res.status(413).json({
        success: false,
        message: "Image size must be less than 8 MB",
      });
      return;
    }

    const formData = new FormData();
    formData.append("image", imageData);

    const params = new URLSearchParams({
      key: apiKey,
    });

    const response = await fetch(
      `https://api.imgbb.com/1/upload?${params.toString()}`,
      {
        method: "POST",
        body: formData,
      }
    );

    const result = (await response.json()) as {
      success?: boolean;
      data?: {
        url?: string;
        display_url?: string;
        delete_url?: string;
      };
      error?: {
        message?: string;
      };
    };

    if (!response.ok || !result.success || !result.data?.url) {
      res.status(502).json({
        success: false,
        message: result.error?.message || "Image upload failed",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Image uploaded successfully",
      data: {
        url: result.data.url,
        displayUrl: result.data.display_url,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
