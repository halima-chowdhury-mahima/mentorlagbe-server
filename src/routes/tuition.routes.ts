
import { Router } from "express";

import { getCollections } from "../config/collections.js";
import {
  verifyToken,
  verifyTutor,
} from "../middlewares/auth.middleware.js";

const router = Router();

// ==========================================
// GET: BROWSE APPROVED & ACTIVE TUITION POSTS
// Supports search, filters and pagination
// ==========================================
router.get("/", async (req, res, next) => {
  try {
    const { tuitions } = getCollections();

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 10));
    const skip = (page - 1) * limit;

    const filter: Record<string, any> = {
      approvalStatus: "approved",
      isActive: true,
    };

    // Search by title or subject
    if (req.query.search) {
      const search = String(req.query.search).trim();
      const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      if (escapedSearch) {
        filter.$or = [
          { title: { $regex: escapedSearch, $options: "i" } },
          { subject: { $regex: escapedSearch, $options: "i" } },
        ];
      }
    }

    // Filter by subject
    if (req.query.subject) {
      filter.subject = String(req.query.subject);
    }

    // Filter by class level
    if (req.query.classLevel) {
      filter.classLevel = String(req.query.classLevel);
    }

    // Filter by mode: Online / Offline
    if (req.query.mode) {
      filter.mode = String(req.query.mode);
    }

    const [data, total] = await Promise.all([
      tuitions
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),

      tuitions.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// GET: SINGLE APPROVED TUITION DETAILS
// ==========================================
router.get("/:id", async (req, res, next) => {
  try {
    const { tuitions } = getCollections();
    const id = req.params.id;

    if (!id) {
      res.status(400).json({
        success: false,
        message: "Tuition ID is required.",
      });
      return;
    }

    const tuition = await tuitions.findOne({
      _id: id as any,
      approvalStatus: "approved",
      isActive: true,
    });

    // Support MongoDB ObjectId IDs
    const validTuition = tuition
      ? tuition
      : await findTuitionByObjectId(tuitions, id);

    if (!validTuition) {
      res.status(404).json({
        success: false,
        message: "Tuition not found.",
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: validTuition,
    });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// POST: TUTOR CREATES A TUITION
// Free: Maximum 2 posts
// Pro: Unlimited posts
// ==========================================
router.post("/", verifyToken, verifyTutor, async (req, res, next) => {
  try {
    const body = req.body ?? {};

    const {
      title,
      subject,
      classLevel,
      location,
      description,
    } = body;

    // Accept old frontend field names temporarily
    const monthlyFee = Number(body.monthlyFee ?? body.salary);

    const mode = String(body.mode ?? "").trim();

    const daysPerWeek = Number(body.daysPerWeek);

    const bannerImage =
      typeof body.bannerImage === "string"
        ? body.bannerImage
        : typeof body.image === "string"
          ? body.image
          : "";

    // Required field validation
    if (
      !title ||
      !subject ||
      !classLevel ||
      !location ||
      !description ||
      !Number.isFinite(monthlyFee) ||
      monthlyFee <= 0
    ) {
      res.status(400).json({
        success: false,
        message: "Please provide all required tuition information.",
      });
      return;
    }

    // Validate mode
    if (!["Online", "Offline"].includes(mode)) {
      res.status(400).json({
        success: false,
        message: "Tuition mode must be Online or Offline.",
      });
      return;
    }

    // Validate days per week
    if (
      !Number.isInteger(daysPerWeek) ||
      daysPerWeek < 1 ||
      daysPerWeek > 7
    ) {
      res.status(400).json({
        success: false,
        message: "Days per week must be between 1 and 7.",
      });
      return;
    }

    const user = res.locals.user as {
      id: string;
      name: string;
      email: string;
      plan: string;
    };

    if (!user?.id || !user?.email) {
      res.status(401).json({
        success: false,
        message: "Authentication information is missing.",
      });
      return;
    }

    const { tuitions } = getCollections();

    // Free tutors can create maximum 2 tuition posts
    if (user.plan !== "pro") {
      const existingPosts = await tuitions.countDocuments({
        tutorEmail: user.email,
      });

      if (existingPosts >= 2) {
        res.status(403).json({
          success: false,
          message:
            "Free plan allows only 2 tuition posts. Upgrade to Pro for unlimited posts.",
        });
        return;
      }
    }

    const now = new Date();

    // Assignment 9 tuition document structure
    const tuition = {
      title: String(title).trim(),
      subject: String(subject).trim(),
      classLevel: String(classLevel).trim(),

      mode,
      location: String(location).trim(),

      monthlyFee,
      daysPerWeek,

      bannerImage,
      description: String(description).trim(),

      tutorName: user.name || "",
      tutorEmail: user.email,

      approvalStatus: "pending",
      isActive: true,

      createdAt: now,
    };

    const result = await tuitions.insertOne(tuition);

    res.status(201).json({
      success: true,
      message: "Tuition submitted successfully. Waiting for admin approval.",
      data: {
        ...tuition,
        _id: result.insertedId,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// HELPER: FIND TUITION BY OBJECT ID
// ==========================================
async function findTuitionByObjectId(
  tuitions: ReturnType<typeof getCollections>["tuitions"],
  id: string
) {
  const { ObjectId } = await import("mongodb");

  if (!ObjectId.isValid(id)) {
    return null;
  }

  return tuitions.findOne({
    _id: new ObjectId(id),
    approvalStatus: "approved",
    isActive: true,
  });
}

export default router;
