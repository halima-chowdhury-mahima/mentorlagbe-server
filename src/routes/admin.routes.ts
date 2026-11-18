
import { Router } from "express";
import { ObjectId } from "mongodb";

import { getCollections } from "../config/collections.js";
import { getDB } from "../config/db.js";
import {
  verifyToken,
  verifyAdmin,
} from "../middlewares/auth.middleware.js";

const router = Router();

router.use(verifyToken, verifyAdmin);

// Get all tuition posts
router.get("/tuitions", async (_req, res, next) => {
  try {
    const { tuitions } = getCollections();

    const result = await tuitions
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

// Approve or reject tuition
router.patch("/tuitions/:id/status", async (req, res, next) => {
  try {
    const id = req.params.id;

    if (!id || !ObjectId.isValid(id)) {
      res.status(400).json({
        success: false,
        message: "Invalid tuition ID",
      });
      return;
    }

    const { status } = req.body;

    if (!["approved", "rejected"].includes(status)) {
      res.status(400).json({
        success: false,
        message: "Status must be approved or rejected",
      });
      return;
    }

    const { tuitions } = getCollections();

    const result = await tuitions.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          status,
          updatedAt: new Date(),
        },
      }
    );

    if (result.matchedCount === 0) {
      res.status(404).json({
        success: false,
        message: "Tuition not found",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: `Tuition ${status} successfully`,
    });
  } catch (error) {
    next(error);
  }
});

// Get all Better Auth users
router.get("/users", async (_req, res, next) => {
  try {
    const result = await getDB()
      .collection("user")
      .find(
        {},
        {
          projection: {
            password: 0,
          },
        }
      )
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

// Get all payments
router.get("/payments", async (_req, res, next) => {
  try {
    const { payments } = getCollections();

    const result = await payments
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
