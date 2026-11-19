import { Router } from "express";
import { getDB } from "../config/db.js";
import { verifyToken } from "../middlewares/auth.middleware.js";

const router = Router();

router.use(verifyToken);

type AuthUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  plan: string;
};

const allowedFields = [
  "name",
  "image",
  "phone",
  "gender",
  "dateOfBirth",
  "address",
  "city",
  "bio",
  "education",
  "institution",
  "subjects",
  "classLevels",
  "medium",
  "experience",
  "qualification",
  "hourlyRate",
  "availability",
  "preferredLocation",
];

const getUserFilter = (user: AuthUser) => ({
  $or: [
    { _id: user.id },
    { id: user.id },
    { email: user.email },
  ],
});

router.get("/me", async (_req, res, next) => {
  try {
    const user = res.locals.user as AuthUser;
    const users = getDB().collection("user");

    const profile = await users.findOne(getUserFilter(user), {
      projection: { password: 0 },
    });

    if (!profile) {
      res.status(404).json({
        success: false,
        message: "User profile not found.",
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        ...profile,
        name: profile.name || user.name,
        email: user.email,
        role: user.role,
        plan: user.plan,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.patch("/me", async (req, res, next) => {
  try {
    const user = res.locals.user as AuthUser;
    const users = getDB().collection("user");

    const updateData: Record<string, unknown> = {};

    for (const field of allowedFields) {
      const value = req.body?.[field];

      if (value !== undefined) {
        updateData[field] = value;
      }
    }

    if (typeof updateData.name === "string") {
      updateData.name = updateData.name.trim();

      if (!updateData.name) {
        res.status(400).json({
          success: false,
          message: "Name cannot be empty.",
        });
        return;
      }
    }

    if (typeof updateData.bio === "string" && updateData.bio.length > 500) {
      res.status(400).json({
        success: false,
        message: "Bio must be 500 characters or less.",
      });
      return;
    }

    if (Object.keys(updateData).length === 0) {
      res.status(400).json({
        success: false,
        message: "No valid profile fields provided.",
      });
      return;
    }

    updateData.updatedAt = new Date();

    const result = await users.updateOne(
      getUserFilter(user),
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      res.status(404).json({
        success: false,
        message: "User profile not found.",
      });
      return;
    }

    const updatedProfile = await users.findOne(getUserFilter(user), {
      projection: { password: 0 },
    });

    res.status(200).json({
      success: true,
      message: "Profile updated successfully.",
      data: updatedProfile,
    });
  } catch (error) {
    next(error);
  }
});

export default router;