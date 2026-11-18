
import { Router } from "express";
import { ObjectId } from "mongodb";

import { getCollections } from "../config/collections.js";
import { verifyToken, verifyTutor } from "../middlewares/auth.middleware.js";

const router = Router();

// GET: Browse approved tuitions with search, filters and pagination
router.get("/", async (req, res, next) => {
  try {
    const { tuitions } = getCollections();

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 10));
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = {
      status: "approved",
    };

    if (req.query.search) {
      const search = String(req.query.search);
      filter.$or = [
        { title: { $regex: search, $options: "i" } },
        { subject: { $regex: search, $options: "i" } },
        { location: { $regex: search, $options: "i" } },
      ];
    }

    if (req.query.subject) {
      filter.subject = String(req.query.subject);
    }

    if (req.query.classLevel) {
      filter.classLevel = String(req.query.classLevel);
    }

    if (req.query.medium) {
      filter.medium = String(req.query.medium);
    }

    const [data, total] = await Promise.all([
      tuitions.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
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

// GET: Single tuition details
router.get("/:id", async (req, res, next) => {
  try {
    const { tuitions } = getCollections();
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
      res.status(400).json({ success: false, message: "Invalid tuition ID" });
      return;
    }

    const tuition = await tuitions.findOne({
      _id: new ObjectId(id),
      status: "approved",
    });

    if (!tuition) {
      res.status(404).json({ success: false, message: "Tuition not found" });
      return;
    }

    res.status(200).json({ success: true, data: tuition });
  } catch (error) {
    next(error);
  }
});

// POST: Tutor creates a tuition
router.post("/", verifyToken, verifyTutor, async (req, res, next) => {
  try {
    const {
      title,
      subject,
      classLevel,
      medium,
      location,
      salary,
      schedule,
      description,
      image,
    } = req.body;

    if (
      !title || !subject || !classLevel || !medium ||
      !location || !salary || !schedule || !description
    ) {
      res.status(400).json({
        success: false,
        message: "Please provide all required tuition information.",
      });
      return;
    }

    const salaryAmount = Number(salary);

    if (!Number.isFinite(salaryAmount) || salaryAmount <= 0) {
      res.status(400).json({
        success: false,
        message: "Please provide a valid salary.",
      });
      return;
    }

    const user = res.locals.user as { id: string; name: string };

    const tuition = {
      tutorId: user.id,
      tutorName: user.name,
      title: String(title).trim(),
      subject: String(subject).trim(),
      classLevel: String(classLevel).trim(),
      medium: String(medium).trim(),
      location: String(location).trim(),
      salary: salaryAmount,
      schedule: String(schedule).trim(),
      description: String(description).trim(),
      image: typeof image === "string" ? image : "",
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const { tuitions } = getCollections();
    const result = await tuitions.insertOne(tuition);

    res.status(201).json({
      success: true,
      message: "Tuition submitted for admin approval.",
      data: { ...tuition, _id: result.insertedId },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
