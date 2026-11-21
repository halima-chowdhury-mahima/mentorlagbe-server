
import { Router } from "express";
import { ObjectId } from "mongodb";

import { getCollections } from "../config/collections.js";
import {
  verifyToken,
  verifyTutor,
} from "../middlewares/auth.middleware.js";

const router = Router();

router.use(verifyToken, verifyTutor);

type TutorUser = {
  id: string;
  name?: string;
  email?: string;
  plan?: string;
};

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

function getString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function getNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    return Number(value);
  }
  return Number.NaN;
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value.filter(
    (item): item is string => typeof item === "string"
  ).map((item) => item.trim()).filter(Boolean);
}

function getId(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

// ==========================================
// CREATE A NEW TUITION POST
// ==========================================
router.post("/my-tuitions", async (req, res, next) => {
  try {
    const user = res.locals.user as TutorUser;
    const body = getBody(req.body);
    const { tuitions } = getCollections();

    const title = getString(body.title);
    const classLevel = getString(body.classLevel);
    const location = getString(body.location);
    const area = getString(body.area);

    const subjects = getStringArray(body.subjects);
    const subject =
      getString(body.subject) ||
      subjects.join(", ");

    const monthlyFee = getNumber(
      body.monthlyFee ?? body.salary
    );

    const requestedMode = getString(body.mode);
    const tuitionType = getString(body.tuitionType);

    const mode =
      requestedMode === "Online" || requestedMode === "Offline"
        ? requestedMode
        : tuitionType === "Online" || tuitionType === "Offline"
          ? tuitionType
          : tuitionType === "Home"
            ? "Offline"
            : "";

    if (
      !title ||
      !classLevel ||
      !location ||
      !subject ||
      !Number.isFinite(monthlyFee) ||
      monthlyFee <= 0 ||
      !mode
    ) {
      res.status(400).json({
        success: false,
        message:
          "Please provide title, subject, class level, location, mode (Online/Offline), and a valid monthly fee.",
      });
      return;
    }

    // Free Tutor: maximum 2 tuition posts.
    // Pro Tutor: unlimited tuition posts.
    if (user.plan?.toLowerCase() !== "pro") {
      const existingCount = await tuitions.countDocuments({
        tutorId: user.id,
      });

      if (existingCount >= 2) {
        res.status(403).json({
          success: false,
          message:
            "Free plan allows a maximum of 2 tuition posts. Upgrade to Pro to post unlimited tuitions.",
          code: "TUITION_LIMIT_REACHED",
        });
        return;
      }
    }

    const now = new Date();

    const daysPerWeek = getNumber(body.daysPerWeek);
    const safeDaysPerWeek =
      Number.isInteger(daysPerWeek) &&
      daysPerWeek >= 1 &&
      daysPerWeek <= 7
        ? daysPerWeek
        : 3;

    const bannerImage =
      getString(body.bannerImage) ||
      getString(body.image);

    const tuitionData = {
      title,
      subject,
      classLevel,

      // Assignment 9 fields
      mode,
      monthlyFee,
      daysPerWeek,
      bannerImage,
      description: getString(body.description),

      location,
      tutorName: user.name || "Tutor",
      tutorEmail: user.email || "",

      approvalStatus: "pending",
      isActive: true,

      // Legacy fields retained for existing frontend compatibility
      subjects: subjects.length > 0 ? subjects : [subject],
      medium: getString(body.medium),
      curriculum: getString(body.curriculum) || "NCTB",
      category: getString(body.category) || "Home Tuition",
      tuitionType: tuitionType || "Home",
      area,

      salary: monthlyFee,
      negotiable: body.negotiable === true,
      hoursPerDay: getNumber(body.hoursPerDay) || 2,
      schedule: getString(body.schedule),
      tutoringTime: getString(body.tutoringTime) || "Evening",

      studentGender: getString(body.studentGender) || "Any",
      tutorGender: getString(body.tutorGender) || "Any",
      numberOfStudents: getNumber(body.numberOfStudents) || 1,

      institution: getString(body.institution),
      qualification: getString(body.qualification),
      experience: getString(body.experience) || "Preferred",
      requirements: getString(body.requirements),

      contactPerson: getString(body.contactPerson),
      contactNumber: getString(body.contactNumber),
      applicationDeadline: body.applicationDeadline || null,

      tutorId: user.id,

      // Legacy status now reflects approval, not active/inactive.
      status: "pending",

      createdAt: now,
      updatedAt: now,
    };

    const result = await tuitions.insertOne(tuitionData);

    res.status(201).json({
      success: true,
      message: "Tuition submitted for admin approval.",
      data: {
        _id: result.insertedId,
        ...tuitionData,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// GET TUTOR'S OWN TUITION POSTS
// ==========================================
router.get("/my-tuitions", async (_req, res, next) => {
  try {
    const user = res.locals.user as TutorUser;
    const { tuitions } = getCollections();

    const result = await tuitions
      .find({ tutorId: user.id })
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

// ==========================================
// TOGGLE TUITION ACTIVE / INACTIVE
// ==========================================
router.patch("/my-tuitions/:id/active", async (req, res, next) => {
  try {
    const user = res.locals.user as TutorUser;
    const id = getId(req.params.id);
    const body = getBody(req.body);

    if (!id || !ObjectId.isValid(id)) {
      res.status(400).json({
        success: false,
        message: "Invalid tuition ID.",
      });
      return;
    }

    if (typeof body.isActive !== "boolean") {
      res.status(400).json({
        success: false,
        message: "isActive must be true or false.",
      });
      return;
    }

    const { tuitions } = getCollections();

    const result = await tuitions.updateOne(
      {
        _id: new ObjectId(id),
        tutorId: user.id,
      },
      {
        $set: {
          isActive: body.isActive,
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
      message: body.isActive
        ? "Tuition activated successfully."
        : "Tuition deactivated successfully.",
    });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// GET APPLICANTS FOR A SPECIFIC TUITION
// ==========================================
router.get("/applicants/:tuitionId", async (req, res, next) => {
  try {
    const user = res.locals.user as TutorUser;
    const tuitionId = getId(req.params.tuitionId);

    if (!tuitionId || !ObjectId.isValid(tuitionId)) {
      res.status(400).json({
        success: false,
        message: "Invalid tuition ID.",
      });
      return;
    }

    const { tuitions, applications } = getCollections();

    const tuition = await tuitions.findOne({
      _id: new ObjectId(tuitionId),
      tutorId: user.id,
    });

    if (!tuition) {
      res.status(404).json({
        success: false,
        message: "Tuition not found.",
      });
      return;
    }

    const result = await applications
      .find({ tuitionId })
      .sort({ appliedAt: -1 })
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
// ACCEPT OR REJECT AN APPLICANT
// ==========================================
router.patch(
  "/applicants/:applicationId/status",
  async (req, res, next) => {
    try {
      const user = res.locals.user as TutorUser;
      const applicationId = getId(req.params.applicationId);
      const body = getBody(req.body);
      const status = getString(body.status).toLowerCase();

      if (!applicationId || !ObjectId.isValid(applicationId)) {
        res.status(400).json({
          success: false,
          message: "Invalid application ID.",
        });
        return;
      }

      if (status !== "accepted" && status !== "rejected") {
        res.status(400).json({
          success: false,
          message: "Status must be accepted or rejected.",
        });
        return;
      }

      const { applications, tuitions } = getCollections();

      const application = await applications.findOne({
        _id: new ObjectId(applicationId),
      });

      if (!application) {
        res.status(404).json({
          success: false,
          message: "Application not found.",
        });
        return;
      }

      const tuitionId = String(application.tuitionId || "");

      if (!ObjectId.isValid(tuitionId)) {
        res.status(400).json({
          success: false,
          message: "Invalid tuition reference in application.",
        });
        return;
      }

      const tuition = await tuitions.findOne({
        _id: new ObjectId(tuitionId),
        tutorId: user.id,
      });

      if (!tuition) {
        res.status(403).json({
          success: false,
          message: "You cannot manage this application.",
        });
        return;
      }

      await applications.updateOne(
        { _id: new ObjectId(applicationId) },
        {
          $set: {
            status,
            updatedAt: new Date(),
          },
        }
      );

      res.status(200).json({
        success: true,
        message: `Application ${status} successfully.`,
      });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// UPDATE TUTOR'S OWN TUITION
// ==========================================
router.patch("/my-tuitions/:id", async (req, res, next) => {
  try {
    const user = res.locals.user as TutorUser;
    const id = getId(req.params.id);
    const body = getBody(req.body);

    if (!id || !ObjectId.isValid(id)) {
      res.status(400).json({
        success: false,
        message: "Invalid tuition ID.",
      });
      return;
    }

    const allowedFields = [
      "title",
      "subject",
      "subjects",
      "classLevel",
      "mode",
      "monthlyFee",
      "daysPerWeek",
      "bannerImage",
      "description",
      "location",
      "area",
      "salary",
      "medium",
      "curriculum",
      "category",
      "tuitionType",
      "negotiable",
      "hoursPerDay",
      "schedule",
      "tutoringTime",
      "studentGender",
      "tutorGender",
      "numberOfStudents",
      "institution",
      "qualification",
      "experience",
      "requirements",
      "contactPerson",
      "contactNumber",
      "applicationDeadline",
    ];

    const updateData: Record<string, unknown> = {};

    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updateData[field] = body[field];
      }
    }

    // Keep the legacy salary field synchronized with monthlyFee.
    if (body.monthlyFee !== undefined) {
      updateData.salary = body.monthlyFee;
    } else if (body.salary !== undefined) {
      updateData.monthlyFee = body.salary;
    }

    if (Object.keys(updateData).length === 0) {
      res.status(400).json({
        success: false,
        message: "No valid fields provided for update.",
      });
      return;
    }

    updateData.updatedAt = new Date();

    const { tuitions } = getCollections();

    const result = await tuitions.updateOne(
      {
        _id: new ObjectId(id),
        tutorId: user.id,
      },
      {
        $set: updateData,
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
      message: "Tuition updated successfully.",
    });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// DELETE TUTOR'S OWN TUITION
// ==========================================
router.delete("/my-tuitions/:id", async (req, res, next) => {
  try {
    const user = res.locals.user as TutorUser;
    const id = getId(req.params.id);

    if (!id || !ObjectId.isValid(id)) {
      res.status(400).json({
        success: false,
        message: "Invalid tuition ID.",
      });
      return;
    }

    const { tuitions } = getCollections();

    const result = await tuitions.deleteOne({
      _id: new ObjectId(id),
      tutorId: user.id,
    });

    if (result.deletedCount === 0) {
      res.status(404).json({
        success: false,
        message: "Tuition not found.",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Tuition deleted successfully.",
    });
  } catch (error) {
    next(error);
  }
});

export default router;
