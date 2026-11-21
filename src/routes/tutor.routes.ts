
import { Router } from "express";
import { ObjectId } from "mongodb";

import { getCollections } from "../config/collections.js";
import {
  verifyToken,
  verifyTutor,
} from "../middlewares/auth.middleware.js";

const router = Router();

router.use(verifyToken, verifyTutor);

// ==========================================
// CREATE A NEW TUITION POST
// ==========================================
router.post("/my-tuitions", async (req, res, next) => {
  try {
    const user = res.locals.user as { id: string };
    const { tuitions } = getCollections();

    const body = req.body ?? {};

    // Validate required fields
    if (
      !body.title?.trim() ||
      !body.classLevel ||
      !body.location?.trim() ||
      !body.area?.trim() ||
      !Array.isArray(body.subjects) ||
      body.subjects.length === 0
    ) {
      res.status(400).json({
        success: false,
        message: "Please provide all required tuition information.",
      });
      return;
    }

    const salary = Number(body.salary);

    if (!Number.isFinite(salary) || salary <= 0) {
      res.status(400).json({
        success: false,
        message: "Please provide a valid monthly salary.",
      });
      return;
    }

    const now = new Date();

    const tuitionData = {
      title: String(body.title).trim(),

      subject:
        body.subject ||
        body.subjects.join(", "),

      subjects: body.subjects,

      classLevel: body.classLevel,
      medium: body.medium || "Bangla Medium",
      curriculum: body.curriculum || "NCTB",

      category: body.category || "Home Tuition",
      tuitionType: body.tuitionType || "Home",

      location: String(body.location).trim(),
      area: String(body.area).trim(),

      salary,

      negotiable: body.negotiable === true,

      daysPerWeek: Number(body.daysPerWeek) || 3,
      hoursPerDay: Number(body.hoursPerDay) || 2,

      schedule: body.schedule || "",
      tutoringTime: body.tutoringTime || "Evening",

      studentGender: body.studentGender || "Any",
      tutorGender: body.tutorGender || "Any",

      numberOfStudents: Number(body.numberOfStudents) || 1,

      institution: body.institution || "",
      qualification: body.qualification || "",
      experience: body.experience || "Preferred",

      requirements: body.requirements || "",
      description: body.description || "",

      contactPerson: body.contactPerson || "",
      contactNumber: body.contactNumber || "",

      applicationDeadline: body.applicationDeadline || null,

      tutorId: user.id,

      status: "active",

      createdAt: now,
      updatedAt: now,
    };

    const result = await tuitions.insertOne(tuitionData);

    res.status(201).json({
      success: true,
      message: "Tuition published successfully!",
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
    const user = res.locals.user as { id: string };
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
// GET APPLICANTS FOR A SPECIFIC TUITION
// ==========================================
router.get("/applicants/:tuitionId", async (req, res, next) => {
  try {
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

    const user = res.locals.user as { id: string };
    const { tuitions, applications } = getCollections();

    const tuition = await tuitions.findOne({
      _id: new ObjectId(tuitionId),
      tutorId: user.id,
    });

    if (!tuition) {
      res.status(404).json({
        success: false,
        message: "Tuition not found",
      });
      return;
    }

    const result = await applications
      .find({ tuitionId })
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
// APPROVE OR REJECT AN APPLICANT
// ==========================================
router.patch(
  "/applicants/:applicationId/status",
  async (req, res, next) => {
    try {
      const applicationIdParam = req.params.applicationId;

      const applicationId = Array.isArray(applicationIdParam)
        ? applicationIdParam[0]
        : applicationIdParam;

      const { status } = req.body;

      if (!applicationId || !ObjectId.isValid(applicationId)) {
        res.status(400).json({
          success: false,
          message: "Invalid application ID",
        });
        return;
      }

      if (!["approved", "rejected"].includes(status)) {
        res.status(400).json({
          success: false,
          message: "Status must be approved or rejected",
        });
        return;
      }

      const user = res.locals.user as { id: string };
      const { applications, tuitions } = getCollections();

      const application = await applications.findOne({
        _id: new ObjectId(applicationId),
      });

      if (!application) {
        res.status(404).json({
          success: false,
          message: "Application not found",
        });
        return;
      }

      const tuitionId = application.tuitionId;

      if (!tuitionId || !ObjectId.isValid(String(tuitionId))) {
        res.status(400).json({
          success: false,
          message: "Invalid tuition reference in application",
        });
        return;
      }

      // Ensure this tuition belongs to the logged-in tutor
      const tuition = await tuitions.findOne({
        _id: new ObjectId(String(tuitionId)),
        tutorId: user.id,
      });

      if (!tuition) {
        res.status(403).json({
          success: false,
          message: "You cannot manage this application",
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
        message: `Application ${status} successfully`,
      });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// UPDATE TUTOR'S TUITION
// ==========================================
router.patch("/my-tuitions/:id", async (req, res, next) => {
  try {
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;

    if (!id || !ObjectId.isValid(id)) {
      res.status(400).json({
        success: false,
        message: "Invalid tuition ID",
      });
      return;
    }

    const user = res.locals.user as { id: string };
    const { tuitions } = getCollections();

    const allowedFields = [
      "title",
      "subject",
      "subjects",
      "classLevel",
      "medium",
      "curriculum",
      "category",
      "tuitionType",
      "location",
      "area",
      "salary",
      "negotiable",
      "daysPerWeek",
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
      "description",
      "contactPerson",
      "contactNumber",
      "applicationDeadline",
      "status",
    ];

    const updateData: Record<string, unknown> = {};

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    }

    if (Object.keys(updateData).length === 0) {
      res.status(400).json({
        success: false,
        message: "No valid fields provided for update",
      });
      return;
    }

    updateData.updatedAt = new Date();

    const result = await tuitions.updateOne(
      { _id: new ObjectId(id), tutorId: user.id },
      { $set: updateData }
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
      message: "Tuition updated successfully",
    });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// DELETE TUTOR'S TUITION
// ==========================================
router.delete("/my-tuitions/:id", async (req, res, next) => {
  try {
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;

    if (!id || !ObjectId.isValid(id)) {
      res.status(400).json({
        success: false,
        message: "Invalid tuition ID",
      });
      return;
    }

    const user = res.locals.user as { id: string };
    const { tuitions } = getCollections();

    const result = await tuitions.deleteOne({
      _id: new ObjectId(id),
      tutorId: user.id,
    });

    if (result.deletedCount === 0) {
      res.status(404).json({
        success: false,
        message: "Tuition not found",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Tuition deleted successfully",
    });
  } catch (error) {
    next(error);
  }
});

export default router;
