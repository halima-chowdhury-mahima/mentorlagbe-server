
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

const getAuthenticatedUser = (
  res: Parameters<Parameters<typeof router.get>[1]>[1]
) => res.locals.user as AuthUser;

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
] as const;

// ==========================================
// SELECT STUDENT OR TUTOR ROLE
// ==========================================
router.patch("/role", async (req, res, next) => {
  try {
    const user = getAuthenticatedUser(res);
    const requestedRole = req.body?.role;

    if (!["student", "tutor"].includes(requestedRole)) {
      res.status(400).json({
        success: false,
        message: "Role must be student or tutor.",
      });
      return;
    }

    if (user.role === "admin") {
      res.status(403).json({
        success: false,
        message: "Admin role cannot be changed.",
      });
      return;
    }

    const users = getDB().collection("user");

    const existingUser = await users.findOne({ email: user.email });

    if (!existingUser) {
      res.status(404).json({
        success: false,
        message: "User account not found.",
      });
      return;
    }

    // Allow retrying the same selection, but prevent changing
    // a role after the initial selection.
    if (existingUser.roleSelectedAt) {
      if (existingUser.role === requestedRole) {
        res.status(200).json({
          success: true,
          message: "Role already selected.",
          role: existingUser.role,
        });
        return;
      }

      res.status(409).json({
        success: false,
        message: "Your account role has already been selected.",
      });
      return;
    }

    const result = await users.updateOne(
      {
        email: user.email,
        roleSelectedAt: { $exists: false },
      },
      {
        $set: {
          role: requestedRole,
          roleSelectedAt: new Date(),
          updatedAt: new Date(),
        },
      }
    );

    if (result.matchedCount === 0) {
      res.status(409).json({
        success: false,
        message: "Role selection could not be completed.",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Account role selected successfully.",
      role: requestedRole,
    });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// GET MY PROFILE
// ==========================================
router.get("/me", async (_req, res, next) => {
  try {
    const user = getAuthenticatedUser(res);
    const users = getDB().collection("user");

    const profile = await users.findOne(
      { email: user.email },
      { projection: { password: 0 } }
    );

    if (!profile) {
      res.status(404).json({
        success: false,
        message: "User account not found.",
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

// ==========================================
// UPDATE MY PROFILE
// ==========================================
router.patch("/me", async (req, res, next) => {
  try {
    const user = getAuthenticatedUser(res);
    const users = getDB().collection("user");

    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      res.status(400).json({
        success: false,
        message: "Invalid profile data.",
      });
      return;
    }

    const updateData: Record<string, unknown> = {};

    for (const field of allowedFields) {
      const value = req.body[field];

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
      { email: user.email },
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      res.status(404).json({
        success: false,
        message: "User account not found. Please sign in again.",
      });
      return;
    }

    const updatedProfile = await users.findOne(
      { email: user.email },
      { projection: { password: 0 } }
    );

    res.status(200).json({
      success: true,
      message: "Profile updated successfully.",
      data: {
        ...updatedProfile,
        email: user.email,
        role: user.role,
        plan: user.plan,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
