
import { Router } from "express";
import { ObjectId } from "mongodb";

import { getDB } from "../config/db.js";
import { getCollections } from "../config/collections.js";
import {
  verifyToken,
  verifyStudent,
} from "../middlewares/auth.middleware.js";

const router = Router();

router.use(verifyToken, verifyStudent);

const FREE_BOOKMARK_LIMIT = 5;

// ==========================================
// GET: Get student's saved tuitions
// ==========================================
router.get("/", async (_req, res, next) => {
  try {
    const user = res.locals.user as { id: string };

    if (!ObjectId.isValid(user.id)) {
      res.status(400).json({
        success: false,
        message: "Invalid user ID",
      });
      return;
    }

    const db = getDB();

    const authUser = await db.collection("user").findOne(
      { _id: new ObjectId(user.id) },
      { projection: { savedTuitions: 1 } }
    );

    const savedIds = Array.isArray(authUser?.savedTuitions)
      ? (authUser.savedTuitions as string[])
      : [];

    if (savedIds.length === 0) {
      res.status(200).json({
        success: true,
        data: [],
      });
      return;
    }

    const validIds = savedIds
      .filter((id) => ObjectId.isValid(id))
      .map((id) => new ObjectId(id));

    const { tuitions } = getCollections();

    const result = await tuitions
      .find({
        _id: { $in: validIds },
        status: "approved",
      })
      .toArray();

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// POST: Save a tuition
// Free Student: Maximum 5 bookmarks
// Pro Student: Unlimited bookmarks
// ==========================================
router.post("/:tuitionId", async (req, res, next) => {
  try {
    const user = res.locals.user as { id: string };

    const tuitionIdParam = req.params.tuitionId;
    const tuitionId = Array.isArray(tuitionIdParam)
      ? tuitionIdParam[0]
      : tuitionIdParam;

    if (!tuitionId || !ObjectId.isValid(tuitionId)) {
      res.status(400).json({
        success: false,
        message: "Invalid tuition ID",
      });
      return;
    }

    if (!ObjectId.isValid(user.id)) {
      res.status(400).json({
        success: false,
        message: "Invalid user ID",
      });
      return;
    }

    const db = getDB();
    const userObjectId = new ObjectId(user.id);

    const authUser = await db.collection("user").findOne(
      { _id: userObjectId },
      { projection: { plan: 1, savedTuitions: 1 } }
    );

    if (!authUser) {
      res.status(404).json({
        success: false,
        message: "User not found",
      });
      return;
    }

    const { tuitions } = getCollections();

    const tuition = await tuitions.findOne({
      _id: new ObjectId(tuitionId),
      status: "approved",
    });

    if (!tuition) {
      res.status(404).json({
        success: false,
        message: "Tuition not found",
      });
      return;
    }

    const savedIds = Array.isArray(authUser.savedTuitions)
      ? (authUser.savedTuitions as string[])
      : [];

    // Prevent duplicate bookmarks
    if (savedIds.includes(tuitionId)) {
      res.status(200).json({
        success: true,
        message: "Tuition is already saved",
      });
      return;
    }

    // Always check the latest plan from MongoDB
    const isPro = String(authUser.plan || "free").toLowerCase() === "pro";

    if (isPro) {
      await db.collection("user").updateOne(
        {
          _id: userObjectId,
          savedTuitions: { $ne: tuitionId },
        },
        {
          $addToSet: { savedTuitions: tuitionId },
        }
      );

      res.status(200).json({
        success: true,
        message: "Tuition saved successfully",
      });
      return;
    }

    // Atomic limit check: Free students can save only 5
    const result = await db.collection("user").updateOne(
      {
        _id: userObjectId,
        savedTuitions: { $ne: tuitionId },
        $expr: {
          $lt: [
            {
              $size: {
                $ifNull: ["$savedTuitions", []],
              },
            },
            FREE_BOOKMARK_LIMIT,
          ],
        },
      },
      {
        $addToSet: { savedTuitions: tuitionId },
      }
    );

    if (result.modifiedCount === 1) {
      res.status(200).json({
        success: true,
        message: "Tuition saved successfully",
      });
      return;
    }

    // Check the latest state in case another request saved it
    const latestUser = await db.collection("user").findOne(
      { _id: userObjectId },
      { projection: { savedTuitions: 1, plan: 1 } }
    );

    if (!latestUser) {
      res.status(404).json({
        success: false,
        message: "User not found",
      });
      return;
    }

    const latestSavedIds = Array.isArray(latestUser.savedTuitions)
      ? (latestUser.savedTuitions as string[])
      : [];

    if (latestSavedIds.includes(tuitionId)) {
      res.status(200).json({
        success: true,
        message: "Tuition is already saved",
      });
      return;
    }

    if (String(latestUser.plan || "free").toLowerCase() === "pro") {
      await db.collection("user").updateOne(
        {
          _id: userObjectId,
          savedTuitions: { $ne: tuitionId },
        },
        {
          $addToSet: { savedTuitions: tuitionId },
        }
      );

      res.status(200).json({
        success: true,
        message: "Tuition saved successfully",
      });
      return;
    }

    if (latestSavedIds.length >= FREE_BOOKMARK_LIMIT) {
      res.status(403).json({
        success: false,
        code: "BOOKMARK_LIMIT_REACHED",
        message:
          "Free plan allows only 5 bookmarks. Upgrade to Pro for unlimited bookmarks.",
      });
      return;
    }

    res.status(409).json({
      success: false,
      message: "Unable to save tuition. Please try again.",
    });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// DELETE: Remove a saved tuition
// ==========================================
router.delete("/:tuitionId", async (req, res, next) => {
  try {
    const user = res.locals.user as { id: string };

    const tuitionIdParam = req.params.tuitionId;
    const tuitionId = Array.isArray(tuitionIdParam)
      ? tuitionIdParam[0]
      : tuitionIdParam;

    if (!tuitionId || !ObjectId.isValid(tuitionId)) {
      res.status(400).json({
        success: false,
        message: "Invalid tuition ID",
      });
      return;
    }

    if (!ObjectId.isValid(user.id)) {
      res.status(400).json({
        success: false,
        message: "Invalid user ID",
      });
      return;
    }

    const db = getDB();

    await db.collection("user").updateOne(
      { _id: new ObjectId(user.id) },
      { $pull: { savedTuitions: tuitionId } }
    );

    res.status(200).json({
      success: true,
      message: "Saved tuition removed successfully",
    });
  } catch (error) {
    next(error);
  }
});

export default router;
