
import type { ObjectId } from "mongodb";

export interface Tuition {
  _id?: ObjectId;
  tutorId: string;
  tutorName: string;
  title: string;
  subject: string;
  classLevel: string;
  medium: string;
  location: string;
  salary: number;
  schedule: string;
  description: string;
  image: string;
  status: "pending" | "approved" | "rejected";
  createdAt: Date;
  updatedAt: Date;
}
