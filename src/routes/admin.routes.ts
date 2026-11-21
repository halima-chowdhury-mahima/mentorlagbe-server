
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

type RequestBody = Record<string, unknown>;

function getBody(value: unknown): RequestBody {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  ) {
    return value as RequestBody;
  }

  return {};
}

function getId(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

// ==========================================
// GET ALL TUITIONS
// ==========================================
router.get("/tuitions", async (_req, res, next) => {
  try {
    const { tuitions } = getCollections();

    const result = await tuitions
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json({
      success: true,
      total: result.length,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// GET PENDING TUITIONS
// ==========================================
router.get("/tuitions/pending", async (_req, res, next) => {
  try {
    const { tuitions } = getCollections();

    const result = await tuitions
      .find({
        approvalStatus: "pending",
      })
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json({
      success: true,
      total: result.length,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// APPROVE OR REJECT TUITION
// ==========================================
router.patch("/tuitions/:id/status", async (req, res, next) => {
  try {
    const id = getId(req.params.id);
    const body = getBody(req.body);
    const status = body.status;

    if (!id || !ObjectId.isValid(id)) {
      res.status(400).json({
        success: false,
        message: "Invalid tuition ID.",
      });
      return;
    }

    if (status !== "approved" && status !== "rejected") {
      res.status(400).json({
        success: false,
        message: "Status must be approved or rejected.",
      });
      return;
    }

    const { tuitions } = getCollections();

    const result = await tuitions.updateOne(
      {
        _id: new ObjectId(id),
      },
      {
        $set: {
          approvalStatus: status,
          status,
          updatedAt: new Date(),
        },
      }
    );

    if (result.matchedCount === 0) {
      res.status(404).json({
        success: false,
        message: "Tuition not found.",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: `Tuition ${status} successfully.`,
    });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// GET ALL BETTER AUTH USERS
// ==========================================
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
      total: result.length,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// GET ALL PAYMENTS
// ==========================================
router.get("/payments", async (_req, res, next) => {
  try {
    const { payments } = getCollections();

    const result = await payments
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json({
      success: true,
      total: result.length,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// GET ALL APPLICATIONS
// ==========================================
router.get("/applications", async (_req, res, next) => {
  try {
    const { applications } = getCollections();

    const result = await applications
      .find({})
      .sort({ appliedAt: -1 })
      .toArray();

    res.status(200).json({
      success: true,
      total: result.length,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// UPDATE APPLICATION STATUS
// ==========================================
router.patch("/applications/:id/status", async (req, res, next) => {
  try {
    const id = getId(req.params.id);
    const body = getBody(req.body);
    const status = body.status;

    if (!id || !ObjectId.isValid(id)) {
      res.status(400).json({
        success: false,
        message: "Invalid application ID.",
      });
      return;
    }

    const allowedStatuses = [
      "pending",
      "accepted",
      "rejected",
      "cancelled",
    ];

    if (
      typeof status !== "string" ||
      !allowedStatuses.includes(status)
    ) {
      res.status(400).json({
        success: false,
        message: "Invalid application status.",
      });
      return;
    }

    const { applications } = getCollections();

    const result = await applications.updateOne(
      {
        _id: new ObjectId(id),
      },
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
        message: "Application not found.",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Application status updated successfully.",
    });
  } catch (error) {
    next(error);
  }
});

export default router;
