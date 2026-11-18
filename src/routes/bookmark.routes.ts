
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

// Get student's saved tuitions
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

    const savedIds = (authUser?.savedTuitions || []) as string[];

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

// Save a tuition
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

    const db = getDB();

    await db.collection("user").updateOne(
      { _id: new ObjectId(user.id) },
      { $addToSet: { savedTuitions: tuitionId } }
    );

    res.status(200).json({
      success: true,
      message: "Tuition saved successfully",
    });
  } catch (error) {
    next(error);
  }
});

// Remove a saved tuition
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
