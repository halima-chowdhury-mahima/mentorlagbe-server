
import { Router } from "express";
import { ObjectId } from "mongodb";

import { getCollections } from "../config/collections.js";
import {
  verifyToken,
  verifyStudent,
} from "../middlewares/auth.middleware.js";

const router = Router();

// POST: Student applies for a tuition
router.post("/", verifyToken, verifyStudent, async (req, res, next) => {
  try {
    const { tuitionId, name, email, phone, message } = req.body;

    if (!tuitionId || !ObjectId.isValid(tuitionId)) {
      res.status(400).json({
        success: false,
        message: "Valid tuition ID is required.",
      });
      return;
    }

    const user = res.locals.user as {
      id: string;
      name: string;
      email: string;
    };

    // Validate student information
    const studentName =
      typeof name === "string" ? name.trim() : user.name?.trim() || "";

    const studentEmail =
      typeof email === "string"
        ? email.trim().toLowerCase()
        : user.email?.trim().toLowerCase() || "";

    const studentPhone =
      typeof phone === "string" ? phone.trim() : "";

    const studentMessage =
      typeof message === "string" ? message.trim() : "";

    if (!studentName) {
      res.status(400).json({
        success: false,
        message: "Please enter your full name.",
      });
      return;
    }

    if (
      !studentEmail ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(studentEmail)
    ) {
      res.status(400).json({
        success: false,
        message: "Please enter a valid email address.",
      });
      return;
    }

    if (!studentPhone || studentPhone.length < 7 || studentPhone.length > 20) {
      res.status(400).json({
        success: false,
        message: "Please enter a valid phone number.",
      });
      return;
    }

    if (studentMessage.length > 1000) {
      res.status(400).json({
        success: false,
        message: "Message cannot exceed 1000 characters.",
      });
      return;
    }

    const { tuitions, applications } = getCollections();

    const tuition = await tuitions.findOne({
      _id: new ObjectId(tuitionId),
      status: "approved",
    });

    if (!tuition) {
      res.status(404).json({
        success: false,
        message: "Tuition not found or not available.",
      });
      return;
    }

    const existingApplication = await applications.findOne({
      tuitionId,
      studentId: user.id,
    });

    if (existingApplication) {
      res.status(409).json({
        success: false,
        message: "You have already applied for this tuition.",
      });
      return;
    }

    const application = {
      tuitionId,
      studentId: user.id,

      // Student contact information
      studentName,
      studentEmail,
      studentPhone,

      tutorId: tuition.tutorId,

      tuitionTitle: tuition.title ?? "Untitled Tuition",
      subject: tuition.subject ?? "Not specified",
      classLevel: tuition.classLevel ?? "Not specified",
      medium: tuition.medium ?? "Not specified",
      location: tuition.location ?? "Not specified",
      salary: tuition.salary ?? 0,
      schedule: tuition.schedule ?? "Not specified",
      image: tuition.image ?? "",

      message: studentMessage,
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await applications.insertOne(application);

    res.status(201).json({
      success: true,
      message: "Your application has been submitted.",
      data: {
        ...application,
        _id: result.insertedId,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET: Student's applications with tuition details
router.get(
  "/my-applications",
  verifyToken,
  verifyStudent,
  async (req, res, next) => {
    try {
      const user = res.locals.user as { id: string };

      const { applications, tuitions } = getCollections();

      const applicationsData = await applications
        .find({ studentId: user.id })
        .sort({ createdAt: -1 })
        .toArray();

      const data = await Promise.all(
        applicationsData.map(async (application) => {
          const tuitionId = String(application.tuitionId);

          const tuition = ObjectId.isValid(tuitionId)
            ? await tuitions.findOne({
                _id: new ObjectId(tuitionId),
              })
            : null;

          const image = application.image || tuition?.image || "";

          const title =
            application.tuitionTitle ||
            tuition?.title ||
            "Tuition Application";

          const subject =
            application.subject ||
            tuition?.subject ||
            "Not specified";

          const classLevel =
            application.classLevel ||
            tuition?.classLevel ||
            "Not specified";

          const medium =
            application.medium ||
            tuition?.medium ||
            "Not specified";

          const location =
            application.location ||
            tuition?.location ||
            "Not specified";

          const salary =
            application.salary ??
            tuition?.salary ??
            0;

          const schedule =
            application.schedule ||
            tuition?.schedule ||
            "Not specified";

          return {
            ...application,
            tuitionTitle: title,
            subject,
            classLevel,
            medium,
            location,
            salary,
            schedule,
            image,

            tuition: tuition
              ? {
                  _id: tuition._id,
                  title,
                  subject,
                  classLevel,
                  medium,
                  location,
                  salary,
                  schedule,
                  image,
                }
              : {
                  title,
                  subject,
                  classLevel,
                  medium,
                  location,
                  salary,
                  schedule,
                  image,
                },
          };
        }),
      );

      res.status(200).json({
        success: true,
        total: data.length,
        data,
      });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
